import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate $ADARIA_HOME to a temp dir BEFORE importing logger (which reads
// LOGS_DIR at module load via paths.ts).
const TEST_HOME = path.join(
  os.tmpdir(),
  `adaria-test-${String(process.pid)}-${Math.random().toString(36).slice(2, 8)}`
);
process.env["ADARIA_HOME"] = TEST_HOME;

const {
  info,
  warn,
  debug,
  setLogLevel,
  generateCorrelationId,
  getCorrelationId,
  setCorrelationId,
  recordRequest,
  recordError,
  recordResponseTime,
  getMetrics,
} = await import("../../src/utils/logger.js");

const { LOGS_DIR } = await import("../../src/utils/paths.js");

function todayLogPath(): string {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_DIR, `adaria-${today}.log`);
}

function readLogLines(): string[] {
  try {
    return fs
      .readFileSync(todayLogPath(), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

describe("logger", () => {
  beforeAll(() => {
    // Ensure clean state
    try {
      fs.rmSync(TEST_HOME, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  afterAll(() => {
    try {
      fs.rmSync(TEST_HOME, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    setCorrelationId(undefined);
    setLogLevel("info");
  });

  it("writes log entries to file", () => {
    info("test message");
    expect(fs.existsSync(todayLogPath())).toBe(true);
    const content = fs.readFileSync(todayLogPath(), "utf-8");
    expect(content).toContain("test message");
  });

  it("writes JSON format with extra fields", () => {
    info("json test", { key: "value" });
    const lines = readLogLines();
    const last = JSON.parse(lines[lines.length - 1] ?? "{}") as {
      level?: string;
      message?: string;
      key?: string;
    };
    expect(last.level).toBe("info");
    expect(last.message).toBe("json test");
    expect(last.key).toBe("value");
  });

  it("includes correlation ID when set", () => {
    const id = generateCorrelationId();
    info("correlated message");
    const lines = readLogLines();
    const last = JSON.parse(lines[lines.length - 1] ?? "{}") as {
      correlationId?: string;
    };
    expect(last.correlationId).toBe(id);
  });

  it("respects log level filtering", () => {
    setLogLevel("warn");
    const before = readLogLines().length;
    debug("should be filtered");
    info("should be filtered");
    const after = readLogLines().length;
    expect(after).toBe(before);
    // Verify warn still goes through
    warn("should pass");
    expect(readLogLines().length).toBe(before + 1);
  });

  it("generates unique correlation IDs", () => {
    const id1 = generateCorrelationId();
    const id2 = generateCorrelationId();
    expect(id1).not.toBe(id2);
    expect(id1.startsWith("req-")).toBe(true);
  });

  it("setCorrelationId / getCorrelationId round-trip", () => {
    setCorrelationId(undefined);
    expect(getCorrelationId()).toBeUndefined();
    setCorrelationId("test-123");
    expect(getCorrelationId()).toBe("test-123");
  });
});

describe("logger metrics", () => {
  it("tracks request count and response time", () => {
    recordRequest();
    recordRequest();
    recordResponseTime(100);
    recordResponseTime(200);
    const m = getMetrics();
    expect(m.requestCount).toBeGreaterThanOrEqual(2);
    expect(m.avgResponseTimeMs).toBeGreaterThan(0);
  });

  it("tracks error count", () => {
    const before = getMetrics().errorCount;
    recordError();
    expect(getMetrics().errorCount).toBe(before + 1);
  });
});
