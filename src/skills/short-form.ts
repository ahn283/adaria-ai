/**
 * Short-form Skill — generates video ideas + AI prompts, collects
 * YouTube performance data.
 *
 * Ported from growth-agent `src/agents/short-form-agent.js`.
 */

import type { Skill } from "./index.js";
import { parseAppNameFromCommand } from "./index.js";
import type { SkillContext, SkillResult } from "../types/skill.js";
import type { AppConfig } from "../config/apps-schema.js";
import type { YouTubeVideoStats } from "../types/collectors.js";
import {
  upsertShortFormPerformance,
  getRecentShortFormPerformance,
} from "../db/queries.js";
import { preparePrompt } from "../prompts/loader.js";
import { warn as logWarn } from "../utils/logger.js";

export interface ShortFormSkillDeps {
  youtube?: {
    getRecentShorts: (channelId: string, limit: number) => Promise<YouTubeVideoStats[]>;
  };
}

export class ShortFormSkill implements Skill {
  readonly name = "short-form";
  readonly commands = ["shortform", "short-form"] as const;

  private readonly deps: ShortFormSkillDeps;

  constructor(deps: ShortFormSkillDeps) {
    this.deps = deps;
  }

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

    return this.analyzeShortForm(ctx, app);
  }

  async analyzeShortForm(ctx: SkillContext, app: AppConfig): Promise<SkillResult> {
    // 1. Collect YouTube Shorts performance
    let performanceData: YouTubeVideoStats[] = [];
    if (app.youtubeChannelId && this.deps.youtube) {
      performanceData = await this.collectYouTubePerformance(ctx, app);
    }

    // 2. Get recent performance from DB
    const recentPerformance = getRecentShortFormPerformance(ctx.db, app.id, 14);
    const lastWeekPerformance = this.formatPerformanceData(recentPerformance);
    const topPerformingPatterns = this.findTopPatterns(recentPerformance);

    // 3. Generate ideas via Claude
    const prompt = preparePrompt("short-form-ideas", {
      appName: app.name,
      appDescription: "",
      primaryKeywords: app.primaryKeywords.join(", "),
      lastWeekPerformance,
      topPerformingPatterns,
      asoInsights: "Nothing notable",
      reviewInsights: "Nothing notable",
      webTrafficImpact: "No data",
    });

    let ideas: unknown[] = [];
    try {
      const raw = await ctx.runClaude(prompt);
      const result = JSON.parse(raw) as { ideas?: unknown[] };
      ideas = result.ideas ?? [];
    } catch {
      // Claude error is non-fatal
    }

    // 4. Build summary
    const summary = this.buildSummary(app, performanceData, ideas.length);

    return { summary, alerts: [], approvals: [] };
  }

  private async collectYouTubePerformance(
    ctx: SkillContext,
    app: AppConfig,
  ): Promise<YouTubeVideoStats[]> {
    try {
      const shorts = await this.deps.youtube!.getRecentShorts(app.youtubeChannelId!, 10);
      for (const video of shorts) {
        upsertShortFormPerformance(ctx.db, {
          app_id: app.id,
          platform: "youtube",
          video_id: video.videoId,
          title: video.title,
          views: video.views,
          likes: video.likes,
          comments: video.comments,
        });
      }
      return shorts;
    } catch (err) {
      logWarn(`[short-form] YouTube collection failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private formatPerformanceData(data: Array<{ title: string | null; views: number; likes: number }>): string {
    if (!data.length) return "No performance data (first week)";
    const totalViews = data.reduce((sum, d) => sum + d.views, 0);
    const totalLikes = data.reduce((sum, d) => sum + d.likes, 0);
    const lines = [`${String(data.length)} videos | ${totalViews.toLocaleString()} views | ${totalLikes.toLocaleString()} likes`];
    for (const video of data.slice(0, 5)) {
      lines.push(`- "${video.title ?? "Untitled"}" — ${video.views.toLocaleString()} views / ${String(video.likes)} likes`);
    }
    return lines.join("\n");
  }

  private findTopPatterns(data: Array<{ title: string | null; views: number; likes: number }>): string {
    if (!data.length) return "Insufficient data for pattern analysis";
    const sorted = [...data].sort((a, b) => b.views - a.views);
    const top = sorted[0]!;
    return `Best performer: "${top.title ?? "Untitled"}" (${top.views.toLocaleString()} views, ${String(top.likes)} likes)`;
  }

  private buildSummary(
    app: AppConfig,
    performanceData: YouTubeVideoStats[],
    ideaCount: number,
  ): string {
    const lines = [`*🎬 Short-form — ${app.name}*`];

    if (performanceData.length > 0) {
      const totalViews = performanceData.reduce((sum, d) => sum + d.views, 0);
      const totalLikes = performanceData.reduce((sum, d) => sum + d.likes, 0);
      lines.push(`• Last week: ${totalViews.toLocaleString()} views · ${totalLikes.toLocaleString()} likes`);
    } else {
      lines.push("• No performance data (first week or channel not configured)");
    }

    if (ideaCount > 0) {
      lines.push(`• ${String(ideaCount)} new ideas + AI prompts ready`);
    }

    return lines.join("\n");
  }
}
