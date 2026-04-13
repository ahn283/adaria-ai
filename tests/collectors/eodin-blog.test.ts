import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  EodinAnalytics,
  EodinBlogPublisher,
  EodinSeoMetrics,
  estimateReadTime,
  markdownToHtml,
} from "../../src/collectors/eodin-blog.js";
import type { BlogPostUpdate } from "../../src/types/collectors.js";
import { ExternalApiError } from "../../src/utils/errors.js";

interface MockResponse {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}

function mockResponse(partial: Partial<MockResponse>): MockResponse {
  return {
    ok: partial.ok ?? false,
    status: partial.status ?? 200,
    json: partial.json ?? (() => Promise.resolve({})),
    text: partial.text ?? (() => Promise.resolve("")),
  };
}

describe("EodinBlogPublisher", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;
  let pub: EodinBlogPublisher;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    pub = new EodinBlogPublisher({ baseUrl: "https://test.example.com/api/v1/growth", token: "growth-token" });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws if token is missing", () => {
    expect(() => new EodinBlogPublisher({ baseUrl: "https://test.example.com", token: "" })).toThrow(
      /GROWTH_AGENT_TOKEN/
    );
  });

  it("create posts a draft with Bearer token header", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ slug: "hello" }),
      })
    );

    await pub.create({
      slug: "hello",
      title: "Hello",
      description: "A post",
      category: "Product",
      content: "<p>hi</p>",
    });

    const call = mockFetch.mock.calls[0];
    expect(call?.[0]).toContain(
      "https://test.example.com/api/v1/growth/blogs"
    );
    const init = call?.[1] as {
      method: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer growth-token");
    expect(init.headers["Content-Type"]).toBe("application/json");
    const parsed = JSON.parse(init.body) as { slug: string; category: string };
    expect(parsed.slug).toBe("hello");
    expect(parsed.category).toBe("Product");
  });

  it("publish PUTs the slug's publish endpoint with PUBLISHED body", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      })
    );

    await pub.publish("hello-world");

    const call = mockFetch.mock.calls[0];
    expect(call?.[0]).toContain("/blogs/hello-world/publish");
    const init = call?.[1] as { method: string; body: string };
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ status: "PUBLISHED" });
  });

  it("encodeURIComponent is applied to slug path segments", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      })
    );

    await pub.get("weird slug/../evil");

    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).not.toContain("/../");
    expect(url).toContain(encodeURIComponent("weird slug/../evil"));
  });

  it("list passes query params and returns parsed response", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: [{ slug: "a" }, { slug: "b" }],
            pagination: { page: 1, limit: 100 },
          }),
      })
    );

    const res = await pub.list({ status: "PUBLISHED", limit: 50 });
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain("status=PUBLISHED");
    expect(url).toContain("limit=50");
    expect(res.data).toHaveLength(2);
  });

  it("listSlugs returns slugs from list() data", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ data: [{ slug: "a" }, { slug: "b" }] }),
      })
    );

    const slugs = await pub.listSlugs();
    expect(slugs).toEqual(["a", "b"]);
  });

  it("listSlugs degrades gracefully to [] on failure", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 500,
        text: () => Promise.resolve("boom"),
      })
    );

    const slugs = await pub.listSlugs();
    expect(slugs).toEqual([]);
  });

  it("throws ExternalApiError on non-ok and redacts the bearer token", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 401,
        text: () =>
          Promise.resolve(`{"error":"Invalid token growth-token"}`),
      })
    );

    const caught = await pub
      .get("some-slug")
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ExternalApiError);
    const msg = (caught as ExternalApiError).message;
    expect(msg).not.toContain("growth-token");
    expect(msg).toContain("[REDACTED]");
  });

  it("rejects untrusted hosts via testHooks (SSRF defense-in-depth)", async () => {
    const bad = new EodinBlogPublisher(
      { baseUrl: "https://legit.example.com/api/v1/growth", token: "x" },
      { baseUrl: "https://evil.example.com/api/v1/growth" },
    );
    await expect(bad.get("anything")).rejects.toThrow(/Untrusted Eodin host/);
  });

  it("update rejects an empty updates object", async () => {
    await expect(pub.update("hello", {} as BlogPostUpdate)).rejects.toThrow(
      /must not be empty/
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("list without options sends no query string (server default)", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [] }),
      })
    );
    await pub.list();
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toMatch(/\/blogs$/);
    expect(url).not.toContain("?");
  });
});

describe("EodinSeoMetrics + EodinAnalytics", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("SEO getOverview hits /metrics/seo/overview with date range", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      })
    );

    const seo = new EodinSeoMetrics({ baseUrl: "https://test.example.com/api/v1/growth", token: "seo-token" });
    await seo.getOverview("2026-03-01", "2026-03-31");

    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain("/metrics/seo/overview");
    expect(url).toContain("startDate=2026-03-01");
    expect(url).toContain("endDate=2026-03-31");
  });

  it("Analytics getRealtime hits /metrics/analytics/realtime", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      })
    );

    const an = new EodinAnalytics({ baseUrl: "https://test.example.com/api/v1/growth", token: "an-token" });
    await an.getRealtime();

    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain("/metrics/analytics/realtime");
  });
});

describe("markdownToHtml (security)", () => {
  it("escapes raw HTML tags in paragraph content", () => {
    const html = markdownToHtml("<script>alert(1)</script>");
    expect(html).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(html).not.toContain("<script>");
  });

  it("escapes HTML inside list items and headings", () => {
    const html = markdownToHtml("# <b>Title</b>\n\n- <img src=x onerror=1>");
    expect(html).toContain("&lt;b&gt;Title&lt;/b&gt;");
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<img");
  });

  it("rewrites javascript: links to href=\"#\"", () => {
    const html = markdownToHtml("[click](javascript:alert(1))");
    expect(html).toContain('href="#"');
    expect(html).not.toContain("javascript:");
  });

  it("drops data: and vbscript: link schemes", () => {
    const html = markdownToHtml("[d](data:text/html,<x>) [v](vbscript:msgbox)");
    expect(html).not.toContain("data:");
    expect(html).not.toContain("vbscript:");
  });

  it("allows https, mailto, relative and fragment links", () => {
    const html = markdownToHtml(
      "[a](https://eodin.app) [b](mailto:x@y.com) [c](/about) [d](#anchor)"
    );
    expect(html).toContain('href="https://eodin.app"');
    expect(html).toContain('href="mailto:x@y.com"');
    expect(html).toContain('href="/about"');
    expect(html).toContain('href="#anchor"');
  });

  it("prevents attribute-escape injection via link URLs", () => {
    const html = markdownToHtml('[x](" onmouseover="alert(1))');
    // The injected quote must be escaped inside the href attribute, and
    // since the scheme is invalid it should fall back to "#" anyway.
    expect(html).not.toMatch(/href=""[^>]*onmouseover/);
  });
});

describe("markdownToHtml", () => {
  it("renders h1-h3 headings", () => {
    const html = markdownToHtml("# T1\n\n## T2\n\n### T3");
    expect(html).toContain("<h1>T1</h1>");
    expect(html).toContain("<h2>T2</h2>");
    expect(html).toContain("<h3>T3</h3>");
  });

  it("renders paragraphs, bold, italic, links", () => {
    const html = markdownToHtml(
      "This is **bold** and *italic* with a [link](https://example.com)."
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain('<a href="https://example.com">link</a>');
    expect(html.startsWith("<p>")).toBe(true);
  });

  it("renders unordered lists", () => {
    const html = markdownToHtml("- one\n- two\n- three");
    expect(html).toContain("<ul><li>one</li><li>two</li><li>three</li></ul>");
  });

  it("drops empty blocks", () => {
    const html = markdownToHtml("text\n\n\n\nmore");
    expect(html).toBe("<p>text</p>\n<p>more</p>");
  });
});

describe("estimateReadTime", () => {
  it("rounds up to at least 1 minute", () => {
    expect(estimateReadTime("")).toBe("1 min read");
    expect(estimateReadTime("only three words.")).toBe("1 min read");
  });

  it("calculates ~200 wpm", () => {
    const text = "word ".repeat(600).trim();
    expect(estimateReadTime(text)).toBe("3 min read");
  });
});
