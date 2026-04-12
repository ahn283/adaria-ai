import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  IncomingMessage,
  MessengerAdapter,
} from "../../src/messenger/adapter.js";
import type { AdariaConfig } from "../../src/config/schema.js";

const TEST_HOME = path.join(
  os.tmpdir(),
  `adaria-test-core-${String(process.pid)}-${Math.random().toString(36).slice(2, 8)}`,
);
process.env["ADARIA_HOME"] = TEST_HOME;

// Mock the Claude runner BEFORE importing core.ts, since core imports it
// at module-load time.
vi.mock("../../src/agent/claude.js", () => {
  return {
    invokeClaudeCli: vi.fn(),
    DEFAULT_TIMEOUT_MS: 120_000,
  };
});

const { AgentCore } = await import("../../src/agent/core.js");
const { SkillRegistry } = await import("../../src/skills/index.js");
const { McpManager } = await import("../../src/agent/mcp-manager.js");
const { invokeClaudeCli } = await import("../../src/agent/claude.js");
const { resetSessionStore } = await import("../../src/agent/session.js");
const { AUDIT_PATH, SESSIONS_PATH } = await import(
  "../../src/utils/paths.js"
);

const invokeClaudeCliMock = vi.mocked(invokeClaudeCli);

type MessengerHandlers = {
  messageHandler?: (msg: IncomingMessage) => void | Promise<void>;
  approvalHandler?: (taskId: string, approved: boolean) => void;
};

interface MockMessenger extends MessengerAdapter {
  __handlers: MessengerHandlers;
  __sent: Array<{ text: string; messageId: string }>;
  __updated: Array<{ messageId: string; text: string }>;
  __reactions: Array<{ messageTs: string; emoji: string; op: "add" | "remove" }>;
}

function createMockMessenger(): MockMessenger {
  const handlers: MessengerHandlers = {};
  const sent: MockMessenger["__sent"] = [];
  const updated: MockMessenger["__updated"] = [];
  const reactions: MockMessenger["__reactions"] = [];
  let nextId = 1;

  const messenger: MockMessenger = {
    __handlers: handlers,
    __sent: sent,
    __updated: updated,
    __reactions: reactions,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    onMessage: (fn) => {
      handlers.messageHandler = fn;
    },
    onApproval: (fn) => {
      handlers.approvalHandler = fn;
    },
    sendText: (_channelId, text, _threadId) => {
      const messageId = `msg-${String(nextId++)}`;
      sent.push({ text, messageId });
      return Promise.resolve(messageId);
    },
    updateText: (_channelId, messageId, text, _threadId) => {
      updated.push({ messageId, text });
      return Promise.resolve();
    },
    addReaction: (_channelId, messageTs, emoji) => {
      reactions.push({ messageTs, emoji, op: "add" });
      return Promise.resolve();
    },
    removeReaction: (_channelId, messageTs, emoji) => {
      reactions.push({ messageTs, emoji, op: "remove" });
      return Promise.resolve();
    },
    sendApproval: () => Promise.resolve(),
  };
  return messenger;
}

function buildConfig(overrides?: Partial<AdariaConfig>): AdariaConfig {
  return {
    slack: {
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      signingSecret: "secret",
    },
    claude: {
      mode: "cli",
      cliBinary: "claude",
      apiKey: null,
      timeoutMs: 120_000,
    },
    security: {
      allowedUsers: ["U_ALLOWED"],
      dmOnly: false,
      auditLog: { enabled: true, maskSecrets: true },
    },
    safety: {
      dangerousActionsRequireApproval: true,
      approvalTimeoutMinutes: 30,
    },
    agent: { showThinking: true },
    collectors: {},
    ...overrides,
  };
}

function buildIncoming(
  overrides?: Partial<IncomingMessage>,
): IncomingMessage {
  return {
    platform: "slack",
    userId: "U_ALLOWED",
    channelId: "C1",
    threadId: "1700000000.001",
    eventTs: "1700000000.001",
    text: "hi there",
    timestamp: new Date(),
    ...overrides,
  };
}

describe("AgentCore.handleMessage", () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_HOME, { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(TEST_HOME, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  beforeEach(() => {
    try {
      fs.rmSync(AUDIT_PATH, { force: true });
      fs.rmSync(SESSIONS_PATH, { force: true });
    } catch {
      // ignore
    }
    resetSessionStore();
    invokeClaudeCliMock.mockReset();
    invokeClaudeCliMock.mockResolvedValue({
      result: "claude says hi",
      exitCode: 0,
    });
  });

  describe("auth check", () => {
    it("silently ignores non-allowlisted users", async () => {
      const messenger = createMockMessenger();
      new AgentCore(messenger, buildConfig());
      const msg = buildIncoming({ userId: "U_STRANGER" });

      await messenger.__handlers.messageHandler?.(msg);

      expect(messenger.__sent).toHaveLength(0);
      expect(messenger.__reactions).toHaveLength(0);
      expect(invokeClaudeCliMock).not.toHaveBeenCalled();

      // Audit log still records the blocked attempt so operators can
      // notice suspicious traffic.
      const auditLines = fs
        .readFileSync(AUDIT_PATH, "utf-8")
        .trim()
        .split("\n");
      expect(auditLines).toHaveLength(1);
      expect(auditLines[0]).toContain("[BLOCKED]");
    });
  });

  describe("Mode A — skill dispatch", () => {
    it("routes 'aso fridgify' to the placeholder registry without calling Claude", async () => {
      const messenger = createMockMessenger();
      new AgentCore(messenger, buildConfig());

      const msg = buildIncoming({ text: "aso fridgify" });
      await messenger.__handlers.messageHandler?.(msg);

      expect(invokeClaudeCliMock).not.toHaveBeenCalled();
      // Final status message should carry the placeholder text.
      const last = messenger.__updated.at(-1);
      expect(last?.text).toMatch(/skill not implemented/);
    });

    it("lets a custom registry replace the placeholder dispatch", async () => {
      const messenger = createMockMessenger();
      const registry = new SkillRegistry();
      registry.register({
        name: "custom",
        commands: ["custom"],
        dispatch: () => Promise.resolve("custom skill result"),
      });
      new AgentCore(messenger, buildConfig(), { skillRegistry: registry });

      await messenger.__handlers.messageHandler?.(
        buildIncoming({ text: "custom please" }),
      );

      expect(invokeClaudeCliMock).not.toHaveBeenCalled();
      const last = messenger.__updated.at(-1);
      expect(last?.text).toBe("custom skill result");
    });
  });

  describe("Mode B — Claude fall-through", () => {
    it("free-form text falls through to invokeClaudeCli", async () => {
      const messenger = createMockMessenger();
      // Empty registry so nothing matches and Mode B always fires.
      new AgentCore(messenger, buildConfig(), {
        skillRegistry: new SkillRegistry(),
      });

      await messenger.__handlers.messageHandler?.(
        buildIncoming({ text: "안녕 adaria-ai" }),
      );

      expect(invokeClaudeCliMock).toHaveBeenCalledTimes(1);
      const last = messenger.__updated.at(-1);
      expect(last?.text).toBe("claude says hi");
    });

    it("passes no --mcp-config when the McpManager is empty (M1)", async () => {
      const messenger = createMockMessenger();
      new AgentCore(messenger, buildConfig(), {
        skillRegistry: new SkillRegistry(),
        mcpManager: new McpManager(),
      });

      await messenger.__handlers.messageHandler?.(buildIncoming());

      expect(invokeClaudeCliMock).toHaveBeenCalledTimes(1);
      const call = invokeClaudeCliMock.mock.calls[0]?.[0];
      expect(call?.mcpConfigPath).toBeUndefined();
    });

    it("wires the configured cliBinary and timeoutMs into every call", async () => {
      const messenger = createMockMessenger();
      new AgentCore(
        messenger,
        buildConfig({
          claude: {
            mode: "cli",
            cliBinary: "custom-claude",
            apiKey: null,
            timeoutMs: 42_000,
          },
        }),
        { skillRegistry: new SkillRegistry() },
      );

      await messenger.__handlers.messageHandler?.(buildIncoming());

      const call = invokeClaudeCliMock.mock.calls[0]?.[0];
      expect(call?.cliBinary).toBe("custom-claude");
      expect(call?.timeoutMs).toBe(42_000);
    });

    it("uses --session-id on first message and --resume on the next", async () => {
      const messenger = createMockMessenger();
      new AgentCore(messenger, buildConfig(), {
        skillRegistry: new SkillRegistry(),
      });

      await messenger.__handlers.messageHandler?.(
        buildIncoming({ threadId: "t1" }),
      );
      const firstCall = invokeClaudeCliMock.mock.calls[0]?.[0];
      expect(firstCall?.sessionId).toBeDefined();
      expect(firstCall?.resumeSessionId).toBeUndefined();

      await messenger.__handlers.messageHandler?.(
        buildIncoming({ threadId: "t1" }),
      );
      const secondCall = invokeClaudeCliMock.mock.calls[1]?.[0];
      expect(secondCall?.resumeSessionId).toBe(firstCall?.sessionId);
    });
  });

  describe("reactions — eventTs semantics", () => {
    it("attaches reactions to eventTs when present", async () => {
      const messenger = createMockMessenger();
      new AgentCore(messenger, buildConfig());

      await messenger.__handlers.messageHandler?.(
        buildIncoming({ eventTs: "1700000999.123", threadId: "t-root" }),
      );

      // All reactions should target the eventTs, never the threadId.
      for (const r of messenger.__reactions) {
        expect(r.messageTs).toBe("1700000999.123");
      }
      expect(messenger.__reactions.length).toBeGreaterThan(0);
    });

    it("skips all reactions when eventTs is missing (no threadId fallback)", async () => {
      const messenger = createMockMessenger();
      new AgentCore(messenger, buildConfig());

      const msg = buildIncoming({ threadId: "t-root" });
      delete msg.eventTs;

      await messenger.__handlers.messageHandler?.(msg);

      expect(messenger.__reactions).toHaveLength(0);
      // Mode B still fires and produces a response.
      const last = messenger.__updated.at(-1);
      expect(last?.text).toBe("claude says hi");
    });
  });

  describe("error handling", () => {
    it("converts Claude errors into an ❌ status update", async () => {
      const messenger = createMockMessenger();
      invokeClaudeCliMock.mockRejectedValueOnce(new Error("kaboom"));
      new AgentCore(messenger, buildConfig(), {
        skillRegistry: new SkillRegistry(),
      });

      await messenger.__handlers.messageHandler?.(buildIncoming());

      const last = messenger.__updated.at(-1);
      expect(last?.text).toContain("❌");
      expect(last?.text).toContain("kaboom");

      // Audit should capture the error entry.
      const auditLines = fs
        .readFileSync(AUDIT_PATH, "utf-8")
        .trim()
        .split("\n");
      const types = auditLines.map(
        (l) => (JSON.parse(l) as { type: string }).type,
      );
      expect(types).toContain("error");
    });
  });
});
