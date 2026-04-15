/**
 * Content Skill — generates weekly content drafts (short-form scripts,
 * Pinterest pins, blog posts). Uses Claude CLI instead of the
 * Anthropic SDK directly (growth-agent used SDK; adaria-ai standardizes
 * on CLI runner for all Claude calls).
 *
 * Ported from growth-agent `src/agents/content-agent.js`.
 *
 * NOTE: This skill overlaps with ShortFormSkill. The checklist notes
 * "Port or fold into short-form.ts — decide during port." Decision:
 * keep separate because ContentAgent generates Pinterest pins and
 * trend-research content that ShortFormSkill doesn't cover.
 */

import type { Skill } from "./index.js";
import { parseAppNameFromCommand } from "./index.js";
import type { SkillContext, SkillResult } from "../types/skill.js";
import type { AppConfig } from "../config/apps-schema.js";
import { warn as logWarn } from "../utils/logger.js";
import { resolveBrandContextForApp } from "../brands/context.js";

function brandBlock(brandContext: string): string {
  return brandContext ? `\n\n## Brand context\n${brandContext}` : "";
}

export class ContentSkill implements Skill {
  readonly name = "content";
  readonly commands = ["content"] as const;

  async dispatch(ctx: SkillContext, text: string): Promise<SkillResult> {
    const appName = parseAppNameFromCommand(text);
    const app = appName
      ? ctx.apps.find((a) => a.id.toLowerCase() === appName)
      : ctx.apps[0];

    if (!app) {
      return {
        summary: appName ? `❌ App "${appName}" not found.` : "❌ No apps configured.",
        alerts: [],
        approvals: [],
      };
    }

    return this.generate(ctx, app);
  }

  async generate(ctx: SkillContext, app: AppConfig): Promise<SkillResult> {
    const trendKeywords = app.primaryKeywords.slice(0, 10);
    const brandContext = await resolveBrandContextForApp(app.id);

    // Generate content types in parallel
    const [scripts, pins] = await Promise.all([
      this.generateShortFormScripts(ctx, app, trendKeywords, 3, brandContext),
      this.generatePinterestPins(ctx, app, trendKeywords, 5, brandContext),
    ]);

    const lines = [`*🟢 Content — ${app.name}*`];
    lines.push(
      `• ${String(scripts.length)} short-form scripts · ${String(pins.length)} Pinterest pins`,
    );

    return { summary: lines.join("\n"), alerts: [], approvals: [] };
  }

  private async generateShortFormScripts(
    ctx: SkillContext,
    app: AppConfig,
    keywords: string[],
    count: number,
    brandContext = "",
  ): Promise<unknown[]> {
    const prompt = `Generate ${String(count)} short-form video scripts (TikTok/Reels) to promote the ${app.name} app.

## App: ${app.name}
## Target keywords: ${keywords.join(", ")}

## Production guide
- Format: faceless — screen recording, text overlays, AI voiceover
- Hook (first 3s): start with a problem statement, shocking stat, or question
- Body (15-25s): walk through app usage step by step
- CTA: "Link in bio" or "Search in the App Store"
- Each script should use a different angle${brandBlock(brandContext)}

Respond with JSON only:
[{"title":"...","hook":"...","body":"...","cta":"...","hashtags":["#tag1"]}]`;

    try {
      const raw = await ctx.runClaude(prompt);
      const parsed = JSON.parse(raw) as unknown[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      logWarn(`[content] Short-form script generation failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private async generatePinterestPins(
    ctx: SkillContext,
    app: AppConfig,
    keywords: string[],
    count: number,
    brandContext = "",
  ): Promise<unknown[]> {
    const prompt = `Generate ${String(count)} Pinterest pin copies for the ${app.name} app.

App: ${app.name}
Related keywords: ${keywords.join(", ")}

Each pin must include a title, description, and hashtags. Write in English.${brandBlock(brandContext)}

Respond with JSON only:
[{"title":"Pin title","description":"Pin description","hashtags":["#tag1"]}]`;

    try {
      const raw = await ctx.runClaude(prompt);
      const parsed = JSON.parse(raw) as unknown[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      logWarn(`[content] Pinterest pin generation failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
}
