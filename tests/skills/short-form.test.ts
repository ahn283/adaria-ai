import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ShortFormSkill, type ShortFormSkillDeps } from "../../src/skills/short-form.js";
import { initDatabase } from "../../src/db/schema.js";
import type { SkillContext } from "../../src/types/skill.js";
import type { AppConfig } from "../../src/config/apps-schema.js";
import type { AdariaConfig } from "../../src/config/schema.js";
import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adaria-sf-test-"));
  return path.join(dir, "test.db");
}

const testApp: AppConfig = {
  id: "fridgify", name: "Fridgify", platform: ["ios"],
  appStoreId: "123", youtubeChannelId: "UC123",
  primaryKeywords: ["recipe app"], competitors: [], locale: ["en"],
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
    runClaude: vi.fn().mockResolvedValue('{"ideas":[{"title":"Idea 1"},{"title":"Idea 2"}]}'),
  };
}

describe("ShortFormSkill", () => {
  let db: Database.Database;

  beforeEach(() => { db = initDatabase(tmpDbPath()); });
  afterEach(() => { try { db.close(); } catch { /* */ } });

  it("collects YouTube performance and inserts into DB", async () => {
    const deps: ShortFormSkillDeps = {
      youtube: {
        getRecentShorts: vi.fn().mockResolvedValue([
          { videoId: "v1", title: "Short 1", publishedAt: null, views: 1000, likes: 50, comments: 5, duration: "PT30S" },
        ]),
      },
    };
    const skill = new ShortFormSkill(deps);
    const ctx = createCtx(db);

    await skill.dispatch(ctx, "shortform fridgify");

    const rows = db.prepare("SELECT * FROM short_form_performance").all();
    expect(rows).toHaveLength(1);
  });

  it("generates ideas via Claude", async () => {
    const skill = new ShortFormSkill({});
    const ctx = createCtx(db);

    const result = await skill.dispatch(ctx, "shortform fridgify");

    expect(result.summary).toContain("2 new ideas");
  });

  it("builds summary with performance data", async () => {
    const deps: ShortFormSkillDeps = {
      youtube: {
        getRecentShorts: vi.fn().mockResolvedValue([
          { videoId: "v1", title: "S1", publishedAt: null, views: 500, likes: 20, comments: 3, duration: "PT20S" },
          { videoId: "v2", title: "S2", publishedAt: null, views: 800, likes: 40, comments: 5, duration: "PT25S" },
        ]),
      },
    };
    const skill = new ShortFormSkill(deps);
    const ctx = createCtx(db);

    const result = await skill.dispatch(ctx, "shortform fridgify");

    expect(result.summary).toContain("1,300 views");
  });
});
