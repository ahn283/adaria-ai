import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IncomingMessage } from "../../src/messenger/adapter.js";

/**
 * `@slack/bolt`'s `App` class is mocked so these tests don't open a real
 * Socket Mode connection. The mock captures the handlers SlackAdapter
 * registers via `app.message(...)`, `app.event(...)`, `app.action(...)`,
 * so tests can fire a fake event into the handler and assert the
 * resulting `IncomingMessage` shape.
 */

type Handler = (args: unknown) => unknown;
interface MockAppState {
  messageHandler?: Handler;
  eventHandlers: Record<string, Handler>;
  actionHandlers: Record<string, Handler>;
  postedMessages: Array<{
    channel: string;
    text: string;
    thread_ts?: string;
    blocks?: unknown[];
  }>;
  updatedMessages: Array<{ channel: string; ts: string; text: string }>;
  reactionsAdded: Array<{ channel: string; timestamp: string; name: string }>;
  reactionsRemoved: Array<{ channel: string; timestamp: string; name: string }>;
  errorHandler?: (err: unknown) => Promise<void> | void;
}

const mockState: MockAppState = {
  eventHandlers: {},
  actionHandlers: {},
  postedMessages: [],
  updatedMessages: [],
  reactionsAdded: [],
  reactionsRemoved: [],
};

vi.mock("@slack/bolt", () => {
  class App {
    constructor(_opts: unknown) {
      void _opts;
    }

    message(handler: Handler): void {
      mockState.messageHandler = handler;
    }

    event(name: string, handler: Handler): void {
      mockState.eventHandlers[name] = handler;
    }

    action(name: string, handler: Handler): void {
      mockState.actionHandlers[name] = handler;
    }

    error(handler: (err: unknown) => Promise<void> | void): void {
      mockState.errorHandler = handler;
    }

    start(): Promise<void> {
      return Promise.resolve();
    }

    stop(): Promise<void> {
      return Promise.resolve();
    }

    client = {
      chat: {
        postMessage: (args: {
          channel: string;
          text: string;
          thread_ts?: string;
          blocks?: unknown[];
        }) => {
          mockState.postedMessages.push(args);
          return Promise.resolve({
            ts: `posted-${String(mockState.postedMessages.length)}`,
          });
        },
        update: (args: { channel: string; ts: string; text: string }) => {
          mockState.updatedMessages.push(args);
          return Promise.resolve({});
        },
      },
      reactions: {
        add: (args: { channel: string; timestamp: string; name: string }) => {
          mockState.reactionsAdded.push(args);
          return Promise.resolve({});
        },
        remove: (args: {
          channel: string;
          timestamp: string;
          name: string;
        }) => {
          mockState.reactionsRemoved.push(args);
          return Promise.resolve({});
        },
      },
    };
  }

  return { App };
});

const { SlackAdapter } = await import("../../src/messenger/slack.js");

function newAdapter(): InstanceType<typeof SlackAdapter> {
  return new SlackAdapter({
    botToken: "xoxb-test",
    appToken: "xapp-test",
    signingSecret: "secret",
  });
}

function resetMockState(): void {
  delete mockState.messageHandler;
  mockState.eventHandlers = {};
  mockState.actionHandlers = {};
  mockState.postedMessages = [];
  mockState.updatedMessages = [];
  mockState.reactionsAdded = [];
  mockState.reactionsRemoved = [];
}

describe("SlackAdapter", () => {
  beforeEach(() => {
    resetMockState();
  });

  describe("incoming message → IncomingMessage mapping", () => {
    it("populates eventTs (the growth-agent Phase 1 regression fix)", async () => {
      const adapter = newAdapter();
      const captured: IncomingMessage[] = [];
      adapter.onMessage((msg) => {
        captured.push(msg);
      });

      await mockState.messageHandler?.({
        message: {
          user: "U_ALLOWED",
          channel: "C1",
          channel_type: "im",
          ts: "1700000000.001",
          text: "hi",
        },
      });

      expect(captured).toHaveLength(1);
      expect(captured[0]?.eventTs).toBe("1700000000.001");
      expect(captured[0]?.threadId).toBe("1700000000.001");
    });

    it("distinguishes thread_ts from event ts", async () => {
      const adapter = newAdapter();
      const captured: IncomingMessage[] = [];
      adapter.onMessage((msg) => {
        captured.push(msg);
      });

      await mockState.messageHandler?.({
        message: {
          user: "U1",
          channel: "C1",
          channel_type: "im",
          ts: "1700000099.999",
          thread_ts: "1700000000.001",
          text: "reply",
        },
      });

      expect(captured[0]?.eventTs).toBe("1700000099.999");
      expect(captured[0]?.threadId).toBe("1700000000.001");
    });

    it("ignores subtyped messages except file_share", async () => {
      const adapter = newAdapter();
      const captured: IncomingMessage[] = [];
      adapter.onMessage((msg) => {
        captured.push(msg);
      });

      await mockState.messageHandler?.({
        message: {
          user: "U1",
          channel: "C1",
          ts: "1700000000.001",
          subtype: "channel_join",
          text: "joined",
        },
      });

      expect(captured).toHaveLength(0);
    });

    it("drops file_share events that carry no text and no image attachments", async () => {
      const adapter = newAdapter();
      const captured: IncomingMessage[] = [];
      adapter.onMessage((msg) => {
        captured.push(msg);
      });

      await mockState.messageHandler?.({
        message: {
          user: "U1",
          channel: "C1",
          ts: "1700000333.444",
          subtype: "file_share",
          files: [
            {
              url_private: "https://example.com/doc.pdf",
              mimetype: "application/pdf",
              name: "doc.pdf",
            },
          ],
        },
      });

      expect(captured).toHaveLength(0);
    });

    it("keeps file_share events that carry an image", async () => {
      const adapter = newAdapter();
      const captured: IncomingMessage[] = [];
      adapter.onMessage((msg) => {
        captured.push(msg);
      });

      await mockState.messageHandler?.({
        message: {
          user: "U1",
          channel: "C1",
          channel_type: "im",
          ts: "1700000444.555",
          subtype: "file_share",
          files: [
            {
              url_private: "https://example.com/pic.png",
              mimetype: "image/png",
              name: "pic.png",
            },
          ],
        },
      });

      expect(captured).toHaveLength(1);
      expect(captured[0]?.images?.[0]?.url).toBe("https://example.com/pic.png");
    });

    it("dedupes repeat events with the same ts", async () => {
      const adapter = newAdapter();
      const captured: IncomingMessage[] = [];
      adapter.onMessage((msg) => {
        captured.push(msg);
      });

      const payload = {
        message: {
          user: "U1",
          channel: "C1",
          channel_type: "im",
          ts: "1700000000.001",
          text: "once",
        },
      };
      await mockState.messageHandler?.(payload);
      await mockState.messageHandler?.(payload);

      expect(captured).toHaveLength(1);
    });
  });

  describe("app_mention → IncomingMessage mapping", () => {
    it("strips the bot mention prefix and populates eventTs", async () => {
      const adapter = newAdapter();
      const captured: IncomingMessage[] = [];
      adapter.onMessage((msg) => {
        captured.push(msg);
      });

      await mockState.eventHandlers["app_mention"]?.({
        event: {
          user: "U_ALLOWED",
          channel: "C1",
          ts: "1700000111.222",
          text: "<@U0BOT> aso fridgify",
        },
      });

      expect(captured).toHaveLength(1);
      expect(captured[0]?.text).toBe("aso fridgify");
      expect(captured[0]?.eventTs).toBe("1700000111.222");
    });

    it("dedupes a mention if the corresponding message event was already handled", async () => {
      const adapter = newAdapter();
      const captured: IncomingMessage[] = [];
      adapter.onMessage((msg) => {
        captured.push(msg);
      });

      await mockState.messageHandler?.({
        message: {
          user: "U1",
          channel: "C1",
          ts: "1700000222.333",
          text: "<@U0BOT> hi",
        },
      });
      await mockState.eventHandlers["app_mention"]?.({
        event: {
          user: "U1",
          channel: "C1",
          ts: "1700000222.333",
          text: "<@U0BOT> hi",
        },
      });

      expect(captured).toHaveLength(1);
    });
  });

  describe("approval actions", () => {
    it("forwards approve_task with approved=true", async () => {
      const adapter = newAdapter();
      const calls: Array<{ taskId: string; approved: boolean }> = [];
      adapter.onApproval((taskId, approved) => {
        calls.push({ taskId, approved });
      });

      const ack = vi.fn(() => Promise.resolve());
      await mockState.actionHandlers["approve_task"]?.({
        action: { value: "t-123" },
        ack,
      });

      expect(ack).toHaveBeenCalled();
      expect(calls).toEqual([{ taskId: "t-123", approved: true }]);
    });

    it("forwards reject_task with approved=false", async () => {
      const adapter = newAdapter();
      const calls: Array<{ taskId: string; approved: boolean }> = [];
      adapter.onApproval((taskId, approved) => {
        calls.push({ taskId, approved });
      });

      const ack = vi.fn(() => Promise.resolve());
      await mockState.actionHandlers["reject_task"]?.({
        action: { value: "t-456" },
        ack,
      });

      expect(calls).toEqual([{ taskId: "t-456", approved: false }]);
    });
  });

  describe("sendText", () => {
    it("posts a single message when under the limit and returns its ts", async () => {
      const adapter = newAdapter();
      const ts = await adapter.sendText("C1", "short reply", "t-root");
      expect(mockState.postedMessages).toHaveLength(1);
      expect(mockState.postedMessages[0]?.thread_ts).toBe("t-root");
      expect(ts).toBe("posted-1");
    });

    it("splits long messages into multiple posts", async () => {
      const adapter = newAdapter();
      const long = "x ".repeat(3000);
      await adapter.sendText("C1", long);
      expect(mockState.postedMessages.length).toBeGreaterThan(1);
    });

    it("omits thread_ts entirely when no threadId is provided", async () => {
      const adapter = newAdapter();
      await adapter.sendText("C1", "hi");
      expect(mockState.postedMessages[0]?.thread_ts).toBeUndefined();
    });
  });

  describe("updateText", () => {
    it("edits the original message with the first chunk", async () => {
      const adapter = newAdapter();
      await adapter.updateText("C1", "ts-1", "updated", "t-root");
      expect(mockState.updatedMessages).toHaveLength(1);
      expect(mockState.updatedMessages[0]?.text).toBe("updated");
    });

    it("posts extra chunks as replies in the thread when the update is too long", async () => {
      const adapter = newAdapter();
      const long = "y ".repeat(3000);
      await adapter.updateText("C1", "ts-1", long);
      expect(mockState.updatedMessages).toHaveLength(1);
      expect(mockState.postedMessages.length).toBeGreaterThan(0);
    });
  });

  describe("reactions", () => {
    it("calls reactions.add with the given emoji", async () => {
      const adapter = newAdapter();
      await adapter.addReaction("C1", "1700000000.001", "thinking_face");
      expect(mockState.reactionsAdded).toEqual([
        { channel: "C1", timestamp: "1700000000.001", name: "thinking_face" },
      ]);
    });

    it("calls reactions.remove with the given emoji", async () => {
      const adapter = newAdapter();
      await adapter.removeReaction("C1", "1700000000.001", "gear");
      expect(mockState.reactionsRemoved).toEqual([
        { channel: "C1", timestamp: "1700000000.001", name: "gear" },
      ]);
    });
  });
});
