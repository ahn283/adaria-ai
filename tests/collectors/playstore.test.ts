import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { PlayStoreCollector } from "../../src/collectors/playstore.js";
import {
  AuthError,
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

const SERVICE_ACCOUNT = {
  client_email: "bot@example.iam.gserviceaccount.com",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----",
};

function tokenOk() {
  return mockResponse({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({ access_token: "play-access-token", expires_in: 3600 }),
  });
}

describe("PlayStoreCollector", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;
  let collector: PlayStoreCollector;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    collector = new PlayStoreCollector({ serviceAccountJson: SERVICE_ACCOUNT });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws if serviceAccountJson is missing", () => {
    expect(
      () =>
        new PlayStoreCollector({
          serviceAccountJson: "" as unknown as string,
        })
    ).toThrow(/requires serviceAccountJson/);
  });

  it("throws if serviceAccount missing client_email or private_key", () => {
    expect(
      () =>
        new PlayStoreCollector({
          serviceAccountJson: {
            client_email: "",
            private_key: "",
          },
        })
    ).toThrow(/client_email and private_key/);
  });

  it("accepts a JSON string service account", () => {
    expect(
      () =>
        new PlayStoreCollector({
          serviceAccountJson: JSON.stringify(SERVICE_ACCOUNT),
        })
    ).not.toThrow();
  });

  it("wraps invalid JSON in AuthError without leaking contents", () => {
    let caught: unknown;
    try {
      new PlayStoreCollector({
        serviceAccountJson: "-----BEGIN PRIVATE KEY-----\nsecretish",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthError);
    const msg = (caught as AuthError).message;
    expect(msg).not.toContain("secretish");
    expect(msg).toMatch(/not valid JSON/);
  });

  it("fetches reviews and maps response to StoreReview[]", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              reviews: [
                {
                  reviewId: "r-1",
                  comments: [
                    {
                      userComment: {
                        starRating: 4,
                        text: "nice",
                        lastModified: { seconds: "1700000000" },
                      },
                    },
                  ],
                },
                {
                  reviewId: "r-2",
                  comments: [
                    {
                      userComment: {
                        starRating: 1,
                        text: "bad",
                      },
                    },
                  ],
                },
              ],
            }),
        })
      );

    const reviews = await collector.getReviews("com.example.app");
    expect(reviews).toHaveLength(2);
    expect(reviews[0]).toMatchObject({
      reviewId: "r-1",
      rating: 4,
      body: "nice",
    });
    expect(reviews[0]?.createdAt).toBe(
      new Date(1_700_000_000 * 1000).toISOString()
    );
    expect(reviews[1]?.createdAt).toBeNull();
  });

  it("throws RateLimitError on 429 with Retry-After", async () => {
    mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 429,
        headers: { get: () => "30" },
      })
    );

    const caught = await collector
      .getReviews("com.example.app")
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(RateLimitError);
    expect((caught as RateLimitError).retryAfterSeconds).toBe(30);
  });

  it("throws ExternalApiError on non-ok review response", async () => {
    mockFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 500,
        text: () => Promise.resolve("boom"),
      })
    );

    const caught = await collector
      .getReviews("com.example.app")
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ExternalApiError);
    expect((caught as ExternalApiError).statusCode).toBe(500);
  });

  it("wraps OAuth failures in ExternalApiError", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 401,
        text: () => Promise.resolve("invalid_grant"),
      })
    );

    const caught = await collector
      .getReviews("com.example.app")
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ExternalApiError);
    expect((caught as ExternalApiError).statusCode).toBe(401);
  });

  it("replyToReview enforces length and non-empty", async () => {
    await expect(
      collector.replyToReview("com.example.app", "r-1", "")
    ).rejects.toThrow(/non-empty/);
    await expect(
      collector.replyToReview("com.example.app", "r-1", "x".repeat(351))
    ).rejects.toThrow(/350/);
  });

  it("replyToReview posts to the reply endpoint with JSON body", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ result: { replyText: "thanks" } }),
        })
      );

    await collector.replyToReview("com.example.app", "r-1", "thanks");
    const replyCall = mockFetch.mock.calls[1];
    expect(replyCall?.[0]).toContain(
      "/applications/com.example.app/reviews/r-1:reply"
    );
    const init = replyCall?.[1] as {
      method: string;
      body: string;
      headers: Record<string, string>;
    };
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ replyText: "thanks" });
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("caches OAuth access token across calls", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ reviews: [] }),
        })
      );

    await collector.getReviews("com.example.app");
    await collector.getReviews("com.example.app");

    // Only one OAuth token call (first), then two review fetches.
    const tokenCalls = mockFetch.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("oauth2.googleapis.com")
    );
    expect(tokenCalls).toHaveLength(1);
  });
});
