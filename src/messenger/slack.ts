/**
 * Slack adapter — Socket Mode + Bolt.
 *
 * Ports pilot-ai's `SlackAdapter` with the adaria-ai adjustments called
 * for in the porting matrix and the messenger interface review:
 *
 *   1. `eventTs` field is populated on every outbound `IncomingMessage`.
 *      pilot-ai only set `threadId`, which forced `core.ts` to fall back
 *      to the thread root for reactions — the growth-agent Phase 1 bug
 *      that motivated adding `eventTs` to the adapter interface in the
 *      first place.
 *   2. Telegram is dropped (adaria-ai is Slack-only in v1).
 *   3. `console.log`/`console.error` are replaced with the adaria-ai
 *      structured logger so launchd's combined `stderr` file remains
 *      readable.
 *   4. Bot token is no longer stashed on the instance — we pull it from
 *      config at construction time only, so there's no long-lived
 *      reference to it outside the Bolt client.
 */
import { App, type LogLevel } from "@slack/bolt";
import type {
  ImageAttachment,
  IncomingMessage,
  MessengerAdapter,
} from "./adapter.js";
import { splitMessage, MAX_MESSAGE_LENGTH } from "./split.js";
import { RateLimiter } from "../utils/rate-limiter.js";
import {
  debug as logDebug,
  info as logInfo,
  error as logError,
} from "../utils/logger.js";

export interface SlackAdapterConfig {
  botToken: string;
  appToken: string;
  signingSecret: string;
}

/** Upper bound on the dedup Set before we trim it in half. */
const DEDUP_HIGH_WATER_MARK = 1000;
const DEDUP_TRIM_TO = 500;

export class SlackAdapter implements MessengerAdapter {
  private readonly app: App;
  private readonly botToken: string;
  private messageHandler?: (msg: IncomingMessage) => void | Promise<void>;
  private approvalHandler?: (taskId: string, approved: boolean) => void;
  // Slack tier 2 "posting" API allows roughly 1 message per second to a
  // given channel; 5 is a reasonable burst before back-pressure.
  private readonly rateLimiter = new RateLimiter(5, 1);
  // Dedup across `message` and `app_mention` — Slack delivers both for a
  // channel mention, and we only want to process each `ts` once.
  private processedMessages = new Set<string>();

  constructor(config: SlackAdapterConfig) {
    this.botToken = config.botToken;
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      signingSecret: config.signingSecret,
      socketMode: true,
      logLevel: "INFO" as LogLevel,
    });

    this.app.error((err) => {
      logError(
        `Slack unhandled error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return Promise.resolve();
    });

    this.setupListeners();
  }

  /** Returns true if `ts` has been seen before (i.e. is a dupe). */
  private isDuplicate(ts: string): boolean {
    if (!ts) return false;
    if (this.processedMessages.has(ts)) return true;
    this.processedMessages.add(ts);
    if (this.processedMessages.size > DEDUP_HIGH_WATER_MARK) {
      const entries = [...this.processedMessages];
      this.processedMessages = new Set(entries.slice(-DEDUP_TRIM_TO));
    }
    return false;
  }

  private setupListeners(): void {
    this.app.message(({ message }) => {
      const handler = this.messageHandler;
      if (!handler) return Promise.resolve();

      // Only plain messages and file-share wrappers. Bot messages,
      // channel_join, edits, etc. are subtyped and get ignored.
      const subtype = (message as { subtype?: string }).subtype;
      if (subtype && subtype !== "file_share") {
        return Promise.resolve();
      }

      const msg = message as {
        user?: string;
        channel?: string;
        thread_ts?: string;
        text?: string;
        ts?: string;
        files?: Array<{
          url_private: string;
          mimetype: string;
          name: string;
        }>;
      };
      if (!msg.user) return Promise.resolve();
      if (!msg.text && !msg.files?.length) return Promise.resolve();

      const eventTs = msg.ts ?? "";
      if (this.isDuplicate(eventTs)) return Promise.resolve();

      const images = this.extractImages(msg.files);

      // file_share events with no text and no image attachments (e.g. a
      // PDF drop) would otherwise reach core.ts as a mention with an
      // empty prompt, triggering the full Thinking → Claude pipeline on
      // a zero-byte query (M1 messenger review MED #1).
      if (!msg.text && images.length === 0) return Promise.resolve();

      const incoming: IncomingMessage = {
        platform: "slack",
        userId: msg.user,
        channelId: msg.channel ?? "",
        text: msg.text ?? "",
        eventTs,
        timestamp: new Date(parseFloat(eventTs || "0") * 1000),
      };
      const threadId = msg.thread_ts ?? eventTs;
      if (threadId) incoming.threadId = threadId;
      if (images.length > 0) incoming.images = images;

      return Promise.resolve(handler(incoming));
    });

    this.app.event("app_mention", ({ event }) => {
      const handler = this.messageHandler;
      if (!handler) return Promise.resolve();

      if (this.isDuplicate(event.ts)) return Promise.resolve();

      // Strip the `<@BOT_ID>` prefix from the mention text.
      const text = (event.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
      if (!text || !event.user) return Promise.resolve();

      const eventTs = event.ts;
      const incoming: IncomingMessage = {
        platform: "slack",
        userId: event.user,
        channelId: event.channel,
        text,
        eventTs,
        timestamp: new Date(parseFloat(eventTs) * 1000),
      };
      const threadId = event.thread_ts ?? eventTs;
      if (threadId) incoming.threadId = threadId;

      return Promise.resolve(handler(incoming));
    });

    this.app.action("approve_task", ({ action, ack }) => {
      return ack().then(() => {
        const handler = this.approvalHandler;
        if (!handler) return;
        const value = (action as { value?: string }).value;
        if (value) handler(value, true);
      });
    });

    this.app.action("reject_task", ({ action, ack }) => {
      return ack().then(() => {
        const handler = this.approvalHandler;
        if (!handler) return;
        const value = (action as { value?: string }).value;
        if (value) handler(value, false);
      });
    });
  }

  private extractImages(
    files: Array<{ url_private: string; mimetype: string; name: string }> | undefined,
  ): ImageAttachment[] {
    if (!files) return [];
    const images: ImageAttachment[] = [];
    for (const file of files) {
      if (file.mimetype.startsWith("image/")) {
        images.push({
          url: file.url_private,
          mimeType: file.mimetype,
          filename: file.name,
          authHeader: `Bearer ${this.botToken}`,
        });
      }
    }
    return images;
  }

  async start(): Promise<void> {
    logInfo("Slack: connecting via Socket Mode...");
    await this.app.start();
    logInfo("Slack: connected and listening for messages");
  }

  async stop(): Promise<void> {
    logInfo("Slack: disconnecting...");
    await this.app.stop();
  }

  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  onApproval(handler: (taskId: string, approved: boolean) => void): void {
    this.approvalHandler = handler;
  }

  async sendText(
    channelId: string,
    text: string,
    threadId?: string,
  ): Promise<string> {
    const chunks = splitMessage(text, MAX_MESSAGE_LENGTH.slack);
    let lastTs = "";
    for (const chunk of chunks) {
      await this.rateLimiter.acquire();
      const result = await this.app.client.chat.postMessage({
        channel: channelId,
        text: chunk,
        ...(threadId ? { thread_ts: threadId } : {}),
      });
      lastTs = result.ts ?? "";
    }
    return lastTs;
  }

  async updateText(
    channelId: string,
    messageId: string,
    text: string,
    threadId?: string,
  ): Promise<void> {
    const chunks = splitMessage(text, MAX_MESSAGE_LENGTH.slack);
    const head = chunks[0] ?? "";
    await this.app.client.chat.update({
      channel: channelId,
      ts: messageId,
      text: head,
    });
    // Extra chunks are posted as new thread replies under the original
    // message, so the edited head + appended tail read as one response.
    for (let i = 1; i < chunks.length; i++) {
      await this.rateLimiter.acquire();
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: chunks[i] ?? "",
        thread_ts: threadId ?? messageId,
      });
    }
  }

  async sendApproval(
    channelId: string,
    text: string,
    taskId: string,
    threadId?: string,
  ): Promise<void> {
    const BLOCK_TEXT_LIMIT = 3000;
    const approvalButtons = {
      type: "actions" as const,
      elements: [
        {
          type: "button" as const,
          text: { type: "plain_text" as const, text: "Approve" },
          style: "primary" as const,
          action_id: "approve_task",
          value: taskId,
        },
        {
          type: "button" as const,
          text: { type: "plain_text" as const, text: "Reject" },
          style: "danger" as const,
          action_id: "reject_task",
          value: taskId,
        },
      ],
    };

    if (text.length > BLOCK_TEXT_LIMIT) {
      // Slack's `section` block has its own character limit; when the
      // proposal text is too long, send it as plain messages first and
      // then the buttons in a separate, minimal block message.
      await this.sendText(channelId, text, threadId);
      await this.rateLimiter.acquire();
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: "Approve or reject?",
        ...(threadId ? { thread_ts: threadId } : {}),
        blocks: [approvalButtons],
      });
    } else {
      // M1 messenger review MED #2 — the short path used to skip the
      // rate limiter while the long path acquired a token. Acquire here
      // so the two paths behave identically under bursty M5 approvals.
      await this.rateLimiter.acquire();
      await this.app.client.chat.postMessage({
        channel: channelId,
        text,
        ...(threadId ? { thread_ts: threadId } : {}),
        blocks: [
          {
            type: "section" as const,
            text: { type: "mrkdwn" as const, text },
          },
          approvalButtons,
        ],
      });
    }
  }

  async sendBlocks(
    channelId: string,
    fallbackText: string,
    blocks: readonly Record<string, unknown>[],
    threadId?: string,
  ): Promise<string> {
    await this.rateLimiter.acquire();
    const result = await this.app.client.chat.postMessage({
      channel: channelId,
      text: fallbackText,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
      blocks: blocks as any,
      ...(threadId ? { thread_ts: threadId } : {}),
    });
    return result.ts ?? "";
  }

  async addReaction(
    channelId: string,
    messageTs: string,
    emoji: string,
  ): Promise<void> {
    try {
      await this.app.client.reactions.add({
        channel: channelId,
        timestamp: messageTs,
        name: emoji,
      });
    } catch (err) {
      // Reactions fail routinely in normal operation (already-reacted,
      // missing scope, rate-limit). core.ts fires up to 5 reaction
      // calls per message — warn-logging every failure would flood the
      // disk log. Downgraded to debug (M1 messenger review MED #3).
      logDebug(
        `addReaction(${emoji}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async removeReaction(
    channelId: string,
    messageTs: string,
    emoji: string,
  ): Promise<void> {
    try {
      await this.app.client.reactions.remove({
        channel: channelId,
        timestamp: messageTs,
        name: emoji,
      });
    } catch (err) {
      logDebug(
        `removeReaction(${emoji}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
