import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase } from "../../src/db/schema.js";
import { SocialPublishSkill } from "../../src/skills/social-publish.js";
import type { SkillContext } from "../../src/types/skill.js";
import type { AppConfig } from "../../src/config/apps-schema.js";
import type { AdariaConfig } from "../../src/config/schema.js";

function makeApp(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    id: "fridgify",
    name: "Fridgify",
    platform: ["ios"],
    primaryKeywords: ["recipe", "fridge"],
    competitors: [],
    locale: [],
    features: { fridgifyRecipes: false },
    social: {
      twitter: true,
      facebook: true,
      threads: false,
      tiktok: false,
      youtube: false,
      linkedin: true,
    },
    active: true,
    ...overrides,
  };
}

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function makeCtx(
  runClaudeResult: string,
  apps: AppConfig[] = [makeApp()],
): SkillContext {
  return {
    db,
    apps,
    config: {} as AdariaConfig,
    runClaude: vi.fn().mockResolvedValue(runClaudeResult),
  };
}

describe("SocialPublishSkill", () => {
  it("generates approval items for enabled platforms", async () => {
    const claudeResponse = JSON.stringify([
      { platform: "twitter", text: "Check out Fridgify!", hashtags: ["Fridgify"] },
      { platform: "facebook", text: "Fridgify is amazing for recipes", hashtags: ["Fridgify", "Recipes"] },
      { platform: "linkedin", text: "Introducing Fridgify to the industry", hashtags: ["FoodTech"] },
    ]);

    const skill = new SocialPublishSkill({ socialConfigs: {} });
    const result = await skill.dispatch(
      makeCtx(claudeResponse),
      "social fridgify",
    );

    expect(result.approvals).toHaveLength(3);
    expect(result.approvals[0]!.agent).toBe("social-publish");
    expect(result.summary).toContain("3 platform(s)");
  });

  it("returns empty when no platforms enabled", async () => {
    const app = makeApp({
      social: {
        twitter: false,
        facebook: false,
        threads: false,
        tiktok: false,
        youtube: false,
        linkedin: false,
      },
    });

    const skill = new SocialPublishSkill({ socialConfigs: {} });
    const result = await skill.dispatch(
      makeCtx("[]", [app]),
      "social fridgify",
    );

    expect(result.approvals).toHaveLength(0);
    expect(result.summary).toContain("No social platforms enabled");
  });

  it("handles app not found", async () => {
    const skill = new SocialPublishSkill({ socialConfigs: {} });
    const result = await skill.dispatch(
      makeCtx("[]"),
      "social nonexistent",
    );

    expect(result.summary).toContain("not found");
  });

  it("handles Claude returning invalid JSON", async () => {
    const skill = new SocialPublishSkill({ socialConfigs: {} });
    const result = await skill.dispatch(
      makeCtx("This is not JSON at all"),
      "social fridgify",
    );

    expect(result.approvals).toHaveLength(0);
    expect(result.summary).toContain("Failed to generate");
  });

  it("handles Claude error gracefully", async () => {
    const ctx = makeCtx("");
    ctx.runClaude = vi.fn().mockRejectedValue(new Error("Claude down"));

    const skill = new SocialPublishSkill({ socialConfigs: {} });
    const result = await skill.dispatch(ctx, "social fridgify");

    expect(result.approvals).toHaveLength(0);
  });

  it("filters out platforms not in enabled list", async () => {
    // Claude returns content for all platforms but only twitter+linkedin enabled
    const app = makeApp({
      social: {
        twitter: true,
        facebook: false,
        threads: false,
        tiktok: false,
        youtube: false,
        linkedin: true,
      },
    });

    const claudeResponse = JSON.stringify([
      { platform: "twitter", text: "Tweet", hashtags: [] },
      { platform: "linkedin", text: "Professional post", hashtags: [] },
    ]);

    const skill = new SocialPublishSkill({ socialConfigs: {} });
    const result = await skill.dispatch(
      makeCtx(claudeResponse, [app]),
      "social fridgify",
    );

    expect(result.approvals).toHaveLength(2);
    expect(result.summary).toContain("2 platform(s)");
  });
});
