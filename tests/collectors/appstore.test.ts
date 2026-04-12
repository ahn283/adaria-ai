import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { AppStoreCollector } from "../../src/collectors/appstore.js";
import {
  ExternalApiError,
  RateLimitError,
} from "../../src/utils/errors.js";

vi.mock("jose", () => ({
  importPKCS8: vi.fn().mockResolvedValue("mock-key"),
  SignJWT: vi.fn().mockImplementation(() => ({
    setProtectedHeader: vi.fn().mockReturnThis(),
    setIssuer: vi.fn().mockReturnThis(),
    setIssuedAt: vi.fn().mockReturnThis(),
    setExpirationTime: vi.fn().mockReturnThis(),
    setAudience: vi.fn().mockReturnThis(),
    sign: vi.fn().mockResolvedValue("mock-jwt-token"),
  })),
}));

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

describe("AppStoreCollector", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;
  let collector: AppStoreCollector;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    collector = new AppStoreCollector({
      keyId: "KEY123",
      issuerId: "ISSUER456",
      privateKey: "-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----",
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws if required params are missing", () => {
    expect(
      () =>
        new AppStoreCollector({
          keyId: "",
          issuerId: "",
          privateKey: "",
        })
    ).toThrow("requires keyId");
  });

  it("fetches reviews and maps response to StoreReview[]", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: "review-1",
                attributes: {
                  rating: 5,
                  body: "Great app!",
                  createdDate: "2026-03-30T10:00:00Z",
                },
              },
            ],
          }),
      })
    );

    const reviews = await collector.getReviews("123456789", 10);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.reviewId).toBe("review-1");
    expect(reviews[0]?.rating).toBe(5);
    expect(reviews[0]?.createdAt).toBe("2026-03-30T10:00:00Z");
    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("/apps/123456789/customerReviews");
    expect(calledUrl).toContain("limit=10");
  });

  it("throws RateLimitError with retry-after on 429", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 429,
        headers: { get: () => "120" },
      })
    );

    await expect(collector.getReviews("123")).rejects.toBeInstanceOf(
      RateLimitError
    );

    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 429,
        headers: { get: () => "120" },
      })
    );
    const caught = await collector.getReviews("123").catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(RateLimitError);
    expect((caught as RateLimitError).retryAfterSeconds).toBe(120);
  });

  it("throws ExternalApiError on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal error"),
      })
    );

    const caught = await collector.getReviews("123").catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ExternalApiError);
    expect((caught as ExternalApiError).statusCode).toBe(500);
  });

  it("getAppLocalizations returns the requested locale or null", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: [{ id: "info-1" }] }),
        })
      )
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: [
                {
                  id: "loc-en",
                  attributes: { locale: "en-US", name: "EN app" },
                },
                {
                  id: "loc-ko",
                  attributes: {
                    locale: "ko",
                    name: "한국",
                    subtitle: "부제",
                    keywords: "키워드",
                    description: "설명",
                  },
                },
              ],
            }),
        })
      );

    const loc = await collector.getAppLocalizations("app-id", "ko");
    expect(loc).not.toBeNull();
    expect(loc?.id).toBe("loc-ko");
    expect(loc?.name).toBe("한국");
    expect(loc?.keywords).toBe("키워드");
  });

  it("getAppLocalizations returns null when no appInfo", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [] }),
      })
    );

    const loc = await collector.getAppLocalizations("app-id", "ko");
    expect(loc).toBeNull();
  });

  it("updateLocalization enforces length limits", async () => {
    await expect(
      collector.updateLocalization("loc-1", { name: "x".repeat(31) })
    ).rejects.toThrow(/name exceeds/);
    await expect(
      collector.updateLocalization("loc-1", { subtitle: "y".repeat(31) })
    ).rejects.toThrow(/subtitle exceeds/);
    await expect(
      collector.updateLocalization("loc-1", { keywords: "z".repeat(101) })
    ).rejects.toThrow(/keywords exceeds/);
    await expect(
      collector.updateLocalization("", { name: "ok" })
    ).rejects.toThrow(/localizationId is required/);
  });

  it("replyToReview enforces limits", async () => {
    await expect(collector.replyToReview("r1", "")).rejects.toThrow(
      /non-empty string/
    );
    await expect(
      collector.replyToReview("r1", "x".repeat(5971))
    ).rejects.toThrow(/5970/);
  });

  it("updateLocalization sends PATCH with JSON:API envelope", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      })
    );
    await collector.updateLocalization("loc-1", {
      name: "신제품",
      keywords: "레시피,냉장고",
    });
    const call = mockFetch.mock.calls[0];
    expect(call?.[0]).toContain("/appInfoLocalizations/loc-1");
    const init = call?.[1] as { method: string; body: string };
    expect(init.method).toBe("PATCH");
    const parsed = JSON.parse(init.body) as {
      data: { type: string; id: string; attributes: Record<string, string> };
    };
    expect(parsed.data.type).toBe("appInfoLocalizations");
    expect(parsed.data.id).toBe("loc-1");
    expect(parsed.data.attributes.name).toBe("신제품");
    expect(parsed.data.attributes.keywords).toBe("레시피,냉장고");
    // subtitle / description not provided → must not be echoed.
    expect(parsed.data.attributes.subtitle).toBeUndefined();
    expect(parsed.data.attributes.description).toBeUndefined();
  });

  it("updateLocalization rejects empty update objects", async () => {
    await expect(collector.updateLocalization("loc-1", {})).rejects.toThrow(
      /at least one field/
    );
  });

  it("replyToReview posts customerReviewResponses envelope", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 201,
        json: () => Promise.resolve({}),
      })
    );
    await collector.replyToReview("review-99", "감사합니다");
    const call = mockFetch.mock.calls[0];
    expect(call?.[0]).toContain("/customerReviewResponses");
    const init = call?.[1] as { method: string; body: string };
    expect(init.method).toBe("POST");
    const parsed = JSON.parse(init.body) as {
      data: {
        type: string;
        attributes: { responseBody: string };
        relationships: { review: { data: { type: string; id: string } } };
      };
    };
    expect(parsed.data.type).toBe("customerReviewResponses");
    expect(parsed.data.attributes.responseBody).toBe("감사합니다");
    expect(parsed.data.relationships.review.data).toEqual({
      type: "customerReviews",
      id: "review-99",
    });
  });

  it("caches the signed token across requests", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [] }),
      })
    );

    await collector.getReviews("123");
    await collector.getReviews("456");

    // Both requests should carry the same bearer token.
    const firstAuth = (
      mockFetch.mock.calls[0]?.[1] as { headers: Record<string, string> }
    ).headers.Authorization;
    const secondAuth = (
      mockFetch.mock.calls[1]?.[1] as { headers: Record<string, string> }
    ).headers.Authorization;
    expect(firstAuth).toBe("Bearer mock-jwt-token");
    expect(secondAuth).toBe("Bearer mock-jwt-token");
  });
});
