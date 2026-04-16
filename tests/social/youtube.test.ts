/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-base-to-string */
import { afterEach, describe, it, expect, vi } from "vitest";
import { YouTubeClient } from "../../src/social/youtube.js";

const config = { accessToken: "tok", channelId: "UC123" };

describe("YouTubeClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates 5000 char limit", () => {
    const client = new YouTubeClient(config);
    expect(client.validateContent("Community post").valid).toBe(true);
    expect(client.validateContent("x".repeat(5001)).valid).toBe(false);
  });

  it("post() hits the YouTube Data API v3 activities endpoint with bulletin payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "post-xyz" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new YouTubeClient(config);
    const result = await client.post({ text: "Hello YouTube" });

    expect(result.success).toBe(true);
    expect(result.postId).toBe("post-xyz");
    expect(result.postUrl).toContain("youtube.com/post/post-xyz");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(
      "googleapis.com/youtube/v3/activities?part=snippet,contentDetails",
    );
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
    const body = JSON.parse(String((init as RequestInit).body)) as {
      snippet: { channelId: string; description: string; type: string };
    };
    expect(body.snippet.channelId).toBe("UC123");
    expect(body.snippet.type).toBe("bulletin");
    expect(body.snippet.description).toContain("Hello YouTube");
  });

  it("post() returns failure result when API responds non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })),
    );
    const client = new YouTubeClient(config);
    const result = await client.post({ text: "Test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("403");
  });
});
