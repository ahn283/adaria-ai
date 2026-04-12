import { describe, it, expect, afterEach } from "vitest";
import { TwitterClient } from "../../src/social/twitter.js";

const config = {
  apiKey: "test-key",
  apiSecret: "test-secret",
  accessToken: "test-token",
  accessTokenSecret: "test-token-secret",
};

describe("TwitterClient", () => {
  const originalEnv = process.env["ADARIA_DRY_RUN"];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env["ADARIA_DRY_RUN"] = originalEnv;
    } else {
      delete process.env["ADARIA_DRY_RUN"];
    }
  });

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

  it("returns dry-run result when ADARIA_DRY_RUN=1", async () => {
    process.env["ADARIA_DRY_RUN"] = "1";
    const client = new TwitterClient(config);
    const result = await client.post({ text: "Test tweet" });
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.platform).toBe("twitter");
  });
});
