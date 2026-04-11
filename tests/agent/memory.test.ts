import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_HOME = path.join(
  os.tmpdir(),
  `adaria-test-memory-${String(process.pid)}-${Math.random().toString(36).slice(2, 8)}`,
);
process.env["ADARIA_HOME"] = TEST_HOME;

const {
  readUserMemory,
  writeUserMemory,
  appendUserMemory,
  appendHistory,
  readHistory,
  getRecentHistory,
  buildMemoryContext,
  resetMemory,
} = await import("../../src/agent/memory.js");
const { MEMORY_DIR } = await import("../../src/utils/paths.js");

describe("memory store", () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_HOME, { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(TEST_HOME, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    try {
      fs.rmSync(MEMORY_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
    await resetMemory();
  });

  describe("user memory", () => {
    it("returns empty string when MEMORY.md does not exist", async () => {
      expect(await readUserMemory()).toBe("");
    });

    it("writes and reads back verbatim", async () => {
      await writeUserMemory("line 1\nline 2");
      expect(await readUserMemory()).toBe("line 1\nline 2");
    });

    it("caps MEMORY.md at 200 lines on write", async () => {
      const lines = Array.from({ length: 250 }, (_, i) => `line ${String(i)}`);
      await writeUserMemory(lines.join("\n"));
      const read = await readUserMemory();
      expect(read.split("\n")).toHaveLength(200);
    });

    it("appendUserMemory adds to existing content", async () => {
      await writeUserMemory("first");
      await appendUserMemory("second");
      expect(await readUserMemory()).toBe("first\nsecond");
    });
  });

  describe("history", () => {
    it("returns empty when no entries exist for the day", async () => {
      expect(await readHistory()).toBe("");
    });

    it("appendHistory writes a timestamped line", async () => {
      await appendHistory("did a thing");
      const content = await readHistory();
      expect(content).toMatch(/- \d{2}:\d{2}( [AP]M)?: did a thing/);
    });

    it("getRecentHistory concatenates only days that have entries", async () => {
      await appendHistory("today's entry");
      const bundle = await getRecentHistory(3);
      expect(bundle).toContain("today's entry");
      expect(bundle).toMatch(/^### \d{4}-\d{2}-\d{2}/);
    });
  });

  describe("buildMemoryContext", () => {
    it("returns an empty string when nothing is stored", async () => {
      expect(await buildMemoryContext()).toBe("");
    });

    it("wraps user memory in <USER_PREFERENCES>", async () => {
      await writeUserMemory("prefer terse output");
      const ctx = await buildMemoryContext();
      expect(ctx).toContain("<USER_PREFERENCES>");
      expect(ctx).toContain("prefer terse output");
    });

    it("wraps history in <RECENT_HISTORY>", async () => {
      await appendHistory("built the daemon");
      const ctx = await buildMemoryContext();
      expect(ctx).toContain("<RECENT_HISTORY>");
      expect(ctx).toContain("built the daemon");
    });

    it("never mentions projects (project-scoped memory was dropped)", async () => {
      await writeUserMemory("anything");
      await appendHistory("anything");
      const ctx = await buildMemoryContext();
      expect(ctx).not.toContain("PROJECT_CONTEXT");
    });
  });
});
