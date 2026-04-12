/**
 * Skill system types.
 *
 * Every Mode A command dispatches through a `Skill`. Skills are heavy,
 * may invoke collectors + Claude CLI + DB writes, and may produce
 * approval-gated actions. They are NOT exposed as MCP tools.
 */

import type Database from "better-sqlite3";
import type { AppConfig } from "../config/apps-schema.js";
import type { AdariaConfig } from "../config/schema.js";

/**
 * Shared context threaded into every skill dispatch. Constructed once
 * by `AgentCore` and reused across commands within the same daemon
 * lifecycle.
 */
export interface SkillContext {
  /** Initialized SQLite database handle. */
  db: Database.Database;
  /** Loaded apps from `apps.yaml`. */
  apps: AppConfig[];
  /** Full resolved adaria-ai config. */
  config: AdariaConfig;
  /**
   * Invoke Claude CLI with a prompt string. Returns the response text.
   * Skills call this for analysis generation (metadata proposal,
   * screenshot suggestions, etc.) rather than spawning Claude directly.
   */
  runClaude: (prompt: string) => Promise<string>;
}

/** Alert raised by a skill — surfaced in the weekly briefing. */
export interface SkillAlert {
  severity: "critical" | "high" | "medium" | "low";
  message: string;
}

/** Approval item that requires human confirmation before execution. */
export interface ApprovalItem {
  id: string;
  description: string;
  agent: string;
  payload?: unknown;
}

/**
 * Unified result returned by every skill dispatch.
 */
export interface SkillResult {
  /** Slack-formatted summary text (mrkdwn). */
  summary: string;
  /** Alerts for the weekly briefing / monitor threshold checks. */
  alerts: SkillAlert[];
  /** Approval items requiring human confirmation. */
  approvals: ApprovalItem[];
}
