import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_HOME = path.join(
  os.tmpdir(),
  `adaria-test-logs-${String(process.pid)}-${Math.random().toString(36).slice(2, 8)}`,
);
process.env["ADARIA_HOME"] = TEST_HOME;

const { runLogs } = await import("../../src/cli/logs.js");
const { LOGS_DIR } = await import("../../src/utils/paths.js");

function writeLog(dateIso: string, body: string): string {
  const file = path.join(LOGS_DIR, `adaria-${dateIso}.log`);
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

describe("runLogs", () => {
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
      fs.rmSync(LOGS_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("prints today's log when it exists", async () => {
    const today = new Date().toISOString().slice(0, 10);
    writeLog(today, "line a\nline b\nline c\n");

    const captured: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        captured.push(args.map((a) => String(a)).join(" "));
      });
    await runLogs();
    spy.mockRestore();

    const output = captured.join("\n");
    expect(output).toContain("line a");
    expect(output).toContain("line c");
  });

  it("falls back to the newest log when today's is missing", async () => {
    writeLog("2026-01-01", "old day\n");
    writeLog("2026-02-15", "newer day\n");
    writeLog("2026-03-10", "newest day\n");

    const captured: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        captured.push(args.map((a) => String(a)).join(" "));
      });
    await runLogs();
    spy.mockRestore();

    const output = captured.join("\n");
    expect(output).toContain("newest day");
    expect(output).not.toContain("old day");
  });

  it("prints a friendly message when no adaria-*.log files exist", async () => {
    const captured: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        captured.push(args.map((a) => String(a)).join(" "));
      });
    await runLogs();
    spy.mockRestore();
    const output = captured.join("\n");
    expect(output).toMatch(/No log files found/);
  });
});
