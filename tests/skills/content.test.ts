import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { ContentSkill } from "../../src/skills/content.js";
import type { SkillContext } from "../../src/types/skill.js";
import type { AppConfig } from "../../src/config/apps-schema.js";
import type { AdariaConfig } from "../../src/config/schema.js";

const testApp: AppConfig = {
  id: "fridgify", name: "Fridgify", platform: ["ios"],
  primaryKeywords: ["recipe app", "meal planner"], competitors: [],
  locale: ["en"], features: { fridgifyRecipes: false },
  social: { twitter: false, facebook: false, threads: false, tiktok: false, youtube: false, linkedin: false },
  active: true,
};

const testConfig: AdariaConfig = {
  slack: { botToken: "t", appToken: "t", signingSecret: "s" },
  claude: { mode: "cli", cliBinary: "claude", apiKey: null, timeoutMs: 120_000 },
  security: { allowedUsers: [], dmOnly: false, auditLog: { enabled: true, maskSecrets: true } },
  safety: { dangerousActionsRequireApproval: true, approvalTimeoutMinutes: 30 },
  agent: { showThinking: true, weeklyTimeoutMs: 900_000 },
  social: {},
  thresholds: { keywordRankAlert: 5, reviewSentimentAlert: 0.3, oneStarReviewAlert: 3, installSignupDropAlert: 0.15, subscriptionDropAlert: 0.2, seoClicksDropAlert: 0.3, seoImpressionsDropAlert: 0.3, webTrafficDropAlert: 0.25 },
  collectors: {},
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

  describe("brand context injection", () => {
    let tempHome: string;
    const originalHome = process.env["ADARIA_HOME"];

    beforeEach(async () => {
      tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "adaria-content-"));
      process.env["ADARIA_HOME"] = tempHome;
    });

    afterEach(async () => {
      await fs.rm(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env["ADARIA_HOME"];
      else process.env["ADARIA_HOME"] = originalHome;
    });

    it("omits the brand block when no brand.yaml exists", async () => {
      const skill = new ContentSkill();
      const ctx = createCtx();
      await skill.dispatch(ctx, "content fridgify");
      const prompts = (ctx.runClaude as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as string,
      );
      for (const p of prompts) {
        expect(p).not.toContain("## Brand context");
      }
    });

    it("injects sanitised brand context when brand.yaml exists", async () => {
      const dir = path.join(tempHome, "brands", "fridgify");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "brand.yaml"),
        `
_meta:
  serviceType: app
  generatedAt: "2026-04-16T00:00:00Z"
identity:
  tagline: Never waste food <script>alert(1)</script>
voice:
  tone: friendly, casual
`,
      );

      const skill = new ContentSkill();
      const ctx = createCtx();
      await skill.dispatch(ctx, "content fridgify");
      const prompts = (ctx.runClaude as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(prompts).toHaveLength(2);
      for (const p of prompts) {
        expect(p).toContain("## Brand context");
        expect(p).toContain("friendly, casual");
        // sanitizeExternalText strips raw HTML tags.
        expect(p).not.toContain("<script>");
      }
    });
  });
});
