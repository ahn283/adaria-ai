import { describe, it, expect, afterEach } from "vitest";
import { TikTokClient } from "../../src/social/tiktok.js";

const config = { clientKey: "key", clientSecret: "secret", accessToken: "tok" };

describe("TikTokClient", () => {
  const originalEnv = process.env["ADARIA_DRY_RUN"];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env["ADARIA_DRY_RUN"] = originalEnv;
    } else {
      delete process.env["ADARIA_DRY_RUN"];
    }
  });

  it("validates 2200 char caption limit", () => {
    const client = new TikTokClient(config);
    expect(client.validateContent("Short caption").valid).toBe(true);
    expect(client.validateContent("x".repeat(2201)).valid).toBe(false);
  });

  it("requires image/video for posting", async () => {
    delete process.env["ADARIA_DRY_RUN"];
    const client = new TikTokClient(config);
    const result = await client.post({ text: "No image" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("image or video");
  });

  it("returns dry-run result", async () => {
    process.env["ADARIA_DRY_RUN"] = "1";
    const client = new TikTokClient(config);
    const result = await client.post({ text: "TikTok", imageUrl: "https://example.com/img.jpg" });
    expect(result.dryRun).toBe(true);
  });
});
