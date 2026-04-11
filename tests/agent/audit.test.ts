import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_HOME = path.join(
  os.tmpdir(),
  `adaria-test-audit-${String(process.pid)}-${Math.random().toString(36).slice(2, 8)}`,
);
process.env["ADARIA_HOME"] = TEST_HOME;

const { writeAuditLog, maskSecrets } = await import(
  "../../src/agent/audit.js"
);
const { AUDIT_PATH } = await import("../../src/utils/paths.js");

describe("audit log", () => {
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
      fs.rmSync(AUDIT_PATH, { force: true });
    } catch {
      // ignore
    }
  });

  describe("maskSecrets", () => {
    it("masks Slack bot tokens", () => {
      const masked = maskSecrets("token=xoxb-1234567890-abcdefghij");
      expect(masked).not.toContain("xoxb-1234567890-abcdefghij");
      expect(masked).toContain("***");
    });

    it("masks Anthropic API keys", () => {
      const masked = maskSecrets("sk-ant-api01-AAAAAAAAAAAAAAAAAAAAAAAA");
      expect(masked).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAA");
    });

    it("masks Notion API keys", () => {
      const masked = maskSecrets("ntn_0123456789abcdef0123456789abcdef");
      expect(masked).not.toContain("0123456789abcdef0123456789abcdef");
    });

    it("leaves ordinary text alone", () => {
      const plain = "the quick brown fox";
      expect(maskSecrets(plain)).toBe(plain);
    });
  });

  describe("writeAuditLog", () => {
    it("appends one JSON line per entry", async () => {
      await writeAuditLog({ type: "command", content: "first" });
      await writeAuditLog({ type: "execution", content: "second" });
      const lines = fs
        .readFileSync(AUDIT_PATH, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(lines).toHaveLength(2);
      const parsed = lines.map(
        (l) => JSON.parse(l) as { type: string; content: string },
      );
      expect(parsed[0]?.type).toBe("command");
      expect(parsed[1]?.type).toBe("execution");
    });

    it("masks secrets in content by default", async () => {
      await writeAuditLog({
        type: "command",
        content: "token=xoxb-1234567890-abcdefghij",
      });
      const record = JSON.parse(
        fs.readFileSync(AUDIT_PATH, "utf-8").trim(),
      ) as { content: string };
      expect(record.content).not.toContain("xoxb-1234567890-abcdefghij");
    });

    it("skips masking when shouldMask=false", async () => {
      await writeAuditLog(
        { type: "command", content: "xoxb-1234567890-abcdefghij" },
        false,
      );
      const record = JSON.parse(
        fs.readFileSync(AUDIT_PATH, "utf-8").trim(),
      ) as { content: string };
      expect(record.content).toBe("xoxb-1234567890-abcdefghij");
    });

    it("auto-populates timestamp when missing", async () => {
      await writeAuditLog({ type: "command", content: "hi" });
      const record = JSON.parse(
        fs.readFileSync(AUDIT_PATH, "utf-8").trim(),
      ) as { timestamp: string };
      expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});
