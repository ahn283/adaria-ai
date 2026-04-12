/* eslint-disable @typescript-eslint/unbound-method */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase } from "../../src/db/schema.js";
import {
  runWeeklyAnalysis,
  type WeeklySkillDispatchers,
  _test,
} from "../../src/orchestrator/weekly.js";
import { SkippedAgentError } from "../../src/orchestrator/types.js";
import type { SkillResult } from "../../src/types/skill.js";
import type { MessengerAdapter } from "../../src/messenger/adapter.js";
import type { AdariaConfig } from "../../src/config/schema.js";
import type { AppConfig } from "../../src/config/apps-schema.js";

const { timedRun, isSkipped, agentResult, formatBriefingText, collectApprovalItems } = _test;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeApp(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    id: "fridgify",
    name: "Fridgify",
    platform: ["ios"],
    primaryKeywords: [],
    competitors: [],
    locale: [],
    features: { fridgifyRecipes: false },
    active: true,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AdariaConfig> = {}): AdariaConfig {
  return {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      signingSecret: "test",
    },
    claude: { mode: "cli" as const, cliBinary: "claude", timeoutMs: 120_000 },
    security: { allowedUsers: ["U123"], dmOnly: false, auditLog: { enabled: true, maskSecrets: true } },
    safety: { dangerousActionsRequireApproval: true, approvalTimeoutMinutes: 30 },
    agent: { showThinking: true, weeklyTimeoutMs: 900_000, briefingChannel: "#test" },
    thresholds: {
      keywordRankAlert: 5,
      reviewSentimentAlert: 0.3,
      oneStarReviewAlert: 3,
      installSignupDropAlert: 0.15,
      subscriptionDropAlert: 0.2,
      seoClicksDropAlert: 0.3,
      seoImpressionsDropAlert: 0.3,
      webTrafficDropAlert: 0.25,
    },
    collectors: {},
    ...overrides,
  } as AdariaConfig;
}

function makeMockMessenger(): MessengerAdapter {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    sendText: vi.fn().mockResolvedValue("ts-1"),
    updateText: vi.fn().mockResolvedValue(undefined),
    sendApproval: vi.fn().mockResolvedValue(undefined),
    onApproval: vi.fn(),
  };
}

function makeSkillResult(summary: string, extras: Partial<SkillResult> = {}): SkillResult {
  return { summary, alerts: [], approvals: [], ...extras };
}

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// timedRun
// ---------------------------------------------------------------------------

describe("timedRun", () => {
  it("captures fulfilled result with duration", async () => {
    const result = await timedRun(() => Promise.resolve({ summary: "ok", alerts: [], approvals: [] }));
    expect(result.status).toBe("fulfilled");
    expect(result.value?.summary).toBe("ok");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("captures rejected result with error", async () => {
    const result = await timedRun(() => Promise.reject(new Error("boom")));
    expect(result.status).toBe("rejected");
    expect(result.reason?.message).toBe("boom");
  });

  it("captures SkippedAgentError", async () => {
    const result = await timedRun(() => Promise.reject(new SkippedAgentError("no creds")));
    expect(result.status).toBe("rejected");
    expect(isSkipped(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// agentResult
// ---------------------------------------------------------------------------

describe("agentResult", () => {
  it("returns fulfilled value directly", () => {
    const r = agentResult("ASO", {
      status: "fulfilled",
      value: { summary: "good", alerts: [] },
      durationMs: 100,
    });
    expect(r.summary).toBe("good");
  });

  it("returns skip message for SkippedAgentError", () => {
    const r = agentResult("ASO", {
      status: "rejected",
      reason: new SkippedAgentError("missing creds"),
      durationMs: 0,
    });
    expect(r.summary).toContain("skipped");
    expect(r.summary).toContain("missing creds");
  });

  it("returns failure message for generic error", () => {
    const r = agentResult("ASO", {
      status: "rejected",
      reason: new Error("crash"),
      durationMs: 50,
    });
    expect(r.summary).toContain("failed");
    expect(r.summary).toContain("crash");
  });
});

// ---------------------------------------------------------------------------
// formatBriefingText
// ---------------------------------------------------------------------------

describe("formatBriefingText", () => {
  it("includes app name and all sections", () => {
    const text = formatBriefingText({
      appName: "Fridgify",
      date: "2026-04-12",
      nextDate: "2026-04-19",
      aso: { summary: "ASO results" },
      onboarding: null,
      reviews: { summary: "Review results" },
      sdkRequests: null,
      seoBlog: null,
      shortForm: null,
      content: null,
      webMetrics: null,
    });
    expect(text).toContain("Fridgify");
    expect(text).toContain("ASO results");
    expect(text).toContain("Review results");
    expect(text).toContain("2026-04-19");
  });
});

// ---------------------------------------------------------------------------
// collectApprovalItems
// ---------------------------------------------------------------------------

describe("collectApprovalItems", () => {
  it("collects approvals from all skill results", () => {
    const items = collectApprovalItems(
      {
        appName: "Fridgify",
        date: "2026-04-12",
        nextDate: "2026-04-19",
        aso: {
          summary: "ok",
          approvals: [{ id: "aso-1", description: "Metadata change", agent: "aso" }],
        },
        reviews: {
          summary: "ok",
          approvals: [{ id: "review-1", description: "Reply drafts", agent: "review" }],
        },
        onboarding: null,
        sdkRequests: null,
        seoBlog: null,
        shortForm: null,
        content: null,
        webMetrics: null,
      },
      "fridgify",
    );
    expect(items).toHaveLength(2);
    expect(items[0]!.agent).toBe("aso");
    expect(items[1]!.agent).toBe("review");
  });

  it("returns empty for no approvals", () => {
    const items = collectApprovalItems(
      {
        appName: "Fridgify",
        date: "2026-04-12",
        nextDate: "2026-04-19",
        aso: { summary: "ok" },
        reviews: null,
        onboarding: null,
        sdkRequests: null,
        seoBlog: null,
        shortForm: null,
        content: null,
        webMetrics: null,
      },
      "fridgify",
    );
    expect(items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runWeeklyAnalysis integration
// ---------------------------------------------------------------------------

describe("runWeeklyAnalysis", () => {
  it("dispatches all skills and sends briefing", async () => {
    const messenger = makeMockMessenger();
    const dispatchers: WeeklySkillDispatchers = {
      aso: vi.fn().mockResolvedValue(makeSkillResult("ASO done")),
      review: vi.fn().mockResolvedValue(makeSkillResult("Reviews done")),
      onboarding: vi.fn().mockResolvedValue(makeSkillResult("Onboarding done")),
      seoBlog: vi.fn().mockResolvedValue(makeSkillResult("SEO done")),
      shortForm: vi.fn().mockResolvedValue(makeSkillResult("ShortForm done")),
      sdkRequest: vi.fn().mockResolvedValue(makeSkillResult("SDK done")),
      content: vi.fn().mockResolvedValue(makeSkillResult("Content done")),
    };

    await runWeeklyAnalysis({
      db,
      config: makeConfig(),
      apps: [makeApp()],
      messenger,
      dispatchers,
    });

    // All skills dispatched
    expect(vi.mocked(dispatchers.aso)).toHaveBeenCalled();
    expect(vi.mocked(dispatchers.review)).toHaveBeenCalled();
    expect(vi.mocked(dispatchers.onboarding)).toHaveBeenCalled();
    expect(vi.mocked(dispatchers.seoBlog)).toHaveBeenCalled();
    expect(vi.mocked(dispatchers.shortForm)).toHaveBeenCalled();
    expect(vi.mocked(dispatchers.content)).toHaveBeenCalled();

    // Briefing sent
    expect(vi.mocked(messenger.sendText)).toHaveBeenCalled();
    const sentText = vi.mocked(messenger.sendText).mock.calls
      .map((c) => c[1])
      .join("\n");
    expect(sentText).toContain("Fridgify");
  });

  it("handles skill failures gracefully", async () => {
    const messenger = makeMockMessenger();
    const dispatchers: WeeklySkillDispatchers = {
      aso: vi.fn().mockRejectedValue(new Error("ASO crash")),
      review: vi.fn().mockResolvedValue(makeSkillResult("Reviews ok")),
      onboarding: vi.fn().mockRejectedValue(new SkippedAgentError("no SDK")),
      seoBlog: vi.fn().mockResolvedValue(makeSkillResult("SEO ok")),
      shortForm: vi.fn().mockResolvedValue(makeSkillResult("SF ok")),
      sdkRequest: vi.fn().mockResolvedValue(makeSkillResult("SDK ok")),
      content: vi.fn().mockResolvedValue(makeSkillResult("Content ok")),
    };

    // Should not throw
    await runWeeklyAnalysis({
      db,
      config: makeConfig(),
      apps: [makeApp()],
      messenger,
      dispatchers,
    });

    // Briefing still sent with failure/skip summaries
    expect(vi.mocked(messenger.sendText)).toHaveBeenCalled();
  });

  it("skips inactive apps", async () => {
    const messenger = makeMockMessenger();
    const dispatchers: WeeklySkillDispatchers = {
      aso: vi.fn().mockResolvedValue(makeSkillResult("ASO")),
      review: vi.fn().mockResolvedValue(makeSkillResult("Review")),
      onboarding: vi.fn().mockResolvedValue(makeSkillResult("OB")),
      seoBlog: vi.fn().mockResolvedValue(makeSkillResult("SEO")),
      shortForm: vi.fn().mockResolvedValue(makeSkillResult("SF")),
      sdkRequest: vi.fn().mockResolvedValue(makeSkillResult("SDK")),
      content: vi.fn().mockResolvedValue(makeSkillResult("Content")),
    };

    await runWeeklyAnalysis({
      db,
      config: makeConfig(),
      apps: [makeApp({ active: false })],
      messenger,
      dispatchers,
    });

    expect(vi.mocked(dispatchers.aso)).not.toHaveBeenCalled();
  });

  it("sends approval items to messenger", async () => {
    const messenger = makeMockMessenger();
    const dispatchers: WeeklySkillDispatchers = {
      aso: vi.fn().mockResolvedValue(
        makeSkillResult("ASO", {
          approvals: [{ id: "aso-meta-1", description: "Update title", agent: "aso" }],
        }),
      ),
      review: vi.fn().mockResolvedValue(makeSkillResult("Review")),
      onboarding: vi.fn().mockResolvedValue(makeSkillResult("OB")),
      seoBlog: vi.fn().mockResolvedValue(makeSkillResult("SEO")),
      shortForm: vi.fn().mockResolvedValue(makeSkillResult("SF")),
      sdkRequest: vi.fn().mockResolvedValue(makeSkillResult("SDK")),
      content: vi.fn().mockResolvedValue(makeSkillResult("Content")),
    };

    await runWeeklyAnalysis({
      db,
      config: makeConfig(),
      apps: [makeApp()],
      messenger,
      dispatchers,
    });

    expect(vi.mocked(messenger.sendApproval)).toHaveBeenCalled();
  });
});
