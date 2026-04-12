import { ExternalApiError, RateLimitError } from "../utils/errors.js";
import { parseRetryAfter } from "../utils/retry.js";
import type {
  AsoCompetitorInfo,
  AsoKeywordRanking,
  AsoKeywordSuggestion,
} from "../types/collectors.js";

/**
 * ASOMobile API collector.
 * Fetches keyword rankings, search volumes, and competition data.
 *
 * @see https://asomobile.net
 */
export interface AsoMobileCollectorOptions {
  apiKey: string;
}

/**
 * Test-only overrides. Kept off {@link AsoMobileCollectorOptions} so that
 * production config loaders cannot feed a user-controlled base URL.
 */
export interface AsoMobileCollectorTestHooks {
  baseUrl?: string;
}

export type AsoPlatform = "ios" | "android";

const DEFAULT_BASE_URL = "https://api.asomobile.net/v2";
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["api.asomobile.net"]);

type QueryValue = string | number | boolean;
type QueryParams = Record<string, QueryValue | undefined>;

interface AsoRankingsResponse {
  results?: {
    keyword: string;
    rank?: number | null;
    search_volume?: number;
    competition?: number | null;
  }[];
}

interface AsoSuggestionsResponse {
  suggestions?: {
    keyword: string;
    search_volume?: number;
    competition?: number | null;
  }[];
}

interface AsoCompetitorResponse {
  title?: string;
  subtitle?: string;
  description?: string;
  keywords?: string[];
}

export class AsoMobileCollector {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(
    options: AsoMobileCollectorOptions,
    testHooks?: AsoMobileCollectorTestHooks
  ) {
    if (!options.apiKey) {
      throw new Error("AsoMobileCollector requires apiKey");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = testHooks?.baseUrl ?? DEFAULT_BASE_URL;
  }

  private async request<T>(path: string, params: QueryParams = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);

    if (!ALLOWED_HOSTS.has(url.hostname)) {
      throw new Error(
        `Untrusted ASOMobile host: ${url.hostname}. Allowed: ${[...ALLOWED_HOSTS].join(", ")}`
      );
    }

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    const response = await fetch(url.toString(), {
      headers: { "X-API-Key": this.apiKey },
    });

    if (response.status === 429) {
      throw new RateLimitError("ASOMobile API rate limited", {
        retryAfterSeconds: parseRetryAfter(
          response.headers.get("Retry-After")
        ),
      });
    }

    if (!response.ok) {
      const body = await response.text();
      throw new ExternalApiError(
        `ASOMobile API ${String(response.status)}: ${body}`,
        { statusCode: response.status }
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Get keyword rankings for an app.
   */
  async getKeywordRankings(
    appId: string,
    platform: AsoPlatform,
    keywords: string[]
  ): Promise<AsoKeywordRanking[]> {
    if (keywords.length === 0) return [];

    const data = await this.request<AsoRankingsResponse>(
      "/keywords/rankings",
      {
        app_id: appId,
        platform,
        keywords: keywords.join(","),
      }
    );

    return (data.results ?? []).map((r) => ({
      keyword: r.keyword,
      rank: r.rank ?? null,
      searchVolume: r.search_volume ?? 0,
      competition: r.competition ?? null,
    }));
  }

  /**
   * Get keyword suggestions (high volume + low competition).
   */
  async getKeywordSuggestions(
    appId: string,
    platform: AsoPlatform,
    locale = "ko"
  ): Promise<AsoKeywordSuggestion[]> {
    const data = await this.request<AsoSuggestionsResponse>(
      "/keywords/suggestions",
      {
        app_id: appId,
        platform,
        locale,
      }
    );

    return (data.suggestions ?? []).map((s) => ({
      keyword: s.keyword,
      searchVolume: s.search_volume ?? 0,
      competition: s.competition ?? null,
    }));
  }

  /**
   * Get competitor metadata.
   */
  async getCompetitorInfo(
    competitorId: string,
    platform: AsoPlatform
  ): Promise<AsoCompetitorInfo> {
    const data = await this.request<AsoCompetitorResponse>("/app/info", {
      app_id: competitorId,
      platform,
    });

    return {
      title: data.title ?? "",
      subtitle: data.subtitle ?? "",
      description: data.description ?? "",
      keywords: data.keywords ?? [],
    };
  }
}
