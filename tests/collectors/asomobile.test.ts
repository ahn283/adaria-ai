import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { AsoMobileCollector } from "../../src/collectors/asomobile.js";
import {
  ExternalApiError,
  RateLimitError,
} from "../../src/utils/errors.js";

interface MockResponse {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
  headers?: { get: (name: string) => string | null };
}

function mockResponse(partial: Partial<MockResponse>): MockResponse {
  return {
    ok: partial.ok ?? false,
    status: partial.status ?? 200,
    json: partial.json ?? (() => Promise.resolve({})),
    text: partial.text ?? (() => Promise.resolve("")),
    headers: partial.headers ?? { get: () => null },
  };
}

describe("AsoMobileCollector", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;
  let collector: AsoMobileCollector;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    collector = new AsoMobileCollector({ apiKey: "aso-key" });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws if apiKey is missing", () => {
    expect(() => new AsoMobileCollector({ apiKey: "" })).toThrow(
      /requires apiKey/
    );
  });

  it("fetches keyword rankings and maps to camelCase AsoKeywordRanking[]", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            results: [
              {
                keyword: "fridge manager",
                rank: 5,
                search_volume: 1200,
                competition: 30,
              },
              {
                keyword: "food tracker",
                rank: null,
                search_volume: 800,
              },
            ],
          }),
      })
    );

    const rankings = await collector.getKeywordRankings("123", "ios", [
      "fridge manager",
      "food tracker",
    ]);

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("/keywords/rankings");
    expect(calledUrl).toContain("app_id=123");
    expect(calledUrl).toContain("platform=ios");
    expect(calledUrl).toContain("keywords=fridge+manager%2Cfood+tracker");

    expect(rankings).toHaveLength(2);
    expect(rankings[0]).toEqual({
      keyword: "fridge manager",
      rank: 5,
      searchVolume: 1200,
      competition: 30,
    });
    expect(rankings[1]).toEqual({
      keyword: "food tracker",
      rank: null,
      searchVolume: 800,
      competition: null,
    });
  });

  it("fetches keyword suggestions with locale default", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            suggestions: [
              {
                keyword: "expiry reminder",
                search_volume: 500,
                competition: 10,
              },
            ],
          }),
      })
    );

    const suggestions = await collector.getKeywordSuggestions("123", "ios");
    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("/keywords/suggestions");
    expect(calledUrl).toContain("locale=ko");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.searchVolume).toBe(500);
  });

  it("getCompetitorInfo returns defaulted strings/keywords array", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            title: "Competitor",
            // omit subtitle/description/keywords on purpose
          }),
      })
    );

    const info = await collector.getCompetitorInfo("999", "android");
    expect(info.title).toBe("Competitor");
    expect(info.subtitle).toBe("");
    expect(info.description).toBe("");
    expect(info.keywords).toEqual([]);
  });

  it("throws RateLimitError with parsed retry-after on 429", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 429,
        headers: { get: () => "30" },
      })
    );

    const caught = await collector
      .getKeywordRankings("123", "ios", ["test"])
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(RateLimitError);
    expect((caught as RateLimitError).retryAfterSeconds).toBe(30);
  });

  it("rejects untrusted hosts via testHooks.baseUrl (SSRF defense-in-depth)", async () => {
    const bad = new AsoMobileCollector(
      { apiKey: "aso-key" },
      { baseUrl: "https://evil.example.com/v2" }
    );
    await expect(
      bad.getKeywordRankings("123", "ios", ["test"])
    ).rejects.toThrow(/Untrusted ASOMobile host/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("short-circuits getKeywordRankings when keywords array is empty", async () => {
    const rankings = await collector.getKeywordRankings("123", "ios", []);
    expect(rankings).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws ExternalApiError on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 500,
        text: () => Promise.resolve("boom"),
      })
    );

    const caught = await collector
      .getKeywordRankings("123", "ios", ["test"])
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ExternalApiError);
    expect((caught as ExternalApiError).statusCode).toBe(500);
  });
});
