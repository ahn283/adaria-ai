/**
 * Append-only audit log at $ADARIA_HOME/audit.jsonl.
 *
 * Every Claude invocation, skill dispatch, approval click, and user-facing
 * error should produce one entry. Secret patterns are masked before write.
 */
import fs from "node:fs/promises";
import { AUDIT_PATH } from "../utils/paths.js";

export interface AuditEntry {
  timestamp?: string;
  type: "command" | "execution" | "result" | "error" | "approval";
  userId?: string;
  platform?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

const SECRET_PATTERNS: RegExp[] = [
  /xoxb-[a-zA-Z0-9-]+/g, // Slack bot token
  /xapp-[a-zA-Z0-9-]+/g, // Slack app token
  /ntn_[a-zA-Z0-9]+/g, // Notion API key
  /sk-ant-[a-zA-Z0-9-]+/g, // Anthropic API key
  /sk-[a-zA-Z0-9]{20,}/g, // Generic API key
];

export function maskSecrets(text: string): string {
  let masked = text;
  for (const pattern of SECRET_PATTERNS) {
    masked = masked.replace(pattern, (match) => {
      if (match.length <= 8) return "***";
      return match.slice(0, 4) + "***" + match.slice(-4);
    });
  }
  return masked;
}

/**
 * Appends one JSON line to $ADARIA_HOME/audit.jsonl.
 * Creates the file with 0600 on first write; relies on ensureAdariaDir() to
 * have tightened $ADARIA_HOME to 0700 earlier in daemon startup.
 */
export async function writeAuditLog(
  entry: AuditEntry,
  shouldMask = true,
): Promise<void> {
  const record = {
    ...entry,
    content: shouldMask ? maskSecrets(entry.content) : entry.content,
    timestamp: entry.timestamp ?? new Date().toISOString(),
  };
  await fs.appendFile(AUDIT_PATH, JSON.stringify(record) + "\n", {
    mode: 0o600,
  });
}
