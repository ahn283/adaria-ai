/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { afterEach, describe, it, expect, vi } from "vitest";
import { FacebookClient } from "../../src/social/facebook.js";

const config = {
  appId: "test-app-id",
  appSecret: "test-app-secret",
  accessToken: "test-token",
  pageId: "test-page-id",
};

describe("FacebookClient", () => {
  it("validates content length", () => {
    const client = new FacebookClient(config);
    const result = client.validateContent("Hello Facebook!");
    expect(result.valid).toBe(true);
  });

  it("rejects empty text", () => {
    const client = new FacebookClient(config);
    const result = client.validateContent("");
    expect(result.valid).toBe(false);
  });

  it("suggests longer text for short posts", () => {
    const client = new FacebookClient(config);
    const result = client.validateContent("Hi");
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  describe("post()", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("fetches page token then POSTs to /{pageId}/feed with appsecret_proof", async () => {
      const fetchMock = vi
        .fn()
        // 1. /me/accounts → page token
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              data: [{ id: "test-page-id", access_token: "page-tok" }],
            }),
            { status: 200 },
          ),
        )
        // 2. /pageId/feed → post id
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: "fb-post-1" }), { status: 200 }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const client = new FacebookClient(config);
      const result = await client.post({
        text: "Hello Facebook from a sufficiently long post",
      });

      expect(result.success).toBe(true);
      expect(result.postId).toBe("fb-post-1");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const [tokenUrl] = fetchMock.mock.calls[0]!;
      expect(String(tokenUrl)).toContain("/me/accounts");
      expect(String(tokenUrl)).toContain("appsecret_proof=");

      const [feedUrl, feedInit] = fetchMock.mock.calls[1]!;
      expect(String(feedUrl)).toBe(
        "https://graph.facebook.com/v19.0/test-page-id/feed",
      );
      expect((feedInit as RequestInit).method).toBe("POST");
      const params = (feedInit as RequestInit).body as URLSearchParams;
      expect(params.get("message")).toContain("Hello Facebook");
      expect(params.get("access_token")).toBe("page-tok");
      expect(params.get("appsecret_proof")).toMatch(/^[a-f0-9]{64}$/);
    });

    it("returns failure when /me/accounts cannot resolve page", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
        ),
      );
      const client = new FacebookClient(config);
      const result = await client.post({
        text: "post that is definitely longer than forty characters here",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/page|token/i);
    });
  });
});
