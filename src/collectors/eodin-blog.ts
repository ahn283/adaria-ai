import { ExternalApiError } from "../utils/errors.js";
import { warn as logWarn } from "../utils/logger.js";
import type {
  BlogListOptions,
  BlogListResponse,
  BlogPostDraft,
  BlogPostUpdate,
} from "../types/collectors.js";

/**
 * Eodin Blog + SEO + Analytics API clients.
 *
 * Replaces the legacy GitHub Contents API approach with direct M2M API
 * calls against the eodin.app growth endpoints. Three thin clients share
 * the same auth header (`Authorization: Bearer <GROWTH_AGENT_TOKEN>`) and
 * the same SSRF allowlist, so they inherit from a common base.
 *
 * Write operations on {@link EodinBlogPublisher} (create / update /
 * publish / delete) are allowed through approval-gated skill paths only;
 * the collector itself is agnostic and will happily POST if called.
 *
 * @see src/agent/safety.ts — `blog_publish` ApprovalManager gate wraps
 *      every `publish` call site in M5+ skills.
 */
export interface EodinBlogConfig {
  baseUrl: string;
  token: string;
}

/**
 * Test-only overrides. SSRF allowlist is derived from the config baseUrl
 * hostname — defense in depth against path-traversal attacks.
 */
export interface EodinBlogTestHooks {
  baseUrl?: string;
}

const ERROR_BODY_MAX_CHARS = 512;

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

abstract class EodinGrowthClient {
  protected readonly token: string;
  protected readonly baseUrl: string;
  private readonly allowedHost: string;

  constructor(config: EodinBlogConfig, testHooks?: EodinBlogTestHooks) {
    if (!config.baseUrl) {
      throw new Error(
        "Eodin growth clients require baseUrl (config.collectors.eodinGrowth.baseUrl)"
      );
    }
    if (!config.token) {
      throw new Error(
        "Eodin growth clients require a GROWTH_AGENT_TOKEN config.token"
      );
    }
    this.token = config.token;
    this.baseUrl = testHooks?.baseUrl ?? config.baseUrl;
    this.allowedHost = new URL(config.baseUrl).hostname;
  }

  protected async request<T>(
    method: HttpMethod,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);

    if (url.hostname !== this.allowedHost) {
      throw new Error(
        `Untrusted Eodin host: ${url.hostname}. Allowed: ${this.allowedHost}`
      );
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };

    const init: RequestInit = { method, headers };
    if (body !== undefined && body !== null && method !== "GET") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url.toString(), init);

    if (!response.ok) {
      const rawBody = await response.text();
      // Redact the bearer token in case the server echoes it back in an
      // error envelope. 4xx from Eodin's auth middleware has historically
      // included the raw token in dev.
      const redacted = rawBody
        .replaceAll(this.token, "[REDACTED]")
        .slice(0, ERROR_BODY_MAX_CHARS);
      throw new ExternalApiError(
        `Eodin Growth API ${String(response.status)}: ${redacted}`,
        { statusCode: response.status }
      );
    }

    return (await response.json()) as T;
  }
}

// ---------------------------------------------------------------------------
// Blog publisher (write paths — approval-gated in M5)
// ---------------------------------------------------------------------------

export class EodinBlogPublisher extends EodinGrowthClient {
  /**
   * Create a blog post as DRAFT. The skill layer is responsible for
   * obtaining human approval before calling {@link publish}.
   */
  async create(post: BlogPostDraft): Promise<unknown> {
    return this.request<unknown>("POST", "/blogs", {
      slug: post.slug,
      title: post.title,
      description: post.description,
      category: post.category,
      content: post.content,
      thumbnail: post.thumbnail,
      readTime: post.readTime,
    });
  }

  /**
   * Partial update of an existing blog post by slug.
   */
  async update(slug: string, updates: BlogPostUpdate): Promise<unknown> {
    if (Object.keys(updates).length === 0) {
      throw new Error(
        "EodinBlogPublisher.update: updates object must not be empty"
      );
    }
    return this.request<unknown>(
      "PUT",
      `/blogs/${encodeURIComponent(slug)}`,
      updates
    );
  }

  /**
   * Publish a blog post (DRAFT → PUBLISHED). Triggers FAQ auto-generation
   * and ISR revalidation on eodin.app. Always approval-gated from M5.
   */
  async publish(slug: string): Promise<unknown> {
    return this.request<unknown>(
      "PUT",
      `/blogs/${encodeURIComponent(slug)}/publish`,
      { status: "PUBLISHED" }
    );
  }

  async get(slug: string): Promise<unknown> {
    return this.request<unknown>(
      "GET",
      `/blogs/${encodeURIComponent(slug)}`
    );
  }

  async list(options: BlogListOptions = {}): Promise<BlogListResponse> {
    const params = new URLSearchParams();
    if (options.status !== undefined) params.set("status", options.status);
    if (options.category !== undefined)
      params.set("category", options.category);
    if (options.page !== undefined) params.set("page", String(options.page));
    if (options.limit !== undefined)
      params.set("limit", String(options.limit));
    const query = params.toString();
    return this.request<BlogListResponse>(
      "GET",
      query ? `/blogs?${query}` : "/blogs"
    );
  }

  /**
   * Convenience wrapper: returns the slugs of every listed post, or an
   * empty array on any failure. Used for duplicate-slug prevention where
   * "API unavailable" should degrade gracefully to "assume no conflict".
   */
  async listSlugs(): Promise<string[]> {
    try {
      const result = await this.list({ limit: 100 });
      const total = result.pagination?.total;
      if (typeof total === "number" && total > 100) {
        logWarn(
          `[eodin-blog] listSlugs truncated — ${String(total)} total posts, only first 100 slugs fetched`
        );
      }
      return result.data.map((post) => post.slug);
    } catch (err) {
      logWarn("[eodin-blog] listSlugs failed — assuming no slug conflict", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  async delete(slug: string): Promise<unknown> {
    return this.request<unknown>(
      "DELETE",
      `/blogs/${encodeURIComponent(slug)}`
    );
  }
}

// ---------------------------------------------------------------------------
// SEO (Search Console) metrics client — read-only
// ---------------------------------------------------------------------------

export class EodinSeoMetrics extends EodinGrowthClient {
  async getOverview(startDate: string, endDate: string): Promise<unknown> {
    return this.request<unknown>(
      "GET",
      `/metrics/seo/overview?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`
    );
  }

  async getKeywords(
    startDate: string,
    endDate: string,
    limit = 25
  ): Promise<unknown> {
    return this.request<unknown>(
      "GET",
      `/metrics/seo/keywords?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&limit=${String(limit)}`
    );
  }

  async getPages(
    startDate: string,
    endDate: string,
    limit = 25
  ): Promise<unknown> {
    return this.request<unknown>(
      "GET",
      `/metrics/seo/pages?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&limit=${String(limit)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Analytics (GA4) client — read-only
// ---------------------------------------------------------------------------

export class EodinAnalytics extends EodinGrowthClient {
  async getTraffic(startDate: string, endDate: string): Promise<unknown> {
    return this.request<unknown>(
      "GET",
      `/metrics/analytics/traffic?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`
    );
  }

  async getPages(startDate: string, endDate: string): Promise<unknown> {
    return this.request<unknown>(
      "GET",
      `/metrics/analytics/pages?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`
    );
  }

  async getSources(startDate: string, endDate: string): Promise<unknown> {
    return this.request<unknown>(
      "GET",
      `/metrics/analytics/sources?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`
    );
  }

  async getRealtime(): Promise<unknown> {
    return this.request<unknown>("GET", "/metrics/analytics/realtime");
  }
}

// ---------------------------------------------------------------------------
// Markdown → HTML helpers (used by SeoBlogSkill when preparing drafts)
// ---------------------------------------------------------------------------

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

const SAFE_URL_SCHEME = /^(?:https?:|mailto:|\/|#)/i;

/**
 * Normalize a link URL so Markdown cannot smuggle `javascript:` or other
 * dangerous schemes into the rendered `<a href>`. Allowed: http, https,
 * mailto, absolute (`/…`), and fragments (`#…`). Everything else becomes
 * `#`. The result is HTML-escaped for attribute safety.
 */
function safeHref(url: string): string {
  const trimmed = url.trim();
  if (SAFE_URL_SCHEME.test(trimmed)) {
    return escapeHtml(trimmed);
  }
  return "#";
}

function inlineReplacements(text: string): string {
  // HTML escape first so the markdown tokens we reintroduce below are the
  // only raw HTML in the final output. `inlineReplacements` is called with
  // attacker-controllable text (competitor descriptions, Claude-generated
  // body copy), and the Eodin blog backend does not re-sanitize on POST.
  const escaped = escapeHtml(text);
  return escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(
      /\[(.+?)\]\((.+?)\)/g,
      (_match, label: string, url: string) =>
        `<a href="${safeHref(url)}">${label}</a>`
    );
}

/**
 * Convert markdown to basic HTML.
 *
 * Handles: h1-h3, paragraphs, bold, italic, links, unordered lists. The
 * conversion is intentionally minimal — the Eodin blog backend accepts
 * arbitrary HTML, but we keep the surface small so {@link EodinBlogPublisher}
 * callers can predict the exact markup that will land in a draft post.
 *
 * Security: all block-level text flows through {@link inlineReplacements},
 * which HTML-escapes and scheme-whitelists links. See SeoBlogSkill path in
 * M4+ — competitor descriptions and upstream-generated copy reach this
 * function without further sanitization.
 */
export function markdownToHtml(md: string): string {
  return md
    .split("\n\n")
    .map((rawBlock) => {
      const block = rawBlock.trim();
      if (!block) return "";

      if (block.startsWith("### ")) {
        return `<h3>${inlineReplacements(block.slice(4))}</h3>`;
      }
      if (block.startsWith("## ")) {
        return `<h2>${inlineReplacements(block.slice(3))}</h2>`;
      }
      if (block.startsWith("# ")) {
        return `<h1>${inlineReplacements(block.slice(2))}</h1>`;
      }

      if (/^[-*] /m.test(block)) {
        const items = block
          .split("\n")
          .filter((l) => /^[-*] /.test(l))
          .map((l) => `<li>${inlineReplacements(l.replace(/^[-*] /, ""))}</li>`);
        return `<ul>${items.join("")}</ul>`;
      }

      return `<p>${inlineReplacements(block.replace(/\n/g, " "))}</p>`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Estimate read time from content (200 wpm). Always at least "1 min read".
 */
export function estimateReadTime(text: string): string {
  const words = text.split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.ceil(words / 200));
  return `${String(minutes)} min read`;
}
