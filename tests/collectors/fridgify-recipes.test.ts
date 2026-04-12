import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { FridgifyRecipesCollector } from "../../src/collectors/fridgify-recipes.js";
import type { FridgifyRecipe } from "../../src/types/collectors.js";
import { ExternalApiError, RateLimitError } from "../../src/utils/errors.js";

interface MockResponse {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}

function okJson(body: unknown): MockResponse {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  };
}

function errJson(status: number, body: string): MockResponse {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
  };
}

const sampleRecipe: FridgifyRecipe = {
  id: "abc",
  name: "Test",
  periodScore: 9,
};

describe("FridgifyRecipesCollector", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;
  let collector: FridgifyRecipesCollector;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    collector = new FridgifyRecipesCollector({ retryDelayMs: 1 });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("getPopular", () => {
    it("hits /recipes/popular with default params", async () => {
      mockFetch.mockResolvedValueOnce(okJson([sampleRecipe]));

      const rows = await collector.getPopular();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toContain("https://fridgify-api.eodin.app/recipes/popular");
      expect(url).toContain("period=week");
      expect(url).toContain("metric=combined");
      expect(url).toContain("limit=10");
      expect(rows).toEqual([sampleRecipe]);
    });

    it("passes period/metric/limit overrides", async () => {
      mockFetch.mockResolvedValueOnce(okJson([]));

      await collector.getPopular({
        period: "month",
        metric: "likes",
        limit: 25,
      });

      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toContain("period=month");
      expect(url).toContain("metric=likes");
      expect(url).toContain("limit=25");
    });

    it("returns [] when API returns a non-array body", async () => {
      mockFetch.mockResolvedValueOnce(okJson({ error: "wat" }));
      const rows = await collector.getPopular();
      expect(rows).toEqual([]);
    });

    it("retries exactly once on 429", async () => {
      mockFetch
        .mockResolvedValueOnce(errJson(429, "ThrottlerException"))
        .mockResolvedValueOnce(okJson([sampleRecipe]));

      const rows = await collector.getPopular();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(rows).toEqual([sampleRecipe]);
    });

    it("throws RateLimitError after a second 429 (no further retries)", async () => {
      mockFetch
        .mockResolvedValueOnce(errJson(429, "ThrottlerException"))
        .mockResolvedValueOnce(errJson(429, "ThrottlerException"));

      const caught = await collector
        .getPopular()
        .catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(RateLimitError);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // retryDelayMs = 1 in test → retryAfterSeconds rounds up to 1.
      expect((caught as RateLimitError).retryAfterSeconds).toBe(1);
    });

    it("throws ExternalApiError on non-retryable error", async () => {
      mockFetch.mockResolvedValueOnce(errJson(500, "boom"));

      const caught = await collector.getPopular().catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(ExternalApiError);
      expect((caught as ExternalApiError).statusCode).toBe(500);
    });

    it("rejects untrusted base URL hosts via testHooks (SSRF defense)", async () => {
      const evil = new FridgifyRecipesCollector(
        {},
        { baseUrl: "https://evil.example.com" }
      );
      await expect(evil.getPopular()).rejects.toThrow(
        /Untrusted Fridgify host/
      );
    });
  });

  describe("getPopularWithCascade", () => {
    it("returns week with satisfied=true when week has enough rows", async () => {
      const rows: FridgifyRecipe[] = Array.from({ length: 5 }, (_, i) => ({
        ...sampleRecipe,
        id: `w${String(i)}`,
      }));
      mockFetch.mockResolvedValueOnce(okJson(rows));

      const result = await collector.getPopularWithCascade({ minResults: 5 });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.period).toBe("week");
      expect(result.rows).toHaveLength(5);
      expect(result.satisfied).toBe(true);
    });

    it("cascades past empty week/month to quarter with satisfied=true", async () => {
      const quarterRows: FridgifyRecipe[] = Array.from(
        { length: 6 },
        (_, i) => ({ ...sampleRecipe, id: `q${String(i)}` })
      );
      mockFetch
        .mockResolvedValueOnce(okJson([]))
        .mockResolvedValueOnce(okJson([sampleRecipe]))
        .mockResolvedValueOnce(okJson(quarterRows));

      const result = await collector.getPopularWithCascade({ minResults: 5 });

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(result.period).toBe("quarter");
      expect(result.rows).toHaveLength(6);
      expect(result.satisfied).toBe(true);
    });

    it("exhausts all windows and returns satisfied=false with the last rows", async () => {
      mockFetch
        .mockResolvedValueOnce(okJson([]))
        .mockResolvedValueOnce(okJson([]))
        .mockResolvedValueOnce(okJson([]))
        .mockResolvedValueOnce(okJson([sampleRecipe]));

      const result = await collector.getPopularWithCascade({ minResults: 5 });

      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(result.period).toBe("year");
      expect(result.rows).toHaveLength(1);
      expect(result.satisfied).toBe(false);
    });

    it("returns empty with satisfied=false when every window is empty", async () => {
      for (let i = 0; i < 4; i += 1) {
        mockFetch.mockResolvedValueOnce(okJson([]));
      }

      const result = await collector.getPopularWithCascade({ minResults: 5 });

      expect(result.period).toBe("year");
      expect(result.rows).toEqual([]);
      expect(result.satisfied).toBe(false);
    });
  });

  describe("getRecipe", () => {
    it("hits /recipes/:id", async () => {
      mockFetch.mockResolvedValueOnce(okJson(sampleRecipe));

      const r = await collector.getRecipe("abc-123");

      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toContain("/recipes/abc-123");
      expect(r).toEqual(sampleRecipe);
    });

    it("throws on empty id", async () => {
      await expect(collector.getRecipe("")).rejects.toThrow(
        /non-empty string id/
      );
    });
  });
});
