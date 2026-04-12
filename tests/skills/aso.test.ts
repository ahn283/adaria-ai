import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AsoSkill, type AsoSkillDeps } from "../../src/skills/aso.js";
import { initDatabase } from "../../src/db/schema.js";
import type { SkillContext } from "../../src/types/skill.js";
import type { AppConfig } from "../../src/config/apps-schema.js";
import type { AdariaConfig } from "../../src/config/schema.js";
import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adaria-aso-test-"));
  return path.join(dir, "test.db");
}

const testApp: AppConfig = {
  id: "fridgify",
  name: "Fridgify",
  platform: ["ios", "android"],
  appStoreId: "123456",
  playStorePackage: "com.eodin.fridgify",
  primaryKeywords: ["recipe app", "meal planner", "food tracker"],
  competitors: ["comp1"],
  locale: ["en"],
  features: { fridgifyRecipes: true },
  social: { twitter: false, facebook: false, threads: false, tiktok: false, youtube: false, linkedin: false },
  active: true,
};

const testConfig: AdariaConfig = {
  slack: { botToken: "xoxb-test", appToken: "xapp-test", signingSecret: "secret" },
  claude: { mode: "cli", cliBinary: "claude", apiKey: null, timeoutMs: 120_000 },
  security: { allowedUsers: [], dmOnly: false, auditLog: { enabled: true, maskSecrets: true } },
  safety: { dangerousActionsRequireApproval: true, approvalTimeoutMinutes: 30 },
  agent: { showThinking: true, weeklyTimeoutMs: 900_000 },
  social: {},
  thresholds: { keywordRankAlert: 5, reviewSentimentAlert: 0.3, oneStarReviewAlert: 3, installSignupDropAlert: 0.15, subscriptionDropAlert: 0.2, seoClicksDropAlert: 0.3, seoImpressionsDropAlert: 0.3, webTrafficDropAlert: 0.25 },
  collectors: {},
};

function createMockDeps(): AsoSkillDeps {
  return {
    asoMobile: {
      getKeywordRankings: vi.fn().mockResolvedValue([
        { keyword: "recipe app", rank: 5, searchVolume: 1200 },
        { keyword: "meal planner", rank: 12, searchVolume: 800 },
      ]),
      getKeywordSuggestions: vi.fn().mockResolvedValue([
        { keyword: "cooking helper", searchVolume: 500, competition: 20 },
        { keyword: "grocery list", searchVolume: 300, competition: 30 },
      ]),
      getCompetitorInfo: vi.fn().mockResolvedValue({
        title: "Comp App",
        subtitle: "Best recipes",
        description: "A recipe app",
        keywords: ["recipe", "food"],
      }),
    },
    appStore: {
      getAppLocalizations: vi.fn().mockResolvedValue({
        name: "Fridgify - Recipe Manager",
        subtitle: "Smart meal planning",
        description: "Track your fridge ingredients and discover recipes...",
      }),
    },
  };
}

function createCtx(db: Database.Database, apps: AppConfig[] = [testApp]): SkillContext {
  return {
    db,
    apps,
    config: testConfig,
    runClaude: vi.fn().mockResolvedValue('{"title":"New Title","subtitle":"New Sub","keywords":"kw1,kw2","reasoning":"Data-driven"}'),
  };
}

describe("AsoSkill", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase(tmpDbPath());
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("dispatches with app name from command text", async () => {
    const deps = createMockDeps();
    const skill = new AsoSkill(deps);
    const ctx = createCtx(db);

    const result = await skill.dispatch(ctx, "aso fridgify");

    expect(result.summary).toContain("Fridgify");
    expect(result.alerts).toBeInstanceOf(Array);
    expect(result.approvals).toBeInstanceOf(Array);
  });

  it("falls back to first app if no app name provided", async () => {
    const deps = createMockDeps();
    const skill = new AsoSkill(deps);
    const ctx = createCtx(db);

    const result = await skill.dispatch(ctx, "aso");

    expect(result.summary).toContain("Fridgify");
  });

  it("returns error message for unknown app", async () => {
    const deps = createMockDeps();
    const skill = new AsoSkill(deps);
    const ctx = createCtx(db);

    const result = await skill.dispatch(ctx, "aso nonexistent");

    expect(result.summary).toContain("not found");
    expect(result.summary).toContain("nonexistent");
  });

  it("returns error when no apps configured", async () => {
    const deps = createMockDeps();
    const skill = new AsoSkill(deps);
    const ctx = createCtx(db, []);

    const result = await skill.dispatch(ctx, "aso");

    expect(result.summary).toContain("No apps configured");
  });

  it("collects keyword rankings and inserts into DB", async () => {
    const deps = createMockDeps();
    const skill = new AsoSkill(deps);
    const ctx = createCtx(db);

    await skill.dispatch(ctx, "aso fridgify");

    // Should have called getKeywordRankings for both platforms
    expect(deps.asoMobile.getKeywordRankings).toHaveBeenCalledTimes(2);

    // Check DB insertions
    const rows = db.prepare("SELECT * FROM keyword_rankings").all();
    expect(rows.length).toBe(4); // 2 keywords × 2 platforms
  });

  it("finds opportunities from keyword suggestions", async () => {
    const deps = createMockDeps();
    const skill = new AsoSkill(deps);
    const ctx = createCtx(db);

    const result = await skill.dispatch(ctx, "aso fridgify");

    expect(deps.asoMobile.getKeywordSuggestions).toHaveBeenCalled();
    expect(result.summary).toContain("opportunities");
  });

  it("detects competitor metadata changes", async () => {
    const deps = createMockDeps();
    const skill = new AsoSkill(deps);
    const ctx = createCtx(db);

    // First run — no previous data, no changes detected
    const result1 = await skill.dispatch(ctx, "aso fridgify");

    expect(deps.asoMobile.getCompetitorInfo).toHaveBeenCalled();
    // Competitor data inserted into DB
    const rows = db.prepare("SELECT * FROM competitor_metadata").all();
    expect(rows.length).toBeGreaterThan(0);

    // Competitor change won't show on first run (no previous to compare)
    expect(result1.summary).not.toContain("Competitor metadata change");
  });

  it("generates metadata proposal when opportunities exist", async () => {
    const deps = createMockDeps();
    const skill = new AsoSkill(deps);
    const ctx = createCtx(db);

    await skill.dispatch(ctx, "aso fridgify");

    // runClaude should have been called for metadata, screenshots, in-app events
    expect(ctx.runClaude).toHaveBeenCalled();
  });

  it("generates screenshot suggestions with combined keywords", async () => {
    const deps = createMockDeps();
    const skill = new AsoSkill(deps);
    const ctx = createCtx(db);

    const result = await skill.dispatch(ctx, "aso fridgify");

    expect(result.summary).toContain("Screenshot caption suggestions");
  });

  it("generates in-app event suggestions for iOS apps only", async () => {
    const deps = createMockDeps();
    const skill = new AsoSkill(deps);
    const ctx = createCtx(db);

    const result = await skill.dispatch(ctx, "aso fridgify");

    expect(result.summary).toContain("In-App Events");
  });

  it("skips in-app events for Android-only apps", async () => {
    const deps = createMockDeps();
    const skill = new AsoSkill(deps);

    const androidApp: AppConfig = {
      ...testApp,
      id: "android-app",
      name: "Android App",
      platform: ["android"],
    };
    const ctx = createCtx(db, [androidApp]);

    const result = await skill.dispatch(ctx, "aso android-app");

    expect(result.summary).not.toContain("In-App Events");
  });

  it("builds summary with stable rankings message when no changes", async () => {
    const deps = createMockDeps();
    // No rankings → no rank changes
    deps.asoMobile.getKeywordRankings = vi.fn().mockResolvedValue([]);
    // No opportunities
    deps.asoMobile.getKeywordSuggestions = vi.fn().mockResolvedValue([]);

    const skill = new AsoSkill(deps);
    // Android-only + no competitors + no keywords → nothing to report
    const quietApp: AppConfig = {
      ...testApp,
      platform: ["android"],
      competitors: [],
      primaryKeywords: [],
    };
    const ctx = createCtx(db, [quietApp]);

    const result = await skill.dispatch(ctx, "aso fridgify");

    expect(result.summary).toContain("Keyword rankings stable");
  });

  it("creates approval items when metadata proposal is generated", async () => {
    const deps = createMockDeps();
    const skill = new AsoSkill(deps);
    const ctx = createCtx(db);

    const result = await skill.dispatch(ctx, "aso fridgify");

    // Opportunities exist → metadata proposal generated → approval item
    expect(result.approvals.length).toBeGreaterThan(0);
    expect(result.approvals[0]!.id).toBe("aso-meta-fridgify");
    expect(result.approvals[0]!.agent).toBe("aso");
  });

  it("handles collector errors gracefully", async () => {
    const deps = createMockDeps();
    deps.asoMobile.getKeywordRankings = vi.fn().mockRejectedValue(new Error("API down"));
    deps.asoMobile.getKeywordSuggestions = vi.fn().mockRejectedValue(new Error("API down"));

    const skill = new AsoSkill(deps);
    const ctx = createCtx(db);

    // Should not throw — errors are caught and logged
    const result = await skill.dispatch(ctx, "aso fridgify");
    expect(result.summary).toBeDefined();
  });

  it("handles Claude errors gracefully in metadata generation", async () => {
    const deps = createMockDeps();
    const skill = new AsoSkill(deps);
    const ctx = createCtx(db);
    (ctx.runClaude as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Claude down"));

    const result = await skill.dispatch(ctx, "aso fridgify");

    // Should still produce a summary, just without metadata proposal
    expect(result.summary).toBeDefined();
    expect(result.approvals).toHaveLength(0); // no proposal → no approval
  });
});
