import { describe, it, expect } from "vitest";
import { isAuthorizedUser } from "../../src/security/auth.js";
import type { IncomingMessage } from "../../src/messenger/adapter.js";
import type { AdariaConfig } from "../../src/config/schema.js";

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
      allowedUsers: ["U0A0UB94XRT", "U0A15HYJBV2"],
      dmOnly: false,
      auditLog: { enabled: true, maskSecrets: true },
    },
    safety: {
      dangerousActionsRequireApproval: true,
      approvalTimeoutMinutes: 30,
    },
    agent: { showThinking: true },
    ...overrides,
  };
}

function buildMessage(userId: string): IncomingMessage {
  return {
    platform: "slack",
    userId,
    channelId: "C123",
    eventTs: "1712900000.000100",
    text: "hello",
    timestamp: new Date(),
  };
}

describe("isAuthorizedUser", () => {
  const config = buildConfig();

  it("returns true for users in the allowlist", () => {
    expect(isAuthorizedUser(buildMessage("U0A0UB94XRT"), config)).toBe(true);
    expect(isAuthorizedUser(buildMessage("U0A15HYJBV2"), config)).toBe(true);
  });

  it("returns false for users not in the allowlist", () => {
    expect(isAuthorizedUser(buildMessage("UNOTALLOWED"), config)).toBe(false);
  });

  it("returns false when allowlist is empty", () => {
    const emptyConfig = buildConfig({
      security: {
        allowedUsers: [],
        dmOnly: false,
        auditLog: { enabled: true, maskSecrets: true },
      },
    });
    expect(isAuthorizedUser(buildMessage("U0A0UB94XRT"), emptyConfig)).toBe(
      false
    );
  });
});
