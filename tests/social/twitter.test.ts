/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-base-to-string */
import { afterEach, describe, it, expect, vi } from "vitest";
import { TwitterClient } from "../../src/social/twitter.js";

const config = {
  apiKey: "test-key",
  apiSecret: "test-secret",
  accessToken: "test-token",
  accessTokenSecret: "test-token-secret",
};

describe("TwitterClient", () => {
  it("validates character limit (280)", () => {
    const client = new TwitterClient(config);
    const valid = client.validateContent("Hello world");
    expect(valid.valid).toBe(true);
    expect(valid.characterCount).toBe(11);
  });

  it("rejects text exceeding 280 chars", () => {
    const client = new TwitterClient(config);
    const longText = "x".repeat(281);
    const result = client.validateContent(longText);
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toContain("280");
  });

  it("counts URLs as 23 chars", () => {
    const client = new TwitterClient(config);
    const text = "Check this out https://example.com/very/long/path/to/resource";
    const result = client.validateContent(text);
    // "Check this out " (15) + 23 (t.co) = 38
    expect(result.characterCount).toBe(38);
  });

  it("rejects empty text", () => {
    const client = new TwitterClient(config);
    const result = client.validateContent("   ");
    expect(result.valid).toBe(false);
  });

  describe("post()", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("POSTs to /2/tweets with OAuth header and JSON body", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { id: "tweet-42" } }), {
          status: 200,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const client = new TwitterClient(config);
      const result = await client.post({ text: "Hello world" });

      expect(result.success).toBe(true);
      expect(result.postId).toBe("tweet-42");
      expect(result.postUrl).toContain("twitter.com/i/status/tweet-42");

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe("https://api.twitter.com/2/tweets");
      expect((init as RequestInit).method).toBe("POST");
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers["Authorization"]).toMatch(/^OAuth /);
      expect(headers["Authorization"]).toContain('oauth_consumer_key="test-key"');
      expect(headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(String((init as RequestInit).body)) as {
        text: string;
      };
      expect(body.text).toBe("Hello world");
    });

    it("returns failure result when API responds non-2xx", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response("rate limited", { status: 429 }),
        ),
      );
      const client = new TwitterClient(config);
      const result = await client.post({ text: "Hi" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("429");
    });
  });
});
