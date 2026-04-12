/**
 * ASO Skill — App Store Optimization analysis.
 *
 * Ported from growth-agent `src/agents/aso-agent.js`. Analyzes keyword
 * visibility, detects rank drops, discovers opportunities, tracks
 * competitor metadata changes, and generates metadata improvement
 * proposals via Claude.
 *
 * 65-80% of installs come from organic search, making this the
 * highest-impact skill in the weekly briefing.
 */

import type { Skill } from "./index.js";
import { parseAppNameFromCommand } from "./index.js";
import type {
  SkillContext,
  SkillResult,
  SkillAlert,
  ApprovalItem,
} from "../types/skill.js";
import type { AppConfig } from "../config/apps-schema.js";
import type { AsoKeywordRanking, AsoCompetitorInfo } from "../types/collectors.js";
import {
  insertKeywordRanking,
  getKeywordRankChange,
  insertCompetitorMetadata,
  getPreviousCompetitorMetadata,
} from "../db/queries.js";
import { preparePrompt } from "../prompts/loader.js";
import { warn as logWarn } from "../utils/logger.js";

// TODO(M5.5): AsoCompetitorInfo.description is attacker-controllable.
// When db-query.ts exposes competitor_metadata, raw descriptions in the
// DB become an indirect prompt injection vector. M5.5 must either:
// (a) strip/sanitize descriptions via prompt-guard before DB insert, or
// (b) ensure db-query.ts never returns the description column.
// For now, descriptions stored in diffs are truncated to 200 chars.
const MAX_DESCRIPTION_LEN = 200;

/** Threshold for keyword rank drops that trigger alerts. */
const DEFAULT_RANK_ALERT_THRESHOLD = 5;

interface RankChange {
  keyword: string;
  platform: string;
  currentRank: number;
  previousRank: number;
  drop: number;
  searchVolume: number | null;
}

interface Opportunity {
  keyword: string;
  platform: string;
  searchVolume: number | null;
  competition: number | null;
}

interface CompetitorChange {
  competitorId: string;
  platform: string;
  diffs: Array<{ field: string; old: string | null; new: string | null }>;
}

interface AsoCollectors {
  getKeywordRankings: (
    appId: string,
    platform: string,
    keywords: string[],
  ) => Promise<AsoKeywordRanking[]>;
  getKeywordSuggestions: (
    appId: string,
    platform: string,
    locale: string,
  ) => Promise<Array<{ keyword: string; searchVolume: number | null; competition: number | null }>>;
  getCompetitorInfo: (
    competitorId: string,
    platform: string,
  ) => Promise<AsoCompetitorInfo>;
}

interface AppStoreCollectors {
  getAppLocalizations?: (
    appId: string,
    locale: string,
  ) => Promise<{ name?: string; subtitle?: string; description?: string } | null>;
}

/**
 * Injected collector dependencies. Skills receive these via SkillContext
 * or directly — M4 passes them as constructor args until M5 wires a
 * unified CollectorRegistry.
 */
export interface AsoSkillDeps {
  asoMobile: AsoCollectors;
  appStore?: AppStoreCollectors;
}

export class AsoSkill implements Skill {
  readonly name = "aso";
  readonly commands = ["aso"] as const;

  private readonly deps: AsoSkillDeps;

  constructor(deps: AsoSkillDeps) {
    this.deps = deps;
  }

  async dispatch(ctx: SkillContext, text: string): Promise<SkillResult> {
    const appName = parseAppNameFromCommand(text);
    const app = appName
      ? ctx.apps.find((a) => a.id.toLowerCase() === appName)
      : ctx.apps[0];

    if (!app) {
      return {
        summary: appName
          ? `❌ App "${appName}" not found in apps.yaml. Available: ${ctx.apps.map((a) => a.id).join(", ")}`
          : "❌ No apps configured. Add apps to apps.yaml.",
        alerts: [],
        approvals: [],
      };
    }

    return this.analyzeAso(ctx, app);
  }

  async analyzeAso(ctx: SkillContext, app: AppConfig): Promise<SkillResult> {
    const alerts: SkillAlert[] = [];
    const approvals: ApprovalItem[] = [];

    // 1. Collect current keyword rankings
    const rankings = await this.collectKeywordRankings(ctx, app);

    // 2. Calculate rank changes vs last week
    const rankChanges = this.calculateRankChanges(ctx, app, rankings);

    // 3. Detect critical drops
    const criticalDrops = rankChanges.filter(
      (c) => c.drop >= DEFAULT_RANK_ALERT_THRESHOLD,
    );
    for (const drop of criticalDrops) {
      alerts.push({
        severity: "high",
        message: `"${drop.keyword}" (${drop.platform}) rank ${String(drop.previousRank)} → ${String(drop.currentRank)} (drop -${String(drop.drop)})`,
      });
    }

    // 4. Find new keyword opportunities
    const opportunities = await this.findOpportunities(app);

    // 5. Detect competitor metadata changes
    const competitorChanges = await this.detectCompetitorChanges(ctx, app);

    // 6. Generate metadata improvement proposal via Claude
    let metadataProposal: string | null = null;
    if (alerts.length > 0 || opportunities.length > 0 || competitorChanges.length > 0) {
      metadataProposal = await this.generateMetadataProposal(
        ctx, app, rankChanges, opportunities,
      );
      if (metadataProposal) {
        approvals.push({
          id: `aso-meta-${app.id}`,
          description: `ASO metadata change proposal for ${app.name}`,
          agent: "aso",
          payload: { proposal: metadataProposal },
        });
      }
    }

    // 7. Screenshot caption suggestions
    const screenshotSuggestions = await this.generateScreenshotSuggestions(
      ctx, app, opportunities,
    );

    // 8. In-App Events suggestions (iOS only)
    const inAppEventSuggestions = await this.generateInAppEventSuggestions(
      ctx, app,
    );

    // 9. Build summary
    const summary = this.buildSummary(
      app, alerts, rankChanges, opportunities, competitorChanges,
      screenshotSuggestions, inAppEventSuggestions,
    );

    return { summary, alerts, approvals };
  }

  private async collectKeywordRankings(
    ctx: SkillContext,
    app: AppConfig,
  ): Promise<Array<AsoKeywordRanking & { platform: string }>> {
    const collected: Array<AsoKeywordRanking & { platform: string }> = [];

    for (const platform of app.platform) {
      const storeId = platform === "ios" ? app.appStoreId : app.playStorePackage;
      if (!storeId) continue;

      try {
        const rankings = await this.deps.asoMobile.getKeywordRankings(
          storeId, platform, app.primaryKeywords,
        );

        for (const r of rankings) {
          insertKeywordRanking(ctx.db, {
            app_id: app.id,
            keyword: r.keyword,
            platform,
            rank: r.rank,
            search_volume: r.searchVolume,
          });
          collected.push({ ...r, platform });
        }
      } catch (err) {
        logWarn(
          `[aso] Keyword ranking collection failed for ${app.id}/${platform}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return collected;
  }

  private calculateRankChanges(
    ctx: SkillContext,
    app: AppConfig,
    currentRankings: Array<AsoKeywordRanking & { platform: string }>,
  ): RankChange[] {
    const changes: RankChange[] = [];

    for (const ranking of currentRankings) {
      const change = getKeywordRankChange(
        ctx.db, app.id, ranking.keyword, ranking.platform,
      );

      if (change.current_rank != null && change.previous_rank != null) {
        const drop = change.current_rank - change.previous_rank;
        changes.push({
          keyword: ranking.keyword,
          platform: ranking.platform,
          currentRank: change.current_rank,
          previousRank: change.previous_rank,
          drop,
          searchVolume: ranking.searchVolume,
        });
      }
    }

    return changes.sort((a, b) => b.drop - a.drop);
  }

  private async findOpportunities(app: AppConfig): Promise<Opportunity[]> {
    const opportunities: Opportunity[] = [];

    for (const platform of app.platform) {
      const storeId = platform === "ios" ? app.appStoreId : app.playStorePackage;
      if (!storeId) continue;

      try {
        const suggestions = await this.deps.asoMobile.getKeywordSuggestions(
          storeId, platform, app.locale[0] ?? "ko",
        );

        const existing = new Set(
          app.primaryKeywords.map((k) => k.toLowerCase()),
        );
        const filtered = suggestions.filter(
          (s) =>
            s.searchVolume != null &&
            s.searchVolume > 100 &&
            s.competition != null &&
            s.competition < 40 &&
            !existing.has(s.keyword.toLowerCase()),
        );

        for (const s of filtered.slice(0, 5)) {
          opportunities.push({ ...s, platform });
        }
      } catch (err) {
        logWarn(
          `[aso] Keyword suggestions failed for ${app.id}/${platform}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return opportunities;
  }

  private async detectCompetitorChanges(
    ctx: SkillContext,
    app: AppConfig,
  ): Promise<CompetitorChange[]> {
    const competitors = app.competitors;
    if (competitors.length === 0) return [];

    const tasks: Array<Promise<CompetitorChange | null>> = [];
    for (const competitorId of competitors) {
      for (const platform of app.platform) {
        tasks.push(
          this.fetchAndCompareCompetitor(ctx, app, competitorId, platform),
        );
      }
    }

    const results = await Promise.allSettled(tasks);
    return results
      .filter(
        (r): r is PromiseFulfilledResult<CompetitorChange> =>
          r.status === "fulfilled" && r.value !== null,
      )
      .map((r) => r.value);
  }

  private async fetchAndCompareCompetitor(
    ctx: SkillContext,
    app: AppConfig,
    competitorId: string,
    platform: string,
  ): Promise<CompetitorChange | null> {
    try {
      const current = await this.deps.asoMobile.getCompetitorInfo(
        competitorId, platform,
      );

      insertCompetitorMetadata(ctx.db, {
        app_id: app.id,
        competitor_id: competitorId,
        platform,
        title: current.title,
        subtitle: current.subtitle,
        description: current.description,
        keywords: current.keywords,
      });

      const previous = getPreviousCompetitorMetadata(
        ctx.db, app.id, competitorId, platform,
      );
      if (previous) {
        const diffs: CompetitorChange["diffs"] = [];
        if (previous.title !== current.title) {
          diffs.push({ field: "title", old: previous.title, new: current.title });
        }
        if (previous.subtitle !== current.subtitle) {
          diffs.push({ field: "subtitle", old: previous.subtitle, new: current.subtitle });
        }
        if (previous.description !== current.description) {
          diffs.push({
            field: "description",
            old: previous.description ? previous.description.slice(0, MAX_DESCRIPTION_LEN) : previous.description,
            new: current.description ? current.description.slice(0, MAX_DESCRIPTION_LEN) : current.description,
          });
        }
        const prevKw = previous.keywords ?? "";
        const currKw = Array.isArray(current.keywords)
          ? current.keywords.join(",")
          : (current.keywords ?? "");
        if (prevKw !== currKw) {
          diffs.push({ field: "keywords", old: previous.keywords, new: currKw });
        }

        if (diffs.length > 0) {
          return { competitorId, platform, diffs };
        }
      }
    } catch (err) {
      logWarn(
        `[aso] Competitor fetch failed for ${competitorId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return null;
  }

  private async generateMetadataProposal(
    ctx: SkillContext,
    app: AppConfig,
    rankChanges: RankChange[],
    opportunities: Opportunity[],
  ): Promise<string | null> {
    const currentMetadata = await this.getCurrentMetadata(app);

    const rankChangesText = rankChanges.length > 0
      ? rankChanges
          .map(
            (c) =>
              `- "${c.keyword}" (${c.platform}): rank ${String(c.previousRank)} → ${String(c.currentRank)} (${c.drop > 0 ? "+" + String(c.drop) : String(c.drop)}) | volume ${c.searchVolume != null ? String(c.searchVolume) : "N/A"}`,
          )
          .join("\n")
      : "No changes";

    const opportunitiesText = opportunities.length > 0
      ? opportunities
          .map(
            (o) =>
              `- "${o.keyword}" (${o.platform}): volume ${o.searchVolume != null ? String(o.searchVolume) : "N/A"}, competition ${o.competition != null ? String(o.competition) : "N/A"}`,
          )
          .join("\n")
      : "None";

    const metadataText = currentMetadata
      ? `## Current metadata\n- Title: ${currentMetadata.name ?? ""}\n- Subtitle: ${currentMetadata.subtitle ?? ""}\n- Description (first 200 chars): ${currentMetadata.description?.slice(0, 200) ?? ""}...`
      : "";

    const prompt = preparePrompt("aso-metadata", {
      appName: app.name,
      primaryKeywords: app.primaryKeywords.join(", "),
      rankChanges: rankChangesText,
      opportunities: opportunitiesText,
      currentMetadata: metadataText,
    });

    try {
      return await ctx.runClaude(prompt);
    } catch (err) {
      logWarn(
        `[aso] Metadata proposal generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async generateScreenshotSuggestions(
    ctx: SkillContext,
    app: AppConfig,
    opportunities: Opportunity[],
  ): Promise<string | null> {
    const keywords = [
      ...app.primaryKeywords,
      ...opportunities.map((o) => o.keyword),
    ].slice(0, 10);

    if (keywords.length === 0) return null;

    const prompt = preparePrompt("aso-screenshots", {
      appName: app.name,
      keywords: keywords.join(", "),
    });

    try {
      return await ctx.runClaude(prompt);
    } catch (err) {
      logWarn(
        `[aso] Screenshot suggestions failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async generateInAppEventSuggestions(
    ctx: SkillContext,
    app: AppConfig,
  ): Promise<string | null> {
    if (!app.platform.includes("ios")) return null;

    const prompt = preparePrompt("aso-inapp-events", {
      appName: app.name,
      keywords: app.primaryKeywords.join(", "),
    });

    try {
      return await ctx.runClaude(prompt);
    } catch (err) {
      logWarn(
        `[aso] In-App Events suggestions failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async getCurrentMetadata(
    app: AppConfig,
  ): Promise<{ name?: string; subtitle?: string; description?: string } | null> {
    if (!this.deps.appStore?.getAppLocalizations) return null;
    try {
      if (app.platform.includes("ios") && app.appStoreId) {
        return await this.deps.appStore.getAppLocalizations(
          app.appStoreId, app.locale[0] ?? "ko",
        );
      }
    } catch {
      // metadata fetch failure is non-fatal
    }
    return null;
  }

  private buildSummary(
    app: AppConfig,
    alerts: SkillAlert[],
    rankChanges: RankChange[],
    opportunities: Opportunity[],
    competitorChanges: CompetitorChange[],
    screenshotSuggestions: string | null,
    inAppEventSuggestions: string | null,
  ): string {
    const hasAlert = alerts.length > 0;
    const header = hasAlert
      ? `*🔴 [Urgent] ASO — ${app.name}*`
      : `*🟢 ASO — ${app.name}*`;
    const lines = [header];

    if (hasAlert) {
      const top = rankChanges.find((c) => c.drop >= DEFAULT_RANK_ALERT_THRESHOLD);
      if (top) {
        lines.push(
          `• "${top.keyword}" rank ${String(top.previousRank)} → ${String(top.currentRank)} (drop -${String(top.drop)})`,
        );
      }
    }

    const rising = rankChanges.filter((c) => c.drop < 0);
    if (rising.length > 0) {
      lines.push(
        `• 🟢 ${String(rising.length)} rising keywords: ${rising.slice(0, 3).map((c) => `"${c.keyword}" +${String(Math.abs(c.drop))}`).join(", ")}`,
      );
    }

    if (opportunities.length > 0) {
      lines.push(
        `• 💡 ${String(opportunities.length)} new opportunities: ${opportunities.slice(0, 3).map((o) => `"${o.keyword}"`).join(", ")}`,
      );
    }

    if (competitorChanges.length > 0) {
      const comps = competitorChanges.map((c) => c.competitorId);
      lines.push(`• 🔵 Competitor metadata change detected: ${comps.join(", ")}`);
    }

    if (screenshotSuggestions) {
      lines.push("• 📸 Screenshot caption suggestions ready");
    }

    if (inAppEventSuggestions) {
      lines.push("• 📅 In-App Events suggestions ready");
    }

    if (lines.length === 1) {
      lines.push("• Keyword rankings stable");
    }

    return lines.join("\n");
  }
}
