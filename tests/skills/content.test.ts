import { describe, it, expect, vi } from "vitest";
import { ContentSkill } from "../../src/skills/content.js";
import type { SkillContext } from "../../src/types/skill.js";
import type { AppConfig } from "../../src/config/apps-schema.js";
import type { AdariaConfig } from "../../src/config/schema.js";

const testApp: AppConfig = {
  id: "fridgify", name: "Fridgify", platform: ["ios"],
  primaryKeywords: ["recipe app", "meal planner"], competitors: [],
  locale: ["en"], features: { fridgifyRecipes: false }, active: true,
};

const testConfig: AdariaConfig = {
  slack: { botToken: "t", appToken: "t", signingSecret: "s" },
  claude: { mode: "cli", cliBinary: "claude", apiKey: null, timeoutMs: 120_000 },
  security: { allowedUsers: [], dmOnly: false, auditLog: { enabled: true, maskSecrets: true } },
  safety: { dangerousActionsRequireApproval: true, approvalTimeoutMinutes: 30 },
  agent: { showThinking: true }, collectors: {},
};

function createCtx(): SkillContext {
  return {
    db: undefined as never,
    apps: [testApp],
    config: testConfig,
    runClaude: vi.fn().mockResolvedValue('[{"title":"Script 1","hook":"Hook","body":"Body","cta":"CTA","hashtags":["#test"]}]'),
  };
}

describe("ContentSkill", () => {
  it("generates short-form scripts and Pinterest pins in parallel", async () => {
    const skill = new ContentSkill();
    const ctx = createCtx();

    const result = await skill.dispatch(ctx, "content fridgify");

    expect(ctx.runClaude).toHaveBeenCalledTimes(2); // scripts + pins
    expect(result.summary).toContain("Content");
    expect(result.summary).toContain("Fridgify");
  });

  it("returns error for unknown app", async () => {
    const skill = new ContentSkill();
    const ctx = createCtx();

    const result = await skill.dispatch(ctx, "content nonexistent");
    expect(result.summary).toContain("not found");
  });

  it("handles Claude errors gracefully", async () => {
    const skill = new ContentSkill();
    const ctx = createCtx();
    (ctx.runClaude as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fail"));

    const result = await skill.dispatch(ctx, "content fridgify");
    expect(result.summary).toContain("0 short-form scripts");
  });
});
