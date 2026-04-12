import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OnboardingSkill, type OnboardingSkillDeps } from "../../src/skills/onboarding.js";
import { initDatabase } from "../../src/db/schema.js";
import type { SkillContext } from "../../src/types/skill.js";
import type { AppConfig } from "../../src/config/apps-schema.js";
import type { AdariaConfig } from "../../src/config/schema.js";
import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adaria-onboard-test-"));
  return path.join(dir, "test.db");
}

const testApp: AppConfig = {
  id: "fridgify", name: "Fridgify", platform: ["ios"],
  appStoreId: "123", primaryKeywords: [], competitors: [],
  locale: ["en"], features: { fridgifyRecipes: false }, active: true,
};

const testConfig: AdariaConfig = {
  slack: { botToken: "t", appToken: "t", signingSecret: "s" },
  claude: { mode: "cli", cliBinary: "claude", apiKey: null, timeoutMs: 120_000 },
  security: { allowedUsers: [], dmOnly: false, auditLog: { enabled: true, maskSecrets: true } },
  safety: { dangerousActionsRequireApproval: true, approvalTimeoutMinutes: 30 },
  agent: { showThinking: true }, collectors: {},
};

function createMockDeps(): OnboardingSkillDeps {
  return {
    sdkCollector: {
      getSummary: vi.fn().mockResolvedValue([
        { date: "2026-04-01", installs: 100, core_actions: 50, subscriptions: 5 },
      ]),
      getFunnel: vi.fn().mockResolvedValue({
        funnel: [
          { step: "app_install", count: 100, rate: 1.0, drop_rate: 0 },
          { step: "core_action", count: 50, rate: 0.5, drop_rate: 0.5 },
          { step: "subscribe_start", count: 5, rate: 0.05, drop_rate: 0.9 },
        ],
        overall_conversion: 0.05,
      }),
      getCohort: vi.fn().mockResolvedValue([
        { cohort_size: 100, retention: [1.0, 0.4, 0.3, 0.25, 0.2] },
      ]),
    },
  };
}

function createCtx(db: Database.Database): SkillContext {
  return {
    db, apps: [testApp], config: testConfig,
    runClaude: vi.fn().mockResolvedValue('{"hypotheses":[{"cause":"Complex onboarding","suggestion":"Simplify"}],"sdkRequests":[]}'),
  };
}

describe("OnboardingSkill", () => {
  let db: Database.Database;

  beforeEach(() => { db = initDatabase(tmpDbPath()); });
  afterEach(() => { try { db.close(); } catch { /* */ } });

  it("collects summary and persists to DB", async () => {
    const skill = new OnboardingSkill(createMockDeps());
    const ctx = createCtx(db);

    await skill.dispatch(ctx, "onboarding fridgify");

    const rows = db.prepare("SELECT * FROM sdk_events").all();
    expect(rows).toHaveLength(3); // install, signup, subscription
  });

  it("detects high dropoff and creates alert", async () => {
    const skill = new OnboardingSkill(createMockDeps());
    const ctx = createCtx(db);

    const result = await skill.dispatch(ctx, "onboarding fridgify");

    // subscribe_start has 90% dropoff > 50% threshold
    expect(result.alerts.length).toBeGreaterThan(0);
    expect(result.alerts[0]!.message).toContain("dropoff");
  });

  it("builds summary with conversion rates", async () => {
    const skill = new OnboardingSkill(createMockDeps());
    const ctx = createCtx(db);

    const result = await skill.dispatch(ctx, "onboarding fridgify");

    expect(result.summary).toContain("Onboarding");
    expect(result.summary).toContain("Fridgify");
    expect(result.summary).toContain("conversion");
  });

  it("includes hypotheses in summary", async () => {
    const skill = new OnboardingSkill(createMockDeps());
    const ctx = createCtx(db);

    const result = await skill.dispatch(ctx, "onboarding fridgify");

    expect(result.summary).toContain("Likely cause");
  });

  it("handles SDK collector errors gracefully", async () => {
    const deps: OnboardingSkillDeps = {
      sdkCollector: {
        getSummary: vi.fn().mockRejectedValue(new Error("API down")),
        getFunnel: vi.fn().mockResolvedValue({ funnel: [], overall_conversion: 0 }),
        getCohort: vi.fn().mockResolvedValue([]),
      },
    };
    const skill = new OnboardingSkill(deps);
    const ctx = createCtx(db);

    const result = await skill.dispatch(ctx, "onboarding fridgify");
    expect(result.summary).toBeDefined();
  });
});
