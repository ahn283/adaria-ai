import { ExternalApiError, RateLimitError } from "../utils/errors.js";
import { info as logInfo, warn as logWarn } from "../utils/logger.js";
import type {
  FridgifyCascadeResult,
  FridgifyPeriod,
  FridgifyPopularMetric,
  FridgifyRecipe,
} from "../types/collectors.js";

/**
 * Fridgify Recipes API collector.
 *
 * Thin wrapper around the Fridgify backend's public recipe endpoints that
 * power the growth agent's recipe-aware blog posts.
 *
 * - Base URL: `https://fridgify-api.eodin.app`
 * - Auth: none (public endpoints, IP rate-limited 20 req/min)
 */
export interface FridgifyRecipesCollectorOptions {
  /** Override the rate-limit backoff window. Defaults to 60 s. */
  retryDelayMs?: number;
}

/**
 * Test-only overrides. `baseUrl` stays off the production options type so
 * config loaders cannot introduce a user-controlled URL into the SSRF
 * surface; the allowlist still applies to test-hook values.
 */
export interface FridgifyRecipesCollectorTestHooks {
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://fridgify-api.eodin.app";
const DEFAULT_RETRY_DELAY_MS = 60_000;
const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "fridgify-api.eodin.app",
]);
const CASCADE_PERIODS: readonly FridgifyPeriod[] = [
  "week",
  "month",
  "quarter",
  "year",
];

export interface GetPopularOptions {
  period?: FridgifyPeriod;
  metric?: FridgifyPopularMetric;
  /** Server clamps to 1–50. */
  limit?: number;
}

export interface CascadeOptions {
  metric?: FridgifyPopularMetric;
  limit?: number;
  /** Narrowest window is accepted once `rows.length >= minResults`. */
  minResults?: number;
}

type QueryValue = string | number | boolean;

export class FridgifyRecipesCollector {
  private readonly baseUrl: string;
  private readonly retryDelayMs: number;

  constructor(
    options: FridgifyRecipesCollectorOptions = {},
    testHooks?: FridgifyRecipesCollectorTestHooks
  ) {
    this.baseUrl = testHooks?.baseUrl ?? DEFAULT_BASE_URL;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  private async fetchOnce(url: string): Promise<Response> {
    return fetch(url, {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async request<T>(
    path: string,
    params: Record<string, QueryValue | undefined> = {}
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);

    if (!ALLOWED_HOSTS.has(url.hostname)) {
      throw new Error(
        `Untrusted Fridgify host: ${url.hostname}. Allowed: ${[...ALLOWED_HOSTS].join(", ")}`
      );
    }

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    const target = url.toString();
    let response = await this.fetchOnce(target);

    // The endpoint is capped at 20 req/min per IP. Retry exactly once after
    // the configured backoff so scheduled weekly runs can ride through a
    // bursty neighbor on the shared IP. Retrying more aggressively would
    // just waste the budget.
    if (response.status === 429) {
      logWarn(
        `[fridgify-recipes] 429 on ${path}; waiting ${String(this.retryDelayMs)}ms before one retry`
      );
      await new Promise<void>((resolve) =>
        setTimeout(resolve, this.retryDelayMs)
      );
      response = await this.fetchOnce(target);
    }

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 429) {
        throw new RateLimitError(
          `Fridgify API still rate limited after 1 retry: ${body.slice(0, 512)}`,
          { retryAfterSeconds: Math.ceil(this.retryDelayMs / 1000) }
        );
      }
      throw new ExternalApiError(
        `Fridgify API ${String(response.status)}: ${body.slice(0, 512)}`,
        { statusCode: response.status }
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Top recipes in a time window, ranked by engagement.
   */
  async getPopular(options: GetPopularOptions = {}): Promise<FridgifyRecipe[]> {
    const period = options.period ?? "week";
    const metric = options.metric ?? "combined";
    const limit = options.limit ?? 10;

    const data = await this.request<unknown>("/recipes/popular", {
      period,
      metric,
      limit,
    });
    return Array.isArray(data) ? (data as FridgifyRecipe[]) : [];
  }

  /**
   * Period-cascade variant of {@link getPopular}.
   *
   * Fridgify's `week` window is frequently empty under current traffic.
   * Walk week → month → quarter → year and stop at the narrowest window
   * that yields at least `minResults` rows, so blog copy naturally stays
   * fresh ("Top recipes this week") without the skill giving up when the
   * week is quiet.
   *
   * Callers that need a roundup-worthy result should branch on
   * {@link FridgifyCascadeResult.satisfied}, not on `rows.length > 0`, to
   * avoid building a "top recipes this year" post from a single stray row.
   */
  async getPopularWithCascade(
    options: CascadeOptions = {}
  ): Promise<FridgifyCascadeResult> {
    const metric = options.metric ?? "combined";
    const limit = options.limit ?? 10;
    const minResults = options.minResults ?? 5;

    let lastRows: FridgifyRecipe[] = [];

    for (const period of CASCADE_PERIODS) {
      const rows = await this.getPopular({ period, metric, limit });
      lastRows = rows;
      if (rows.length >= minResults) {
        logInfo(
          `[fridgify-recipes] cascade stopped at period=${period} (${String(rows.length)} rows)`
        );
        return { period, rows, satisfied: true };
      }
    }

    const finalPeriod =
      CASCADE_PERIODS[CASCADE_PERIODS.length - 1] ?? "year";
    logWarn(
      `[fridgify-recipes] cascade exhausted — no window had >=${String(minResults)} rows (last=${String(lastRows.length)})`
    );
    return { period: finalPeriod, rows: lastRows, satisfied: false };
  }

  /**
   * Fetch a single recipe by id. Returns the same shape as items in
   * {@link getPopular} minus `periodScore`.
   */
  async getRecipe(id: string): Promise<FridgifyRecipe> {
    if (id.length === 0) {
      throw new Error(
        "FridgifyRecipesCollector.getRecipe requires a non-empty string id"
      );
    }
    return this.request<FridgifyRecipe>(
      `/recipes/${encodeURIComponent(id)}`
    );
  }
}
