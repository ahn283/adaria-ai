import { describe, it, expect, afterEach } from "vitest";
import { isDryRun, dryRunResult } from "../../src/social/base.js";

describe("isDryRun", () => {
  const originalEnv = process.env["ADARIA_DRY_RUN"];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env["ADARIA_DRY_RUN"] = originalEnv;
    } else {
      delete process.env["ADARIA_DRY_RUN"];
    }
  });

  it("returns true when ADARIA_DRY_RUN=1", () => {
    process.env["ADARIA_DRY_RUN"] = "1";
    expect(isDryRun()).toBe(true);
  });

  it("returns false when not set", () => {
    delete process.env["ADARIA_DRY_RUN"];
    expect(isDryRun()).toBe(false);
  });

  it("returns false for other values", () => {
    process.env["ADARIA_DRY_RUN"] = "0";
    expect(isDryRun()).toBe(false);
  });
});

describe("dryRunResult", () => {
  it("returns a synthetic success result", () => {
    const result = dryRunResult("twitter", { text: "test" });
    expect(result.success).toBe(true);
    expect(result.platform).toBe("twitter");
    expect(result.dryRun).toBe(true);
    expect(result.postId).toContain("dry-run-");
  });
});
