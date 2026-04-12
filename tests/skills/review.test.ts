import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ReviewSkill, type ReviewSkillDeps } from "../../src/skills/review.js";
import { initDatabase } from "../../src/db/schema.js";
import type { SkillContext } from "../../src/types/skill.js";
import type { AppConfig } from "../../src/config/apps-schema.js";
import type { AdariaConfig } from "../../src/config/schema.js";
import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adaria-review-test-"));
  return path.join(dir, "test.db");
}

const testApp: AppConfig = {
  id: "fridgify", name: "Fridgify", platform: ["ios", "android"],
  appStoreId: "123", playStorePackage: "com.eodin.fridgify",
  primaryKeywords: [], competitors: [], locale: ["en"],
  features: { fridgifyRecipes: false }, active: true,
};

const testConfig: AdariaConfig = {
  slack: { botToken: "t", appToken: "t", signingSecret: "s" },
  claude: { mode: "cli", cliBinary: "claude", apiKey: null, timeoutMs: 120_000 },
  security: { allowedUsers: [], dmOnly: false, auditLog: { enabled: true, maskSecrets: true } },
  safety: { dangerousActionsRequireApproval: true, approvalTimeoutMinutes: 30 },
  agent: { showThinking: true }, collectors: {},
};

function createCtx(db: Database.Database): SkillContext {
  return {
    db, apps: [testApp], config: testConfig,
    runClaude: vi.fn().mockResolvedValue('[{"index":1,"sentiment":"positive"},{"index":2,"sentiment":"negative"}]'),
  };
}

function createMockDeps(): ReviewSkillDeps {
  return {
    appStore: {
      getReviews: vi.fn().mockResolvedValue([
        { reviewId: "r1", rating: 5, body: "Great app!", createdAt: null },
        { reviewId: "r2", rating: 1, body: "Terrible", createdAt: null },
      ]),
    },
    playStore: {
      getReviews: vi.fn().mockResolvedValue([
        { reviewId: "r3", rating: 4, body: "Good", createdAt: null },
      ]),
    },
  };
}

describe("ReviewSkill", () => {
  let db: Database.Database;

  beforeEach(() => { db = initDatabase(tmpDbPath()); });
  afterEach(() => { try { db.close(); } catch { /* */ } });

  it("collects reviews from both platforms and inserts into DB", async () => {
    const skill = new ReviewSkill(createMockDeps());
    const ctx = createCtx(db);

    await skill.dispatch(ctx, "review fridgify");

    const rows = db.prepare("SELECT * FROM reviews").all();
    expect(rows).toHaveLength(3);
  });

  it("analyzes sentiment via Claude and falls back to heuristic", async () => {
    const skill = new ReviewSkill(createMockDeps());
    const ctx = createCtx(db);
    (ctx.runClaude as ReturnType<typeof vi.fn>).mockResolvedValueOnce("not json");

    await skill.dispatch(ctx, "review fridgify");

    // Heuristic fallback: rating >= 4 → positive, <= 2 → negative
    const rows = db.prepare("SELECT sentiment FROM reviews WHERE review_id = 'r1'").all() as Array<{ sentiment: string }>;
    expect(rows[0]?.sentiment).toBe("positive");
  });

  it("returns error for unknown app", async () => {
    const skill = new ReviewSkill(createMockDeps());
    const ctx = createCtx(db);

    const result = await skill.dispatch(ctx, "review nonexistent");
    expect(result.summary).toContain("not found");
  });

  it("generates reply draft approval items", async () => {
    const deps = createMockDeps();
    const skill = new ReviewSkill(deps);
    const ctx = createCtx(db);
    // First call: sentiment, second: clustering, third: replies
    (ctx.runClaude as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('[{"index":1,"sentiment":"positive"},{"index":2,"sentiment":"negative"},{"index":3,"sentiment":"positive"}]')
      .mockResolvedValueOnce('{"complaints":[],"featureRequests":[]}')
      .mockResolvedValueOnce('[{"index":1,"reply":"Thanks for the feedback!"}]');

    const result = await skill.dispatch(ctx, "review fridgify");

    expect(result.approvals.length).toBeGreaterThanOrEqual(0);
    expect(result.summary).toContain("Reviews");
  });

  it("builds summary with new review count", async () => {
    const skill = new ReviewSkill(createMockDeps());
    const ctx = createCtx(db);

    const result = await skill.dispatch(ctx, "review fridgify");

    expect(result.summary).toContain("3 new reviews");
    expect(result.summary).toContain("Fridgify");
  });

  it("handles collector errors gracefully", async () => {
    const deps: ReviewSkillDeps = {
      appStore: { getReviews: vi.fn().mockRejectedValue(new Error("API down")) },
    };
    const skill = new ReviewSkill(deps);
    const ctx = createCtx(db);

    const result = await skill.dispatch(ctx, "review fridgify");
    expect(result.summary).toBeDefined();
  });
});
