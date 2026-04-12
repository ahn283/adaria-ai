import { describe, it, expect, afterEach } from "vitest";
import { LinkedInClient } from "../../src/social/linkedin.js";

const config = {
  accessToken: "test-token",
  organizationId: "12345",
};

describe("LinkedInClient", () => {
  const originalEnv = process.env["ADARIA_DRY_RUN"];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env["ADARIA_DRY_RUN"] = originalEnv;
    } else {
      delete process.env["ADARIA_DRY_RUN"];
    }
  });

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

  it("returns dry-run result when ADARIA_DRY_RUN=1", async () => {
    process.env["ADARIA_DRY_RUN"] = "1";
    const client = new LinkedInClient(config);
    const result = await client.post({ text: "Professional update" });
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
  });
});
