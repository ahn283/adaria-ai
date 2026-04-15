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
  /**
   * Optional — download an inbound file attachment to an absolute path.
   * Only set when the runtime messenger supports it (Slack w/
   * `files:read`). BrandSkill guards with `if (ctx.downloadFile)` so
   * skills that don't need file IO stay unaffected.
   */
  downloadFile?: (
    attachment: {
      url: string;
      mimeType: string;
      filename?: string;
      authHeader?: string;
    },
    destPath: string,
  ) => Promise<void>;
  /**
   * Optional — identifies the originating Slack user and thread for
   * multi-turn skills that need to persist flow state. Set by core.ts
   * immediately before every dispatch. One-shot skills ignore this
   * field; it is kept optional so the existing 8 skills need no
   * signature change.
   */
  flowContext?: {
    userId: string;
    threadKey: string;
  };
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
 * Continuation signalled by a multi-turn skill (M6.7 BrandSkill, and any
 * future flow-based skill). When `SkillResult.continuation` is present,
 * `core.ts` persists the flow state and posts `prompt` as a follow-up
 * Slack message; the next user reply in the same thread re-enters the
 * skill via `Skill.continueFlow` instead of re-parsing a command.
 */
export interface SkillContinuation {
  /** Extensible marker for future multi-turn skills. */
  flowKind: "brand";
  /** ULID / opaque id owned by the skill. */
  flowId: string;
  /** Scopes the persistent flow row to (userId, threadKey). */
  userId: string;
  threadKey: string;
  /** Directory-safe service identifier; `null` until resolved. */
  serviceId: string | null;
  /** Machine-readable state — skill decides the alphabet. */
  state: string;
  /** JSON-serialisable accumulated flow data. */
  data: Record<string, unknown>;
  /** Whether the skill expects a text reply, a file, or either. */
  expects: "text" | "file" | "either";
  /** Prompt to post back to Slack. Empty string skips the post. */
  prompt: string;
}

/**
 * Inbound message shape passed to `Skill.continueFlow`. Files are the
 * same `ImageAttachment` shape the messenger forwards; the skill may
 * call `ctx.messenger.downloadImage(attachment, destPath)` to persist.
 */
export interface ContinuationMessage {
  text: string;
  /**
   * Attached files (png/jpg/webp). Present only when the user attached
   * something. Same wire type as `IncomingMessage.images` to avoid a
   * duplicate interface.
   */
  files: ReadonlyArray<{
    url: string;
    mimeType: string;
    filename?: string;
    authHeader?: string;
  }>;
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
  /** Set when the skill wants another turn from the user. */
  continuation?: SkillContinuation;
}

/**
 * Skills with approval-gated write paths implement this interface.
 * `core.ts` calls `executePost` when an approval button is clicked.
 */
export interface ExecutableSkill {
  executePost(ctx: SkillContext, payload: unknown): Promise<void>;
}
