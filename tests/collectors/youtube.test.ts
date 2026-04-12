import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { YouTubeCollector } from "../../src/collectors/youtube.js";
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

describe("YouTubeCollector", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;
  let collector: YouTubeCollector;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    collector = new YouTubeCollector({ apiKey: "yt-key" });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws if apiKey is missing", () => {
    expect(() => new YouTubeCollector({ apiKey: "" })).toThrow(
      /requires apiKey/
    );
  });

  it("getRecentShorts returns [] when channelId is empty", async () => {
    const result = await collector.getRecentShorts("");
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("getRecentShorts queries search then fetches video stats", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              items: [
                { id: { videoId: "v1" } },
                { id: { videoId: "v2" } },
                { id: {} },
              ],
            }),
        })
      )
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              items: [
                {
                  id: "v1",
                  snippet: {
                    title: "First",
                    publishedAt: "2026-04-01T00:00:00Z",
                  },
                  statistics: {
                    viewCount: "1200",
                    likeCount: "80",
                    commentCount: "5",
                  },
                  contentDetails: { duration: "PT30S" },
                },
                {
                  id: "v2",
                  snippet: { title: "Second" },
                  statistics: { viewCount: "60" },
                  contentDetails: { duration: "PT55S" },
                },
              ],
            }),
        })
      );

    const shorts = await collector.getRecentShorts("UCabc", 5);

    const searchUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(searchUrl).toContain("/search");
    expect(searchUrl).toContain("channelId=UCabc");
    expect(searchUrl).toContain("videoDuration=short");
    expect(searchUrl).toContain("maxResults=5");
    expect(searchUrl).toContain("key=yt-key");

    const statsUrl = mockFetch.mock.calls[1]?.[0] as string;
    expect(statsUrl).toContain("/videos");
    expect(statsUrl).toContain("id=v1%2Cv2");

    expect(shorts).toHaveLength(2);
    expect(shorts[0]).toEqual({
      videoId: "v1",
      title: "First",
      publishedAt: "2026-04-01T00:00:00Z",
      views: 1200,
      likes: 80,
      comments: 5,
      duration: "PT30S",
    });
    expect(shorts[1]?.likes).toBe(0);
    expect(shorts[1]?.publishedAt).toBeNull();
  });

  it("getRecentShorts returns [] when search yields no video IDs", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ items: [] }),
      })
    );
    const shorts = await collector.getRecentShorts("UCempty");
    expect(shorts).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("getVideoStats returns [] for an empty id list", async () => {
    const result = await collector.getVideoStats([]);
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws ExternalApiError on non-ok and redacts the API key", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 403,
        text: () =>
          Promise.resolve(
            `{"error":{"message":"API key yt-key has insufficient permissions"}}`
          ),
      })
    );

    const caught = await collector
      .getRecentShorts("UCfail")
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ExternalApiError);
    const msg = (caught as ExternalApiError).message;
    expect(msg).not.toContain("yt-key");
    expect(msg).toContain("[REDACTED]");
  });

  it("rejects untrusted hosts via testHooks (SSRF defense)", async () => {
    const bad = new YouTubeCollector(
      { apiKey: "yt-key" },
      { baseUrl: "https://evil.example.com/youtube/v3" }
    );
    await expect(bad.getRecentShorts("UCx")).rejects.toThrow(
      /Untrusted YouTube host/
    );
  });

  it("filters out videos longer than maxDurationSeconds (default 60s)", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              items: [
                { id: { videoId: "short" } },
                { id: { videoId: "long" } },
                { id: { videoId: "hourly" } },
              ],
            }),
        })
      )
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              items: [
                {
                  id: "short",
                  snippet: { title: "ok" },
                  statistics: { viewCount: "10" },
                  contentDetails: { duration: "PT45S" },
                },
                {
                  id: "long",
                  snippet: { title: "too long" },
                  statistics: { viewCount: "10" },
                  contentDetails: { duration: "PT3M0S" },
                },
                {
                  id: "hourly",
                  snippet: { title: "way too long" },
                  statistics: { viewCount: "10" },
                  contentDetails: { duration: "PT1H0M" },
                },
              ],
            }),
        })
      );

    const result = await collector.getRecentShorts("UCx");
    expect(result).toHaveLength(1);
    expect(result[0]?.videoId).toBe("short");
  });

  it("accepts longer clips when caller passes maxDurationSeconds", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              items: [{ id: { videoId: "v" } }],
            }),
        })
      )
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              items: [
                {
                  id: "v",
                  snippet: { title: "3-minute vertical" },
                  statistics: { viewCount: "10" },
                  contentDetails: { duration: "PT3M0S" },
                },
              ],
            }),
        })
      );

    const result = await collector.getRecentShorts("UCx", 10, 180);
    expect(result).toHaveLength(1);
  });

  it("redacts the API key from fetch-level failures", async () => {
    mockFetch.mockRejectedValueOnce(
      new TypeError(
        "fetch failed: https://www.googleapis.com/youtube/v3/search?key=yt-key"
      )
    );

    const caught = await collector
      .getRecentShorts("UCx")
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ExternalApiError);
    const msg = (caught as ExternalApiError).message;
    expect(msg).not.toContain("yt-key");
    expect(msg).toContain("[REDACTED]");
  });
});
