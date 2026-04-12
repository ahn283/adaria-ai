import { describe, it, expect, afterEach } from "vitest";
import { YouTubeClient } from "../../src/social/youtube.js";

const config = { accessToken: "tok", channelId: "UC123" };

describe("YouTubeClient", () => {
  const originalEnv = process.env["ADARIA_DRY_RUN"];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env["ADARIA_DRY_RUN"] = originalEnv;
    } else {
      delete process.env["ADARIA_DRY_RUN"];
    }
  });

  it("validates 5000 char limit", () => {
    const client = new YouTubeClient(config);
    expect(client.validateContent("Community post").valid).toBe(true);
    expect(client.validateContent("x".repeat(5001)).valid).toBe(false);
  });

  it("returns dry-run result", async () => {
    process.env["ADARIA_DRY_RUN"] = "1";
    const client = new YouTubeClient(config);
    const result = await client.post({ text: "YouTube community post" });
    expect(result.dryRun).toBe(true);
  });
});
