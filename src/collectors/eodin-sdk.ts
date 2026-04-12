import { ExternalApiError } from "../utils/errors.js";
import type {
  EodinCohort,
  EodinFunnelData,
  EodinSummaryRow,
} from "../types/collectors.js";

/**
 * Eodin Analytics API collector.
 *
 * Wraps `https://api.eodin.app/api/v1/events` — read-only endpoints exposing
 * daily summaries, funnels, and cohort retention for each registered app.
 *
 * Auth: X-API-Key header (not `Authorization: Bearer`).
 */
export interface EodinSdkCollectorOptions {
  apiKey: string;
}

/**
 * Test-only overrides. Kept off {@link EodinSdkCollectorOptions} so that
 * production config loaders (M3) cannot feed a user-controlled base URL into
 * the SSRF surface. The SSRF allowlist check still applies to the override —
 * defense in depth.
 */
export interface EodinSdkCollectorTestHooks {
  baseUrl?: string;
}

const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["api.eodin.app"]);
const DEFAULT_BASE_URL = "https://api.eodin.app/api/v1/events";
const ERROR_BODY_MAX_CHARS = 512;

export interface EodinSummaryOptions {
  /** Aggregation window. Defaults to `daily`. */
  granularity?: "daily" | "weekly" | "monthly";
  /** Platform filter. Defaults to `all`. */
  os?: "ios" | "android" | "all";
}

export interface EodinFunnelOptions {
  source?: string;
  os?: "ios" | "android" | "all";
}

export interface EodinCohortOptions {
  granularity?: "daily" | "weekly" | "monthly";
  os?: "ios" | "android" | "all";
}

interface EodinSummaryResponse {
  data?: EodinSummaryRow[];
}

interface EodinFunnelResponse {
  data?: EodinFunnelData;
}

interface EodinCohortResponse {
  data?: {
    cohorts?: EodinCohort[];
  };
}

type QueryValue = string | number | boolean;
type QueryParams = Record<string, QueryValue | undefined>;

export class EodinSdkCollector {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private loggedPercentCohort = false;

  constructor(
    options: EodinSdkCollectorOptions,
    testHooks?: EodinSdkCollectorTestHooks
  ) {
    if (!options.apiKey) {
      throw new Error("EodinSdkCollector requires apiKey");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = testHooks?.baseUrl ?? DEFAULT_BASE_URL;
  }

  private async request<T>(path: string, params: QueryParams = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);

    if (!ALLOWED_HOSTS.has(url.hostname)) {
      throw new Error(
        `Untrusted SDK host: ${url.hostname}. Allowed: ${[...ALLOWED_HOSTS].join(", ")}`
      );
    }

    for (const [key, value] of Object.entries(params)) {
      // `null` is a defensive check for loose callers even though QueryParams
      // doesn't declare it — leave both branches in.
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    const response = await fetch(url.toString(), {
      headers: {
        "X-API-Key": this.apiKey,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const rawBody = await response.text();
      // The Eodin server has historically echoed the submitted API key back
      // in error bodies (`{"error":"Invalid X-API-Key: <key>"}`). Redact
      // before the message reaches audit logs or Slack error cards.
      const redacted = rawBody
        .replaceAll(this.apiKey, "[REDACTED]")
        .slice(0, ERROR_BODY_MAX_CHARS);
      throw new ExternalApiError(
        `Eodin SDK API ${String(response.status)}: ${redacted}`,
        { statusCode: response.status }
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Daily/weekly/monthly aggregate rows.
   */
  async getSummary(
    appId: string,
    startDate: string,
    endDate: string,
    options: EodinSummaryOptions = {}
  ): Promise<EodinSummaryRow[]> {
    const res = await this.request<EodinSummaryResponse>("/summary", {
      app_id: appId,
      start: startDate,
      end: endDate,
      granularity: options.granularity ?? "daily",
      os: options.os ?? "all",
    });
    return res.data ?? [];
  }

  /**
   * Aggregate funnel for the period. Step order is fixed by the Eodin API:
   * `app_install → app_open → core_action → paywall_view → subscribe_start`.
   */
  async getFunnel(
    appId: string,
    startDate: string,
    endDate: string,
    options: EodinFunnelOptions = {}
  ): Promise<EodinFunnelData> {
    const res = await this.request<EodinFunnelResponse>("/funnel", {
      app_id: appId,
      start: startDate,
      end: endDate,
      source: options.source,
      os: options.os ?? "all",
    });
    return res.data ?? { funnel: [], overall_conversion: 0 };
  }

  /**
   * Cohort retention. `retention[0]` is always the cohort anchor (100% of
   * the cohort by definition), so any value above 1.5 signals the server
   * returned percents instead of fractions; we detect and normalize so
   * every downstream consumer sees fractions in [0, 1].
   */
  async getCohort(
    appId: string,
    startDate: string,
    endDate: string,
    options: EodinCohortOptions = {}
  ): Promise<EodinCohort[]> {
    const res = await this.request<EodinCohortResponse>("/cohort", {
      app_id: appId,
      start: startDate,
      end: endDate,
      granularity: options.granularity ?? "weekly",
      os: options.os ?? "all",
    });
    const cohorts = res.data?.cohorts ?? [];
    return cohorts.map((c) => ({
      ...c,
      retention: this.normalizeRetention(c.retention),
    }));
  }

  private normalizeRetention(retention: number[]): number[] {
    // Wire is typed as number[] but the Eodin server has historically
    // returned nulls/strings inside the array, so the typeof guards below
    // are intentional runtime defense — not dead code the strict types
    // would otherwise suggest.
    if (!Array.isArray(retention) || retention.length === 0) {
      return retention;
    }
    const first = retention[0];
    if (typeof first !== "number" || first <= 1.5) {
      return retention;
    }

    if (!this.loggedPercentCohort) {
      console.warn(
        "[eodin-sdk] Detected percent-encoded cohort retention; normalizing to fractions."
      );
      this.loggedPercentCohort = true;
    }
    return retention.map((r) => (typeof r === "number" ? r / 100 : r));
  }
}
