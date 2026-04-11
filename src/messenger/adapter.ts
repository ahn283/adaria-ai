/**
 * Platform-agnostic messenger interface. adaria-ai v1 only implements Slack,
 * but the adapter layer stays generic so Telegram or another messenger can
 * slot in without refactoring consumers.
 */

export interface ImageAttachment {
  url: string;
  mimeType: string;
  filename?: string;
  /** HTTP header required to fetch the URL (e.g. "Bearer xoxb-..."). */
  authHeader?: string;
}

export interface IncomingMessage {
  platform: "slack";
  /** Platform user ID (Slack `U...` or equivalent). Checked against allowlist. */
  userId: string;
  channelId: string;
  /** Thread root timestamp — the message to reply under. */
  threadId?: string;
  /**
   * Raw Slack event timestamp (`event.ts`) — present on messages originated
   * by a real Slack event. Required for adding reactions, updating the
   * message in place, and deduping. Kept distinct from `timestamp` so we
   * don't round-trip through Date and lose precision.
   *
   * Optional because M1e/M6 may re-inject synthetic messages (approval
   * button callbacks, cron-initiated analyses) that have no originating
   * event. Consumers that need to addReaction/updateText must guard with
   * `if (msg.eventTs)` — the growth-agent Phase 1 lesson is "don't
   * reconstruct from Date", not "every message must have one".
   */
  eventTs?: string;
  text: string;
  images?: ImageAttachment[];
  /** Human-readable timestamp for logging and UX. */
  timestamp: Date;
}

export interface MessengerAdapter {
  /** Start the connection to the platform. */
  start(): Promise<void>;

  /** Stop the connection cleanly. */
  stop(): Promise<void>;

  /** Register the incoming message callback. */
  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void;

  /** Send a text message. Returns the new message ID (ts on Slack). */
  sendText(
    channelId: string,
    text: string,
    threadId?: string
  ): Promise<string>;

  /** Update an existing message by its ID. */
  updateText(
    channelId: string,
    messageId: string,
    text: string,
    threadId?: string
  ): Promise<void>;

  /** Add a reaction to a message (best-effort; no-op if unsupported). */
  addReaction?(
    channelId: string,
    messageTs: string,
    emoji: string
  ): Promise<void>;

  /** Remove a reaction from a message (best-effort; no-op if unsupported). */
  removeReaction?(
    channelId: string,
    messageTs: string,
    emoji: string
  ): Promise<void>;

  /** Send an approval message with Approve/Reject buttons. */
  sendApproval(
    channelId: string,
    text: string,
    taskId: string,
    threadId?: string
  ): Promise<void>;

  /** Register the approval/rejection callback. */
  onApproval(handler: (taskId: string, approved: boolean) => void): void;
}
