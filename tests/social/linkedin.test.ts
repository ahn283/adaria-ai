/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-base-to-string */
import { afterEach, describe, it, expect, vi } from "vitest";
import { LinkedInClient } from "../../src/social/linkedin.js";

const config = {
  accessToken: "test-token",
  organizationId: "12345",
};

describe("LinkedInClient", () => {
  it("validates 3000 char limit", () => {
    const client = new LinkedInClient(config);
    const result = client.validateContent("A professional post");
    expect(result.valid).toBe(true);
  });

  it("rejects text exceeding 3000 chars", () => {
    const client = new LinkedInClient(config);
    const result = client.validateContent("x".repeat(3001));
    expect(result.valid).toBe(false);
  });

  it("suggests shorter text for engagement", () => {
    const client = new LinkedInClient(config);
    const result = client.validateContent("x".repeat(1500));
    expect(result.suggestions.some((s) => s.includes("1,300"))).toBe(true);
  });

  it("suggests adding hashtags when none present", () => {
    const client = new LinkedInClient(config);
    const result = client.validateContent("A post without hashtags");
    expect(result.suggestions.some((s) => s.includes("hashtag"))).toBe(true);
  });

  it("warns about too many hashtags", () => {
    const client = new LinkedInClient(config);
    const result = client.validateContent("Post #a #b #c #d #e #f #g");
    expect(result.suggestions.some((s) => s.includes("3-5"))).toBe(true);
  });

  describe("post()", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("POSTs to /rest/posts with org URN, version header, and body commentary", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 201,
          headers: { "x-linkedin-id": "urn:li:share:42" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const client = new LinkedInClient(config);
      const result = await client.post({ text: "Professional update" });

      expect(result.success).toBe(true);
      expect(result.postId).toBe("urn:li:share:42");

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe("https://api.linkedin.com/rest/posts");
      expect((init as RequestInit).method).toBe("POST");
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer test-token");
      expect(headers["LinkedIn-Version"]).toMatch(/^\d{6}$/);
      expect(headers["X-Restli-Protocol-Version"]).toBe("2.0.0");
      const body = JSON.parse(String((init as RequestInit).body)) as {
        author: string;
        commentary: string;
      };
      expect(body.author).toBe("urn:li:organization:12345");
      expect(body.commentary).toContain("Professional update");
    });

    it("returns failure result when API responds non-2xx", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response("forbidden", { status: 403 }),
        ),
      );
      const client = new LinkedInClient(config);
      const result = await client.post({ text: "Hi" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("403");
    });
  });
});
