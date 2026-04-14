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
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
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

/** 5 MB cap on downloaded images (Claude vision is comfortable far below 20 MB). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Only these MIME types are accepted for brand profile images. */
export const ALLOWED_IMAGE_MIMES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

/**
 * Hosts we're willing to send the bot token (`Authorization: Bearer xoxb-...`)
 * to. Anything else gets rejected before we fetch, so a malicious or
 * malformed `url_private` can't exfiltrate the token to a third party.
 * Slack's CDN uses these two hostnames as of 2026-04.
 */
const ALLOWED_IMAGE_HOSTS: readonly string[] = [
  "files.slack.com",
  "files-edge.slack.com",
];

/**
 * Relevant subset of Slack's `file` object on a `message` / `app_mention`
 * event payload. `url_private` is the authenticated download URL; the
 * client must send `Authorization: Bearer <botToken>` (requires the
 * `files:read` bot scope).
 */
interface SlackFile {
  url_private: string;
  mimetype: string;
  name: string;
}

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
        channel_type?: string;
        thread_ts?: string;
        text?: string;
        ts?: string;
        files?: SlackFile[];
      };
      if (!msg.user) return Promise.resolve();
      if (!msg.text && !msg.files?.length) return Promise.resolve();

      // In channels, only respond to @mentions (handled by app_mention).
      // The message handler only processes DMs (im) to avoid double
      // responses when both message and app_mention fire for the same event.
      if (msg.channel_type !== "im") {
        return Promise.resolve();
      }

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
      if (!event.user) return Promise.resolve();

      // M6.7 — channel file uploads arrive with a mention as the caption.
      // Previously app_mention ignored `event.files`, so brand-profile
      // uploads only worked in DMs. Forward any images the same way the
      // DM `message` handler does.
      const files = (event as { files?: Array<SlackFile> }).files;
      const images = this.extractImages(files);

      // A bare @mention with no text and no attachments is a no-op —
      // matches the DM handler's zero-byte guard.
      if (!text && images.length === 0) return Promise.resolve();

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
      if (images.length > 0) incoming.images = images;

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

  private extractImages(files: SlackFile[] | undefined): ImageAttachment[] {
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

  /**
   * Download a Slack-hosted image to an absolute path. Validates MIME +
   * size + destination path before touching disk. Callers (e.g. BrandSkill)
   * compute `destPath` via `brandsDir(serviceId)` so the path guarantee
   * here is the generic "absolute, no `..`, MIME in whitelist, size cap".
   */
  async downloadImage(
    attachment: ImageAttachment,
    destPath: string,
  ): Promise<void> {
    if (!isAbsolute(destPath)) {
      throw new Error(`downloadImage: destPath must be absolute, got ${destPath}`);
    }
    // Guard must examine the *input* path. `normalize()` collapses `..`
    // segments silently, so checking the normalized output would miss an
    // attacker's `.../foo/../../etc/passwd`. Reject any `..` segment in
    // the raw input before we resolve it.
    if (destPath.split(/[\\/]/).includes("..")) {
      throw new Error(`downloadImage: destPath traversal rejected: ${destPath}`);
    }
    const normalized = normalize(destPath);
    if (!ALLOWED_IMAGE_MIMES.includes(attachment.mimeType)) {
      throw new Error(
        `downloadImage: MIME ${attachment.mimeType} not allowed (png/jpeg/webp only)`,
      );
    }

    // Host allowlist — the `authHeader` carries the bot token, so we must
    // refuse to send it anywhere other than Slack's file CDN. Also force
    // https and block redirects so a crafted URL can't bounce us onto a
    // hostile origin mid-request.
    let parsed: URL;
    try {
      parsed = new URL(attachment.url);
    } catch {
      throw new Error(`downloadImage: invalid URL: ${attachment.url}`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(`downloadImage: non-https URL rejected: ${attachment.url}`);
    }
    if (!ALLOWED_IMAGE_HOSTS.includes(parsed.hostname)) {
      throw new Error(
        `downloadImage: host ${parsed.hostname} not in allowlist (files.slack.com only)`,
      );
    }

    const headers: Record<string, string> = {};
    if (attachment.authHeader) headers["Authorization"] = attachment.authHeader;

    const res = await fetch(attachment.url, { headers, redirect: "error" });
    if (!res.ok) {
      throw new Error(
        `downloadImage: fetch failed with ${String(res.status)} ${res.statusText}`,
      );
    }

    // Cross-check Content-Type: Slack can redirect to an HTML error page
    // with status 200 when the bot token lacks `files:read`, in which
    // case Content-Type would be text/html and we must fail closed.
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const contentTypeFirstToken = contentType.split(";")[0]?.trim() ?? "";
    if (
      contentTypeFirstToken !== "" &&
      !ALLOWED_IMAGE_MIMES.includes(contentTypeFirstToken)
    ) {
      throw new Error(
        `downloadImage: server returned content-type ${contentTypeFirstToken}, expected image/*`,
      );
    }

    const contentLengthHeader = res.headers.get("content-length");
    if (contentLengthHeader) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
        throw new Error(
          `downloadImage: size ${String(declared)} exceeds ${String(MAX_IMAGE_BYTES)} byte cap`,
        );
      }
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(
        `downloadImage: downloaded ${String(buffer.byteLength)} bytes exceeds cap (server omitted content-length)`,
      );
    }

    await mkdir(dirname(normalized), { recursive: true });
    await writeFile(normalized, buffer);
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
