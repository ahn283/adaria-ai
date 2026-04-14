import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    it("forwards image attachments from a mention (M6.7 brand-profile flow)", async () => {
      const adapter = newAdapter();
      const captured: IncomingMessage[] = [];
      adapter.onMessage((msg) => {
        captured.push(msg);
      });

      await mockState.eventHandlers["app_mention"]?.({
        event: {
          user: "U_ALLOWED",
          channel: "C1",
          ts: "1700000555.666",
          text: "<@U0BOT> 로고 받아",
          files: [
            {
              url_private: "https://files.slack.com/files-pri/T-A/logo.png",
              mimetype: "image/png",
              name: "logo.png",
            },
          ],
        },
      });

      expect(captured).toHaveLength(1);
      expect(captured[0]?.text).toBe("로고 받아");
      expect(captured[0]?.images).toHaveLength(1);
      expect(captured[0]?.images?.[0]?.url).toBe(
        "https://files.slack.com/files-pri/T-A/logo.png",
      );
      expect(captured[0]?.images?.[0]?.authHeader).toBe("Bearer xoxb-test");
    });

    it("accepts a mention with only an image and no text", async () => {
      const adapter = newAdapter();
      const captured: IncomingMessage[] = [];
      adapter.onMessage((msg) => {
        captured.push(msg);
      });

      await mockState.eventHandlers["app_mention"]?.({
        event: {
          user: "U_ALLOWED",
          channel: "C1",
          ts: "1700000666.777",
          text: "<@U0BOT>",
          files: [
            {
              url_private: "https://files.slack.com/files-pri/T-A/pic.jpg",
              mimetype: "image/jpeg",
              name: "pic.jpg",
            },
          ],
        },
      });

      expect(captured).toHaveLength(1);
      expect(captured[0]?.text).toBe("");
      expect(captured[0]?.images).toHaveLength(1);
    });

    it("drops a bare mention with no text and no images", async () => {
      const adapter = newAdapter();
      const captured: IncomingMessage[] = [];
      adapter.onMessage((msg) => {
        captured.push(msg);
      });

      await mockState.eventHandlers["app_mention"]?.({
        event: {
          user: "U_ALLOWED",
          channel: "C1",
          ts: "1700000777.888",
          text: "<@U0BOT>",
        },
      });

      expect(captured).toHaveLength(0);
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

  describe("downloadImage", () => {
    let workDir: string;

    beforeEach(async () => {
      workDir = await mkdtemp(join(tmpdir(), "adaria-dl-"));
    });

    afterEach(async () => {
      await rm(workDir, { recursive: true, force: true });
      vi.unstubAllGlobals();
    });

    function stubFetch(
      response: {
        ok?: boolean;
        status?: number;
        statusText?: string;
        body?: Uint8Array;
        headers?: Record<string, string>;
      },
      capture?: (url: string, init: RequestInit) => void,
    ): void {
      const ok = response.ok ?? true;
      const status = response.status ?? (ok ? 200 : 403);
      const body = response.body ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const headers = response.headers ?? { "content-type": "image/png" };
      const fakeFetch = (url: string, init: RequestInit): Promise<Response> => {
        capture?.(url, init);
        const res = {
          ok,
          status,
          statusText: response.statusText ?? (ok ? "OK" : "Forbidden"),
          headers: {
            get(name: string): string | null {
              return headers[name.toLowerCase()] ?? null;
            },
          },
          arrayBuffer(): Promise<ArrayBuffer> {
            return Promise.resolve(
              body.buffer.slice(
                body.byteOffset,
                body.byteOffset + body.byteLength,
              ) as ArrayBuffer,
            );
          },
        };
        return Promise.resolve(res as unknown as Response);
      };
      vi.stubGlobal("fetch", fakeFetch);
    }

    it("writes the image to an absolute path and sends the auth header", async () => {
      const adapter = newAdapter();
      const observed: { url?: string; auth?: string } = {};
      stubFetch({}, (url, init) => {
        observed.url = url;
        observed.auth = (init.headers as Record<string, string>).Authorization;
      });

      const dest = join(workDir, "fridgify", "logo.png");
      await adapter.downloadImage(
        {
          url: "https://files.slack.com/files-pri/T-A/logo.png",
          mimeType: "image/png",
          filename: "logo.png",
          authHeader: "Bearer xoxb-test",
        },
        dest,
      );

      const saved = await readFile(dest);
      expect(saved.length).toBeGreaterThan(0);
      expect(observed.url).toBe("https://files.slack.com/files-pri/T-A/logo.png");
      expect(observed.auth).toBe("Bearer xoxb-test");
    });

    it("rejects a relative destination path", async () => {
      const adapter = newAdapter();
      stubFetch({});
      await expect(
        adapter.downloadImage(
          { url: "https://files.slack.com/files-pri/T-A/x.png", mimeType: "image/png", authHeader: "Bearer x" },
          "relative/path/logo.png",
        ),
      ).rejects.toThrow(/must be absolute/);
    });

    it("rejects a path containing `..` traversal", async () => {
      const adapter = newAdapter();
      stubFetch({});
      await expect(
        adapter.downloadImage(
          { url: "https://files.slack.com/files-pri/T-A/x.png", mimeType: "image/png", authHeader: "Bearer x" },
          `${workDir}/../escape.png`,
        ),
      ).rejects.toThrow(/traversal/);
    });

    it("rejects attachments with a disallowed MIME", async () => {
      const adapter = newAdapter();
      stubFetch({});
      await expect(
        adapter.downloadImage(
          { url: "https://x", mimeType: "image/gif", authHeader: "Bearer x" },
          join(workDir, "evil.gif"),
        ),
      ).rejects.toThrow(/not allowed/);
    });

    it("fails closed when the server returns text/html (scope missing → HTML error page)", async () => {
      const adapter = newAdapter();
      stubFetch({
        headers: { "content-type": "text/html; charset=utf-8" },
      });
      await expect(
        adapter.downloadImage(
          { url: "https://files.slack.com/files-pri/T-A/x.png", mimeType: "image/png", authHeader: "Bearer x" },
          join(workDir, "logo.png"),
        ),
      ).rejects.toThrow(/content-type text\/html/);
    });

    it("rejects oversized files declared via content-length", async () => {
      const adapter = newAdapter();
      stubFetch({
        headers: {
          "content-type": "image/png",
          "content-length": String(6 * 1024 * 1024),
        },
      });
      await expect(
        adapter.downloadImage(
          { url: "https://files.slack.com/files-pri/T-A/x.png", mimeType: "image/png", authHeader: "Bearer x" },
          join(workDir, "big.png"),
        ),
      ).rejects.toThrow(/exceeds/);
    });

    it("rejects oversized files that omit content-length", async () => {
      const adapter = newAdapter();
      stubFetch({
        body: new Uint8Array(6 * 1024 * 1024),
        headers: { "content-type": "image/png" },
      });
      await expect(
        adapter.downloadImage(
          { url: "https://files.slack.com/files-pri/T-A/x.png", mimeType: "image/png", authHeader: "Bearer x" },
          join(workDir, "sneaky.png"),
        ),
      ).rejects.toThrow(/exceeds cap/);
    });

    it("rejects URLs outside the Slack host allowlist (prevents token leak)", async () => {
      const adapter = newAdapter();
      stubFetch({});
      await expect(
        adapter.downloadImage(
          {
            url: "https://evil.example.com/logo.png",
            mimeType: "image/png",
            authHeader: "Bearer xoxb-test",
          },
          join(workDir, "logo.png"),
        ),
      ).rejects.toThrow(/host evil\.example\.com not in allowlist/);
    });

    it("rejects non-https URLs", async () => {
      const adapter = newAdapter();
      stubFetch({});
      await expect(
        adapter.downloadImage(
          {
            url: "http://files.slack.com/files-pri/T-A/logo.png",
            mimeType: "image/png",
            authHeader: "Bearer xoxb-test",
          },
          join(workDir, "logo.png"),
        ),
      ).rejects.toThrow(/non-https/);
    });

    it("rejects malformed URLs", async () => {
      const adapter = newAdapter();
      stubFetch({});
      await expect(
        adapter.downloadImage(
          {
            url: "not-a-url",
            mimeType: "image/png",
            authHeader: "Bearer xoxb-test",
          },
          join(workDir, "logo.png"),
        ),
      ).rejects.toThrow(/invalid URL/);
    });

    it("surfaces HTTP errors (e.g. 403 when files:read scope is missing)", async () => {
      const adapter = newAdapter();
      stubFetch({ ok: false, status: 403, statusText: "Forbidden" });
      await expect(
        adapter.downloadImage(
          { url: "https://files.slack.com/files-pri/T-A/x.png", mimeType: "image/png", authHeader: "Bearer x" },
          join(workDir, "forbidden.png"),
        ),
      ).rejects.toThrow(/403/);
    });
  });
});
