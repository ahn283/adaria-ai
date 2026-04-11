/**
 * Structured JSON logger with correlation IDs, log levels, and file output.
 * Writes to $ADARIA_HOME/logs/adaria-YYYY-MM-DD.log.
 */
import fs from "node:fs";
import path from "node:path";
import { LOGS_DIR } from "./paths.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  correlationId?: string | undefined;
  [key: string]: unknown;
}

let currentCorrelationId: string | undefined;
let minLevel: LogLevel = "info";

const metrics = {
  requestCount: 0,
  errorCount: 0,
  totalResponseTimeMs: 0,
};

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function setCorrelationId(id: string | undefined): void {
  currentCorrelationId = id;
}

export function generateCorrelationId(): string {
  const id = `req-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
  currentCorrelationId = id;
  return id;
}

export function getCorrelationId(): string | undefined {
  return currentCorrelationId;
}

function getLogFilePath(): string {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_DIR, `adaria-${today}.log`);
}

function writeLog(entry: LogEntry): void {
  if (LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY[minLevel]) return;

  const line = JSON.stringify(entry);

  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(getLogFilePath(), line + "\n");
  } catch {
    // Best-effort logging — do not crash the caller
  }

  if (entry.level === "error") {
    console.error(`[${entry.timestamp}] ERROR: ${entry.message}`);
  }
}

export function log(
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>
): void {
  writeLog({
    timestamp: new Date().toISOString(),
    level,
    message,
    correlationId: currentCorrelationId,
    ...extra,
  });
}

export function debug(
  message: string,
  extra?: Record<string, unknown>
): void {
  log("debug", message, extra);
}

export function info(
  message: string,
  extra?: Record<string, unknown>
): void {
  log("info", message, extra);
}

export function warn(
  message: string,
  extra?: Record<string, unknown>
): void {
  log("warn", message, extra);
}

export function error(
  message: string,
  extra?: Record<string, unknown>
): void {
  log("error", message, extra);
}

export function recordRequest(): void {
  metrics.requestCount++;
}

export function recordError(): void {
  metrics.errorCount++;
}

export function recordResponseTime(ms: number): void {
  metrics.totalResponseTimeMs += ms;
}

export function getMetrics(): {
  requestCount: number;
  errorCount: number;
  avgResponseTimeMs: number;
} {
  return {
    requestCount: metrics.requestCount,
    errorCount: metrics.errorCount,
    avgResponseTimeMs:
      metrics.requestCount > 0
        ? Math.round(metrics.totalResponseTimeMs / metrics.requestCount)
        : 0,
  };
}
