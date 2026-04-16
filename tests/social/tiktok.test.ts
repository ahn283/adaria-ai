/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-base-to-string */
import { afterEach, describe, it, expect, vi } from "vitest";
import { TikTokClient } from "../../src/social/tiktok.js";

const config = { clientKey: "key", clientSecret: "secret", accessToken: "tok" };

describe("TikTokClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates 2200 char caption limit", () => {
    const client = new TikTokClient(config);
    expect(client.validateContent("Short caption").valid).toBe(true);
    expect(client.validateContent("x".repeat(2201)).valid).toBe(false);
  });

  it("requires image/video for posting", async () => {
    const client = new TikTokClient(config);
    const result = await client.post({ text: "No image" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("image or video");
  });

  it("post() initializes the publish inbox with PULL_FROM_URL source", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { publish_id: "pub-1" } }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new TikTokClient(config);
    const result = await client.post({
      text: "Test caption",
      imageUrl: "https://example.com/img.jpg",
    });

    expect(result.success).toBe(true);
    expect(result.postId).toBe("pub-1");
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/post/publish/inbox/video/init/");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
    const body = JSON.parse(String((init as RequestInit).body)) as {
      post_info: { title: string; privacy_level: string };
      source_info: { source: string; photo_images: string[] };
    };
    expect(body.post_info.title).toContain("Test caption");
    expect(body.post_info.privacy_level).toBe("PUBLIC_TO_EVERYONE");
    expect(body.source_info.source).toBe("PULL_FROM_URL");
    expect(body.source_info.photo_images).toEqual([
      "https://example.com/img.jpg",
    ]);
  });
});
