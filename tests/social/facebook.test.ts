import { describe, it, expect, afterEach } from "vitest";
import { FacebookClient } from "../../src/social/facebook.js";

const config = {
  appId: "test-app-id",
  appSecret: "test-app-secret",
  accessToken: "test-token",
  pageId: "test-page-id",
};

describe("FacebookClient", () => {
  const originalEnv = process.env["ADARIA_DRY_RUN"];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env["ADARIA_DRY_RUN"] = originalEnv;
    } else {
      delete process.env["ADARIA_DRY_RUN"];
    }
  });

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

  it("returns dry-run result when ADARIA_DRY_RUN=1", async () => {
    process.env["ADARIA_DRY_RUN"] = "1";
    const client = new FacebookClient(config);
    const result = await client.post({ text: "Test post" });
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.platform).toBe("facebook");
  });
});
