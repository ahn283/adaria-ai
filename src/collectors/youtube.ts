import { ExternalApiError } from "../utils/errors.js";
import type { YouTubeVideoStats } from "../types/collectors.js";

/**
 * YouTube Data API v3 client for collecting Shorts performance metrics.
 *
 * Used by `ShortFormSkill` (M5) to pull recent Shorts from a channel and
 * fetch their view / like / comment counts so the weekly briefing can
 * show week-over-week changes.
 *
 * @see https://developers.google.com/youtube/v3
 */
export interface YouTubeCollectorOptions {
  apiKey: string;
}

/**
 * Test-only overrides. `baseUrl` is intentionally kept off
 * {@link YouTubeCollectorOptions} so production config loaders cannot
 * override Google's API host; the allowlist still gates any test-hook
 * value as defense-in-depth.
 */
export interface YouTubeCollectorTestHooks {
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://www.googleapis.com/youtube/v3";
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["www.googleapis.com"]);

export class YouTubeCollector {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(
    options: YouTubeCollectorOptions,
    testHooks?: YouTubeCollectorTestHooks
  ) {
    if (!options.apiKey) {
      throw new Error("YouTubeCollector requires apiKey");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = testHooks?.baseUrl ?? DEFAULT_BASE_URL;
  }

  private redact(text: string): string {
    return text.replaceAll(this.apiKey, "[REDACTED]");
  }

  private async fetchJson<T>(url: URL): Promise<T> {
    if (!ALLOWED_HOSTS.has(url.hostname)) {
      throw new Error(
        `Untrusted YouTube host: ${url.hostname}. Allowed: ${[...ALLOWED_HOSTS].join(", ")}`
      );
    }

    let response: Response;
    try {
      response = await fetch(url.toString());
    } catch (err) {
      // Redact the key from any message undici or a polyfill may have
      // inlined — error.cause / stack traces can carry the full URL
      // including `?key=…` for DNS / TLS / TypeError failures.
      const raw = err instanceof Error ? err.message : String(err);
      throw new ExternalApiError(
        `YouTube API fetch failed: ${this.redact(raw).slice(0, 512)}`
      );
    }

    if (!response.ok) {
      const rawBody = await response.text();
      // Google echoes the API key back in error envelopes. Redact before
      // the message reaches audit logs or Slack cards.
      throw new ExternalApiError(
        `YouTube API ${String(response.status)}: ${this.redact(rawBody).slice(0, 512)}`,
        { statusCode: response.status }
      );
    }
    return (await response.json()) as T;
  }

  /**
   * Get recent Shorts videos from a channel.
   *
   * YouTube's `videoDuration=short` search filter returns clips under
   * **4 minutes** (not 60 seconds). We cross-check the content-details
   * duration against `maxDurationSeconds` (default 60) so callers get a
   * correct "Shorts" bucket by default. Pass a larger value (e.g. 180)
   * if you want YouTube's looser "short-form" definition.
   */
  async getRecentShorts(
    channelId: string,
    maxResults = 10,
    maxDurationSeconds = 60
  ): Promise<YouTubeVideoStats[]> {
    if (!channelId) return [];

    const searchUrl = new URL(`${this.baseUrl}/search`);
    searchUrl.searchParams.set("part", "id,snippet");
    searchUrl.searchParams.set("channelId", channelId);
    searchUrl.searchParams.set("type", "video");
    searchUrl.searchParams.set("videoDuration", "short");
    searchUrl.searchParams.set("order", "date");
    searchUrl.searchParams.set("maxResults", String(maxResults));
    searchUrl.searchParams.set("key", this.apiKey);

    interface SearchResponse {
      items?: { id: { videoId?: string } }[];
    }
    const data = await this.fetchJson<SearchResponse>(searchUrl);
    const videoIds = (data.items ?? [])
      .map((item) => item.id.videoId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    if (videoIds.length === 0) return [];
    const stats = await this.getVideoStats(videoIds);
    return stats.filter(
      (v) => parseIsoDurationSeconds(v.duration) <= maxDurationSeconds
    );
  }

  /**
   * Get statistics for specific video IDs.
   */
  async getVideoStats(videoIds: string[]): Promise<YouTubeVideoStats[]> {
    if (videoIds.length === 0) return [];

    const url = new URL(`${this.baseUrl}/videos`);
    url.searchParams.set("part", "snippet,statistics,contentDetails");
    url.searchParams.set("id", videoIds.join(","));
    url.searchParams.set("key", this.apiKey);

    interface VideoItem {
      id: string;
      snippet?: { title?: string; publishedAt?: string };
      statistics?: {
        viewCount?: string;
        likeCount?: string;
        commentCount?: string;
      };
      contentDetails?: { duration?: string };
    }
    interface VideosResponse {
      items?: VideoItem[];
    }

    const data = await this.fetchJson<VideosResponse>(url);

    return (data.items ?? []).map((item) => ({
      videoId: item.id,
      title: item.snippet?.title ?? "",
      publishedAt: item.snippet?.publishedAt ?? null,
      views: Number.parseInt(item.statistics?.viewCount ?? "0", 10),
      likes: Number.parseInt(item.statistics?.likeCount ?? "0", 10),
      comments: Number.parseInt(item.statistics?.commentCount ?? "0", 10),
      duration: item.contentDetails?.duration ?? null,
    }));
  }
}

/**
 * Parse an ISO 8601 duration like `PT1M30S` to seconds. Any unrecognized
 * shape (including `null`, empty string, or strings containing hours via
 * `PT…H…`) returns `Number.POSITIVE_INFINITY` so that the shorts filter
 * treats the clip as *too long* rather than silently accepting it.
 */
function parseIsoDurationSeconds(duration: string | null): number {
  if (!duration) return Number.POSITIVE_INFINITY;
  const match = /^PT(?:(\d+)M)?(?:(\d+)S)?$/.exec(duration);
  if (!match) return Number.POSITIVE_INFINITY;
  const minutes = Number.parseInt(match[1] ?? "0", 10);
  const seconds = Number.parseInt(match[2] ?? "0", 10);
  return minutes * 60 + seconds;
}
