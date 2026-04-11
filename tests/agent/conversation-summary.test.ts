import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_HOME = path.join(
  os.tmpdir(),
  `adaria-test-convsum-${String(process.pid)}-${Math.random().toString(36).slice(2, 8)}`,
);
process.env["ADARIA_HOME"] = TEST_HOME;

const {
  loadSummary,
  saveSummary,
  updateConversationSummary,
  getConversationSummaryText,
  extractActionSummary,
  extractModifiedFiles,
  extractKeyDecisions,
  cleanupExpiredSummaries,
} = await import("../../src/agent/conversation-summary.js");
const { CONVERSATIONS_DIR } = await import("../../src/utils/paths.js");

describe("conversation-summary", () => {
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

  beforeEach(() => {
    try {
      fs.rmSync(CONVERSATIONS_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("extraction helpers", () => {
    it("extractActionSummary joins first paragraph + status lines", () => {
      const out = extractActionSummary(
        "Fixed the build.\n\nSome filler here.\n\n✅ lint passes",
      );
      expect(out).toContain("Fixed the build");
      expect(out).toContain("✅ lint passes");
    });

    it("extractModifiedFiles picks up 'Writing src/foo.ts'", () => {
      const out = extractModifiedFiles(
        "Writing src/foo.ts\nModifying lib/bar.ts",
      );
      expect(out).toEqual(expect.arrayContaining(["src/foo.ts", "lib/bar.ts"]));
    });

    it("extractModifiedFiles excludes URLs", () => {
      const out = extractModifiedFiles("saved https://example.com/path.html");
      expect(out).toHaveLength(0);
    });

    it("extractKeyDecisions picks up commit-style lines", () => {
      const out = extractKeyDecisions(
        "commit abc1234 — fix: guard against null config",
      );
      expect(out.some((d) => d.includes("guard against null config"))).toBe(
        true,
      );
    });
  });

  describe("load/save", () => {
    it("returns null for unknown thread", async () => {
      expect(await loadSummary("slack", "C1", "T1")).toBeNull();
    });

    it("saveSummary + loadSummary round-trips", async () => {
      await saveSummary({
        threadKey: "slack:C1:T1",
        turns: [
          {
            userMessage: "hi",
            agentAction: "responded",
            timestamp: new Date().toISOString(),
          },
        ],
        keyDecisions: [],
        modifiedFiles: [],
        lastUpdated: new Date().toISOString(),
      });
      const loaded = await loadSummary("slack", "C1", "T1");
      expect(loaded?.turns).toHaveLength(1);
    });
  });

  describe("updateConversationSummary", () => {
    it("creates a new summary on first call and caps turns at 15", async () => {
      for (let i = 0; i < 20; i++) {
        await updateConversationSummary(
          "slack",
          "C1",
          "T1",
          `user ${String(i)}`,
          `agent reply ${String(i)}`,
        );
      }
      const loaded = await loadSummary("slack", "C1", "T1");
      expect(loaded?.turns).toHaveLength(15);
    });

    it("masks secrets in both user message and agent response", async () => {
      await updateConversationSummary(
        "slack",
        "C1",
        "T2",
        "here is my slack token xoxb-1234567890-abcdefghij",
        "I received sk-ant-api01-AAAAAAAAAAAAAAAAAAAAAAAA from you",
      );
      const loaded = await loadSummary("slack", "C1", "T2");
      const serialized = JSON.stringify(loaded);
      expect(serialized).not.toContain("xoxb-1234567890-abcdefghij");
      expect(serialized).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAA");
    });

    it("never stores projectPath (project-scoped memory dropped)", async () => {
      await updateConversationSummary("slack", "C1", "T3", "hi", "hello");
      const loaded = await loadSummary("slack", "C1", "T3");
      expect(loaded).not.toHaveProperty("projectPath");
    });
  });

  describe("getConversationSummaryText", () => {
    it("returns null when no turns exist", async () => {
      expect(await getConversationSummaryText("slack", "C1", "none")).toBeNull();
    });

    it("renders turns, files, and decisions into a readable block", async () => {
      await updateConversationSummary(
        "slack",
        "C1",
        "T1",
        "please fix it",
        "Writing src/foo.ts\n✅ Fixed the thing\ncommit abcdef1 — fix: resolve null",
      );
      const text = await getConversationSummaryText("slack", "C1", "T1");
      expect(text).toContain("Previous conversation");
      expect(text).toContain("Modified files");
      expect(text).toContain("src/foo.ts");
      expect(text).toContain("Key decisions");
    });
  });

  describe("cleanupExpiredSummaries", () => {
    it("removes files older than the 48h TTL", async () => {
      await saveSummary({
        threadKey: "slack:C1:old",
        turns: [],
        keyDecisions: [],
        modifiedFiles: [],
        lastUpdated: new Date(
          Date.now() - 72 * 60 * 60 * 1000,
        ).toISOString(),
      });
      await saveSummary({
        threadKey: "slack:C1:new",
        turns: [],
        keyDecisions: [],
        modifiedFiles: [],
        lastUpdated: new Date().toISOString(),
      });
      const removed = await cleanupExpiredSummaries();
      expect(removed).toBe(1);
      const remaining = fs
        .readdirSync(CONVERSATIONS_DIR)
        .filter((f) => f.endsWith(".json"));
      expect(remaining).toHaveLength(1);
    });
  });
});
