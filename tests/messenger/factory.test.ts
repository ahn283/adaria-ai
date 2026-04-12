import { describe, it, expect, vi } from "vitest";
import type { AdariaConfig } from "../../src/config/schema.js";

// Mock bolt so SlackAdapter can be constructed without a real connection.
vi.mock("@slack/bolt", () => {
  class App {
    constructor(_opts: unknown) {
      void _opts;
    }
    message(): void {
      /* noop */
    }
    event(): void {
      /* noop */
    }
    action(): void {
      /* noop */
    }
    error(): void {
      /* noop */
    }
    start(): Promise<void> {
      return Promise.resolve();
    }
    stop(): Promise<void> {
      return Promise.resolve();
    }
    client = {};
  }
  return { App };
});

const { createMessengerAdapter } = await import(
  "../../src/messenger/factory.js"
);
const { SlackAdapter } = await import("../../src/messenger/slack.js");

function buildConfig(): AdariaConfig {
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
      allowedUsers: ["U1"],
      dmOnly: false,
      auditLog: { enabled: true, maskSecrets: true },
    },
    safety: {
      dangerousActionsRequireApproval: true,
      approvalTimeoutMinutes: 30,
    },
    agent: { showThinking: true, weeklyTimeoutMs: 900_000 },
    social: {},
    thresholds: { keywordRankAlert: 5, reviewSentimentAlert: 0.3, oneStarReviewAlert: 3, installSignupDropAlert: 0.15, subscriptionDropAlert: 0.2, seoClicksDropAlert: 0.3, seoImpressionsDropAlert: 0.3, webTrafficDropAlert: 0.25 },
    collectors: {},
  };
}

describe("createMessengerAdapter", () => {
  it("returns a SlackAdapter for an AdariaConfig with slack credentials", () => {
    const adapter = createMessengerAdapter(buildConfig());
    expect(adapter).toBeInstanceOf(SlackAdapter);
  });
});
