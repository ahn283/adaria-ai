import { describe, it, expect, afterEach } from "vitest";
import { ThreadsClient } from "../../src/social/threads.js";

const config = { accessToken: "test-token", userId: "test-user" };

describe("ThreadsClient", () => {
  const originalEnv = process.env["ADARIA_DRY_RUN"];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env["ADARIA_DRY_RUN"] = originalEnv;
    } else {
      delete process.env["ADARIA_DRY_RUN"];
    }
  });

  it("validates 500 char limit", () => {
    const client = new ThreadsClient(config);
    expect(client.validateContent("Hello Threads!").valid).toBe(true);
  });

  it("rejects text exceeding 500 chars", () => {
    const client = new ThreadsClient(config);
    expect(client.validateContent("x".repeat(501)).valid).toBe(false);
  });

  it("returns dry-run result", async () => {
    process.env["ADARIA_DRY_RUN"] = "1";
    const client = new ThreadsClient(config);
    const result = await client.post({ text: "Threads post" });
    expect(result.dryRun).toBe(true);
  });
});
