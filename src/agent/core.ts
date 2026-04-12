/**
 * Agent core — message dispatch and Claude orchestration.
 *
 * Ports pilot-ai's `src/agent/core.ts` with the major trim called for in
 * the milestone checklist:
 *
 *   Drop: project resolver, md-based skills loader, project-scoped memory,
 *         Google/GitHub auth checks, OAuth token refresher, macOS
 *         permission watcher, preference detector, project analyzer,
 *         MCP install migrator, memory-command intercept, Anthropic API
 *         fallback path.
 *
 *   Keep: auth check, audit log, thinking reactions, status message
 *         evolution, session continuity, error differentiation,
 *         msg_too_long fallback, MCP context builder, tool-descriptions
 *         injection, MCP server health check.
 *
 * Added for adaria-ai:
 *
 *   - Mode A / Mode B split. A `SkillRegistry` is checked first; if a
 *     skill matches the first token of the message, it handles the
 *     dispatch directly and Claude is not invoked. Otherwise we fall
 *     through to Mode B, which is an MCP-tool-aware Claude CLI call
 *     (empty MCP tool set in M1, 4 marketing tools in M5.5).
 *   - `mcpManager` and `skillRegistry` are constructor-injectable so
 *     tests can pass mocks and M4/M5 can swap the M1 placeholder
 *     registry for real skills without touching core.ts.
 *   - `AdariaError` (not `PilotError`) for the error-differentiation path.
 */

import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { AdariaConfig } from "../config/schema.js";
import type { AppConfig } from "../config/apps-schema.js";
import type { SkillContext } from "../types/skill.js";
import type {
  IncomingMessage,
  MessengerAdapter,
} from "../messenger/adapter.js";
import { isAuthorizedUser } from "../security/auth.js";
import { wrapToolOutput } from "../security/prompt-guard.js";
import { writeAuditLog } from "./audit.js";
import { invokeClaudeCli, type ClaudeCliOptions } from "./claude.js";
import { ApprovalManager } from "./safety.js";
import { buildMemoryContext } from "./memory.js";
import { buildToolDescriptions } from "./tool-descriptions.js";
import { McpManager } from "./mcp-manager.js";
import {
  cleanupSessions,
  createSession,
  deleteSession,
  getRemainingTurns,
  getSession,
  touchSession,
} from "./session.js";
import {
  cleanupExpiredSummaries,
  getConversationSummaryText,
  updateConversationSummary,
} from "./conversation-summary.js";
import { AdariaError } from "../utils/errors.js";
import {
  error as logError,
  info as logInfo,
  warn as logWarn,
} from "../utils/logger.js";
import { createM1PlaceholderRegistry } from "../skills/index.js";
import type { SkillRegistry } from "../skills/index.js";

/**
 * Default Mode B system prompt. M5.5 will extend this to describe the
 * 4 marketing MCP tools; M1 keeps it minimal so plumbing verification
 * doesn't depend on tool-specific behavior.
 */
const DEFAULT_SYSTEM_PROMPT =
  "You are adaria-ai, a marketing operations assistant for a small team. Answer the user's question concisely. You have NO write access in conversation mode — do not promise to publish posts, change app metadata, or reply to user reviews. If the user asks for those, tell them to run the corresponding skill command.";

const THINKING_THROTTLE_MS = 5_000;
const MODE_B_MAX_TURNS = 25;

export interface AgentCoreOptions {
  mcpManager?: McpManager;
  skillRegistry?: SkillRegistry;
  /** Initialized SQLite database. Required for Mode A skill dispatch (M4+). */
  db?: Database.Database;
  /** Loaded apps from apps.yaml. Required for Mode A skill dispatch (M4+). */
  apps?: AppConfig[];
}

export class AgentCore {
  private readonly messenger: MessengerAdapter;
  private readonly config: AdariaConfig;
  private readonly approvalManager: ApprovalManager;
  private readonly mcpManager: McpManager;
  private readonly skillRegistry: SkillRegistry;
  private readonly db: Database.Database | undefined;
  private readonly apps: AppConfig[];

  constructor(
    messenger: MessengerAdapter,
    config: AdariaConfig,
    options: AgentCoreOptions = {},
  ) {
    this.messenger = messenger;
    this.config = config;
    this.approvalManager = new ApprovalManager();
    this.mcpManager = options.mcpManager ?? new McpManager();
    this.skillRegistry =
      options.skillRegistry ?? createM1PlaceholderRegistry();
    this.db = options.db;
    this.apps = options.apps ?? [];

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.messenger.onMessage((msg) => this.handleMessage(msg));
    this.messenger.onApproval((taskId, approved) => {
      this.approvalManager.handleResponse(taskId, approved);
    });
  }

  async start(): Promise<void> {
    logInfo("Connecting to messenger...");
    await this.messenger.start();
    logInfo("Messenger connected. Waiting for messages...");

    // MCP health summary. M1 returns an empty array; M5.5 actually probes
    // the bundled tool host.
    const mcpStatuses = await this.mcpManager.checkMcpServerHealth();
    if (mcpStatuses.length > 0) {
      const summary = mcpStatuses
        .map((s) => `${s.serverId}(${s.status})`)
        .join(", ");
      logInfo(`MCP servers: ${summary}`);
    }
  }

  async stop(): Promise<void> {
    this.approvalManager.shutdown();
    logInfo("Stopping messenger...");
    await this.messenger.stop();
  }

  /** Exposed for M1 wiring tests and for the CLI daemon to seed skills. */
  getSkillRegistry(): SkillRegistry {
    return this.skillRegistry;
  }

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    try {
      logInfo(
        `Message from ${msg.platform}:${msg.userId} in ${msg.channelId}: "${msg.text.slice(0, 120)}"`,
      );

      // 1. Auth check. Non-allowlisted users get silently ignored to avoid
      //    leaking the bot's existence.
      if (!isAuthorizedUser(msg, this.config)) {
        logInfo(`BLOCKED: user ${msg.userId} is not in allowedUsers`);
        await writeAuditLog({
          type: "command",
          userId: msg.userId,
          platform: msg.platform,
          content: `[BLOCKED] ${msg.text}`,
        });
        return;
      }

      // 2. Audit the incoming command.
      await writeAuditLog({
        type: "command",
        userId: msg.userId,
        platform: msg.platform,
        content: msg.text,
      });

      // 3. Status message + thinking reaction.
      //    Reactions *only* attach to the originating event's ts — not
      //    the thread root. Falling back to `threadId` (pilot-ai's original
      //    behavior) would attach the 🤔/⚙️/✅ sequence to someone else's
      //    message in the thread (e.g. a prior briefing). We accept the
      //    no-reaction degradation when `eventTs` is missing — synthetic
      //    messages (approval button callbacks, cron) won't show reactions
      //    at all, which is correct (M1 core review HIGH #2).
      const eventTs = msg.eventTs;
      if (eventTs) {
        await this.messenger.addReaction?.(
          msg.channelId,
          eventTs,
          "thinking_face",
        );
      }
      const statusMsgId = await this.messenger.sendText(
        msg.channelId,
        "🤔 Thinking...",
        msg.threadId,
      );

      try {
        if (eventTs) {
          await this.messenger.removeReaction?.(
            msg.channelId,
            eventTs,
            "thinking_face",
          );
          await this.messenger.addReaction?.(
            msg.channelId,
            eventTs,
            "gear",
          );
        }

        // 4. Mode A: skill registry dispatch.
        //    Mode B: fall through to Claude CLI.
        const skill = this.skillRegistry.findSkill(msg.text);
        let response: string;
        if (skill) {
          logInfo(`Mode A: dispatching to skill "${skill.name}"`);
          const skillCtx = this.buildSkillContext();
          // When db is not available (M1 placeholder path), pass a
          // minimal stub context so placeholder skills can still return
          // their "not implemented" message.
          const stubCtx: SkillContext = skillCtx ?? {
            db: undefined as never,
            apps: [],
            config: this.config,
            runClaude: () => Promise.resolve(""),
          };
          const result = await skill.dispatch(stubCtx, msg.text);
          response = result.summary;
        } else {
          logInfo("Mode B: falling through to Claude CLI");
          response = await this.invokeClaudeWithContext(
            msg,
            async (status) => {
              try {
                await this.messenger.updateText(
                  msg.channelId,
                  statusMsgId,
                  status,
                  msg.threadId,
                );
              } catch {
                // Ignore update failures — message may have been deleted.
              }
            },
          );
        }

        if (eventTs) {
          await this.messenger.removeReaction?.(
            msg.channelId,
            eventTs,
            "gear",
          );
          await this.messenger.addReaction?.(
            msg.channelId,
            eventTs,
            "white_check_mark",
          );
        }

        await this.messenger.updateText(
          msg.channelId,
          statusMsgId,
          response,
          msg.threadId,
        );

        await writeAuditLog({
          type: "result",
          userId: msg.userId,
          platform: msg.platform,
          content: response,
        });
      } catch (err) {
        await this.handleDispatchError(msg, statusMsgId, eventTs, err);
      }
    } catch (err) {
      logError(
        `FATAL error in handleMessage: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }`,
      );
    }
  }

  private async handleDispatchError(
    msg: IncomingMessage,
    statusMsgId: string,
    eventTs: string | undefined,
    err: unknown,
  ): Promise<void> {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logError(`Dispatch error: ${errorMsg}`);

    if (eventTs) {
      await this.messenger.removeReaction?.(msg.channelId, eventTs, "gear");
      await this.messenger.addReaction?.(msg.channelId, eventTs, "x");
    }

    let displayMsg: string;
    if (errorMsg.includes("msg_too_long")) {
      // The fallback inside invokeClaudeWithContext already tried. If we
      // still end up here, the retry also failed — nuke the session as a
      // last resort so the next message starts fresh.
      const threadId = msg.threadId ?? `dm-${String(Date.now())}`;
      await deleteSession(msg.platform, msg.channelId, threadId);
      displayMsg =
        "❌ Conversation too long. Session has been reset — please send your message again.";
    } else if (err instanceof AdariaError) {
      displayMsg = `❌ ${err.userMessage}`;
    } else {
      displayMsg = `❌ Error: ${errorMsg}`;
    }

    try {
      await this.messenger.updateText(
        msg.channelId,
        statusMsgId,
        displayMsg,
        msg.threadId,
      );
    } catch {
      // Best-effort — if the status message is gone, there's nowhere to
      // post the error. The audit log still captures it below.
    }

    await writeAuditLog({
      type: "error",
      userId: msg.userId,
      platform: msg.platform,
      content: errorMsg,
    });
  }

  /**
   * Mode B path: build system prompt, manage session continuity, call
   * Claude CLI, handle msg_too_long fallback, persist conversation summary.
   */
  private async invokeClaudeWithContext(
    msg: IncomingMessage,
    onStatus?: (status: string) => Promise<void>,
  ): Promise<string> {
    const baseSystemPrompt = await this.buildBaseSystemPrompt();

    await onStatus?.("⚙️ Processing...");

    // Session continuity.
    const threadId = msg.threadId ?? `dm-${String(Date.now())}`;
    const existingSession = await getSession(
      msg.platform,
      msg.channelId,
      threadId,
    );

    let sessionId: string | undefined;
    let resumeSessionId: string | undefined;

    if (existingSession) {
      resumeSessionId = existingSession.sessionId;
      await touchSession(msg.platform, msg.channelId, threadId);
      logInfo(
        `Resuming session ${resumeSessionId} (turn ${String(existingSession.turnCount + 1)})`,
      );
    } else {
      const session = await createSession(
        msg.platform,
        msg.channelId,
        threadId,
      );
      sessionId = session.sessionId;
      logInfo(`New session ${sessionId}`);
    }

    // Conversation summary for msg_too_long fallback + new-session injection.
    const conversationSummaryText = await getConversationSummaryText(
      msg.platform,
      msg.channelId,
      threadId,
    );

    // Near-limit session warning gets appended to the system prompt.
    const systemParts = [baseSystemPrompt];
    if (existingSession) {
      const remaining = getRemainingTurns(existingSession);
      if (remaining <= 3) {
        systemParts.push(
          `⚠️ Session context is running low (${String(remaining)} turns remaining). Be extra concise. Summarize outputs instead of showing full content.`,
        );
      }
    }
    const systemPrompt = systemParts.join("\n\n");

    // For new sessions with prior conversation, inject summary. Wrap in
    // prompt-guard tags: Mode B lets untrusted text from Slack users (and,
    // once M5.5 lands, from external review content) back into Claude's
    // context, so the history must arrive clearly marked as data rather
    // than instructions (M1 core review MED #4).
    const fullSystemPrompt =
      !resumeSessionId && conversationSummaryText
        ? `${systemPrompt}\n\n${wrapToolOutput(conversationSummaryText, "conversation-history")}`
        : systemPrompt;

    // Non-blocking housekeeping. Failures are logged at warn but not
    // re-thrown; they must never block a message round-trip.
    cleanupSessions().catch((err: unknown) => {
      logWarn(
        `cleanupSessions failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    cleanupExpiredSummaries().catch((err: unknown) => {
      logWarn(
        `cleanupExpiredSummaries failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    // MCP config is null when no tools are registered (M1), which is the
    // signal to skip --mcp-config entirely.
    const mcpConfigPath = (await this.mcpManager.writeMcpConfig()) ?? undefined;
    logInfo(`MCP config: ${mcpConfigPath ?? "none"}`);

    const thinking = this.createThinkingHandler(onStatus);

    const onToolUseForwarder = (status: string): void => {
      onStatus?.(status).catch(() => {
        /* ignore */
      });
    };

    try {
      const primaryCall: ClaudeCliOptions = {
        prompt: msg.text,
        cliBinary: this.config.claude.cliBinary,
        timeoutMs: this.config.claude.timeoutMs,
        onToolUse: onToolUseForwarder,
        maxTurns: MODE_B_MAX_TURNS,
      };
      if (!resumeSessionId) primaryCall.systemPrompt = fullSystemPrompt;
      if (mcpConfigPath) primaryCall.mcpConfigPath = mcpConfigPath;
      if (thinking.handler) primaryCall.onThinking = thinking.handler;
      if (sessionId) primaryCall.sessionId = sessionId;
      if (resumeSessionId) primaryCall.resumeSessionId = resumeSessionId;

      const result = await invokeClaudeCli(primaryCall);

      // Persist rolling summary (non-blocking).
      updateConversationSummary(
        msg.platform,
        msg.channelId,
        threadId,
        msg.text,
        result.result,
      ).catch((err: unknown) => {
        logWarn(
          `updateConversationSummary failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      return result.result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (!errorMsg.includes("msg_too_long")) throw err;

      // msg_too_long fallback: fresh session with injected summary.
      logInfo(
        `msg_too_long: fresh session for ${threadId} (summary: ${conversationSummaryText ? "yes" : "no"})`,
      );
      await deleteSession(msg.platform, msg.channelId, threadId);

      const fallbackSystemPrompt = conversationSummaryText
        ? `${systemPrompt}\n\n${wrapToolOutput(conversationSummaryText, "conversation-history")}`
        : systemPrompt;

      thinking.reset();

      // Pre-generate the retry session UUID so Claude and our session
      // store stay in lock-step. The old pilot-ai pattern let Claude
      // invent its own UUID here, then stored an unrelated one in
      // `createSession()`, which made the next message `--resume` a
      // UUID Claude had never seen (M1 core review HIGH #1).
      const retrySessionId = crypto.randomUUID();

      const retryCall: ClaudeCliOptions = {
        prompt: msg.text,
        systemPrompt: fallbackSystemPrompt,
        cliBinary: this.config.claude.cliBinary,
        timeoutMs: this.config.claude.timeoutMs,
        onToolUse: onToolUseForwarder,
        sessionId: retrySessionId,
        maxTurns: MODE_B_MAX_TURNS,
      };
      if (mcpConfigPath) retryCall.mcpConfigPath = mcpConfigPath;
      if (thinking.handler) retryCall.onThinking = thinking.handler;

      const retryResult = await invokeClaudeCli(retryCall);

      // Fresh session for subsequent messages — explicit UUID matches
      // the one Claude just used above.
      await createSession(
        msg.platform,
        msg.channelId,
        threadId,
        retrySessionId,
      );

      updateConversationSummary(
        msg.platform,
        msg.channelId,
        threadId,
        msg.text,
        retryResult.result,
      ).catch((err: unknown) => {
        logWarn(
          `updateConversationSummary (retry) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      return retryResult.result;
    }
  }

  private async buildBaseSystemPrompt(): Promise<string> {
    const parts: string[] = [DEFAULT_SYSTEM_PROMPT];

    const mcpContext = this.mcpManager.buildMcpContext();
    if (mcpContext) parts.push(mcpContext);

    const memoryContext = await buildMemoryContext();
    if (memoryContext) parts.push(memoryContext.slice(0, 2000));

    const toolDescriptions = buildToolDescriptions();
    if (toolDescriptions) parts.push(toolDescriptions.slice(0, 1000));

    return parts.join("\n\n");
  }

  /**
   * Build the SkillContext for Mode A dispatch. Returns `null` if the
   * database is not initialized (M1 placeholder path — skills still
   * receive a minimal context with a stub `runClaude`).
   */
  private buildSkillContext(): SkillContext | null {
    if (!this.db) return null;

    return {
      db: this.db,
      apps: this.apps,
      config: this.config,
      runClaude: async (prompt: string): Promise<string> => {
        await writeAuditLog({
          type: "command",
          userId: "skill",
          platform: "internal",
          content: `[skill-claude] ${prompt.slice(0, 200)}`,
        });
        const result = await invokeClaudeCli({
          prompt,
          cliBinary: this.config.claude.cliBinary,
          timeoutMs: this.config.claude.timeoutMs,
        });
        await writeAuditLog({
          type: "result",
          userId: "skill",
          platform: "internal",
          content: `[skill-claude] ${result.result.slice(0, 500)}`,
        });
        return result.result;
      },
    };
  }

  private createThinkingHandler(
    onStatus?: (status: string) => Promise<void>,
  ): {
    handler: ((text: string) => void) | undefined;
    reset: () => void;
  } {
    if (this.config.agent.showThinking === false) {
      return { handler: undefined, reset: () => undefined };
    }

    let lastReport = 0;
    let buffer = "";

    const handler = (text: string): void => {
      buffer += text;
      const now = Date.now();
      if (now - lastReport > THINKING_THROTTLE_MS && buffer.length > 0) {
        const snippet = buffer.length > 200 ? buffer.slice(-200) + "..." : buffer;
        onStatus?.(`💭 ${snippet}`).catch(() => {
          /* ignore */
        });
        buffer = "";
        lastReport = now;
      }
    };

    return {
      handler,
      reset: () => {
        buffer = "";
        lastReport = 0;
      },
    };
  }
}
