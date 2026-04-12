/* eslint-disable @typescript-eslint/unbound-method */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase } from "../../src/db/schema.js";
import {
  insertReview,
  updateReviewSentiment,
} from "../../src/db/queries.js";
import { runDailyMonitor, _test } from "../../src/orchestrator/monitor.js";
import type { MessengerAdapter } from "../../src/messenger/adapter.js";
import type { AdariaConfig, ThresholdsConfig } from "../../src/config/schema.js";
import type { AppConfig } from "../../src/config/apps-schema.js";
import type { MonitorAlert } from "../../src/orchestrator/types.js";

const {
  checkNegativeReviewRatio,
  checkOneStarReviews,
} = _test;

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
    social: { twitter: false, facebook: false, threads: false, tiktok: false, youtube: false, linkedin: false },
    active: true,
    ...overrides,
  };
}

function makeThresholds(overrides: Partial<ThresholdsConfig> = {}): ThresholdsConfig {
  return {
    keywordRankAlert: 5,
    reviewSentimentAlert: 0.3,
    oneStarReviewAlert: 3,
    installSignupDropAlert: 0.15,
    subscriptionDropAlert: 0.2,
    seoClicksDropAlert: 0.3,
    seoImpressionsDropAlert: 0.3,
    webTrafficDropAlert: 0.25,
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
    thresholds: makeThresholds(),
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

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// checkOneStarReviews
// ---------------------------------------------------------------------------

describe("checkOneStarReviews", () => {
  it("fires alert when 1-star count exceeds threshold", () => {
    // Insert 4 one-star reviews
    for (let i = 0; i < 4; i++) {
      insertReview(db, {
        app_id: "fridgify",
        platform: "ios",
        review_id: `rev-${String(i)}`,
        rating: 1,
        body: "Bad",
      });
    }

    const alerts: MonitorAlert[] = [];
    checkOneStarReviews(db, makeApp(), makeThresholds({ oneStarReviewAlert: 3 }), alerts);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("warning");
    expect(alerts[0]!.message).toContain("1-star");
  });

  it("does not fire when below threshold", () => {
    insertReview(db, {
      app_id: "fridgify",
      platform: "ios",
      review_id: "rev-1",
      rating: 1,
      body: "Bad",
    });

    const alerts: MonitorAlert[] = [];
    checkOneStarReviews(db, makeApp(), makeThresholds({ oneStarReviewAlert: 5 }), alerts);
    expect(alerts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkNegativeReviewRatio
// ---------------------------------------------------------------------------

describe("checkNegativeReviewRatio", () => {
  it("fires alert when negative ratio exceeds threshold", () => {
    // 3 negative, 1 positive = 75% negative
    for (let i = 0; i < 3; i++) {
      insertReview(db, {
        app_id: "fridgify",
        platform: "ios",
        review_id: `neg-${String(i)}`,
        rating: 1,
        body: "Bad",
      });
      updateReviewSentiment(db, `neg-${String(i)}`, "negative");
    }
    insertReview(db, {
      app_id: "fridgify",
      platform: "ios",
      review_id: "pos-1",
      rating: 5,
      body: "Great",
    });
    updateReviewSentiment(db, "pos-1", "positive");

    const alerts: MonitorAlert[] = [];
    checkNegativeReviewRatio(db, makeApp(), makeThresholds({ reviewSentimentAlert: 0.3 }), alerts);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
// runDailyMonitor integration
// ---------------------------------------------------------------------------

describe("runDailyMonitor", () => {
  it("runs all checks without throwing", async () => {
    const messenger = makeMockMessenger();

    await runDailyMonitor({
      db,
      config: makeConfig(),
      apps: [makeApp()],
      messenger,
    });

    // No alerts on empty DB
    expect(vi.mocked(messenger.sendText)).not.toHaveBeenCalled();
  });

  it("skips inactive apps", async () => {
    const messenger = makeMockMessenger();

    // Insert data that would trigger alerts for an active app
    for (let i = 0; i < 5; i++) {
      insertReview(db, {
        app_id: "fridgify",
        platform: "ios",
        review_id: `rev-${String(i)}`,
        rating: 1,
        body: "Terrible",
      });
    }

    await runDailyMonitor({
      db,
      config: makeConfig(),
      apps: [makeApp({ active: false })],
      messenger,
    });

    // No alerts because app is inactive
    expect(vi.mocked(messenger.sendText)).not.toHaveBeenCalled();
  });

  it("sends alerts to briefing channel", async () => {
    const messenger = makeMockMessenger();

    // Create enough 1-star reviews to trigger alert
    for (let i = 0; i < 5; i++) {
      insertReview(db, {
        app_id: "fridgify",
        platform: "ios",
        review_id: `bad-${String(i)}`,
        rating: 1,
        body: "Awful",
      });
    }

    await runDailyMonitor({
      db,
      config: makeConfig(),
      apps: [makeApp()],
      messenger,
    });

    // Should have sent at least the 1-star alert
    expect(vi.mocked(messenger.sendText)).toHaveBeenCalled();
  });
});
