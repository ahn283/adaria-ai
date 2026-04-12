/**
 * Review Skill — collects reviews, analyzes sentiment, clusters
 * complaints, and generates reply drafts.
 *
 * Ported from growth-agent `src/agents/review-agent.js`.
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
import type { StoreReview } from "../types/collectors.js";
import {
  insertReview,
  getRecentReviews,
  updateReviewSentiment,
  updateReplyDraft,
  getSentimentSummary,
} from "../db/queries.js";
import { preparePrompt } from "../prompts/loader.js";
import { warn as logWarn } from "../utils/logger.js";
import { sanitizeExternalText } from "../security/prompt-guard.js";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Strip common prompt-injection patterns from user-authored review text. */
function sanitizeReviewBody(text: string, maxLen = 200): string {
  return sanitizeExternalText(text, maxLen);
}

const DEFAULT_NEGATIVE_RATIO_THRESHOLD = 0.4;

export interface ReviewSkillDeps {
  appStore?: { getReviews: (appId: string) => Promise<StoreReview[]> };
  playStore?: { getReviews: (packageName: string) => Promise<StoreReview[]> };
}

export class ReviewSkill implements Skill {
  readonly name = "review";
  readonly commands = ["review", "reviews"] as const;

  private readonly deps: ReviewSkillDeps;

  constructor(deps: ReviewSkillDeps) {
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
          ? `❌ App "${appName}" not found in apps.yaml.`
          : "❌ No apps configured.",
        alerts: [],
        approvals: [],
      };
    }

    return this.analyzeReviews(ctx, app);
  }

  async analyzeReviews(ctx: SkillContext, app: AppConfig): Promise<SkillResult> {
    const alerts: SkillAlert[] = [];
    const approvals: ApprovalItem[] = [];

    // 1. Collect new reviews
    const newReviews = await this.collectReviews(ctx, app);

    // 2. Analyze sentiment via Claude
    if (newReviews.length > 0) {
      await this.analyzeSentiment(ctx, newReviews);
    }

    // 3. Get sentiment summary
    const sentimentStats = this.getSentimentStats(ctx, app.id);

    // 4. Check alert threshold
    if (sentimentStats.negativeRatio > DEFAULT_NEGATIVE_RATIO_THRESHOLD) {
      alerts.push({
        severity: "high",
        message: `Negative review ratio ${(sentimentStats.negativeRatio * 100).toFixed(1)}% exceeds threshold`,
      });
    }

    // 5. Cluster complaints and feature requests
    let topComplaints: Array<{ topic: string }> = [];
    if (newReviews.length > 0) {
      const clusters = await this.clusterReviews(ctx, app, newReviews);
      topComplaints = clusters.complaints ?? [];
    }

    // 6. Generate reply drafts
    const unreplied = getRecentReviews(ctx.db, app.id, 7).filter(
      (r) => !r.reply_draft && r.sentiment,
    );
    const replyDrafts: Array<{ reviewId: string; reply: string }> = [];
    if (unreplied.length > 0) {
      const drafts = await this.generateReplyDrafts(ctx, app, unreplied);
      replyDrafts.push(...drafts);

      for (const draft of drafts) {
        approvals.push({
          id: `review-reply-${draft.reviewId}`,
          description: `Reply draft for review ${draft.reviewId}`,
          agent: "review",
          payload: draft,
        });
      }
    }

    // 7. Build summary
    const summary = this.buildSummary(
      app, alerts, newReviews.length, sentimentStats,
      topComplaints, replyDrafts.length,
    );

    return { summary, alerts, approvals };
  }

  private async collectReviews(
    ctx: SkillContext,
    app: AppConfig,
  ): Promise<Array<StoreReview & { platform: string }>> {
    const allReviews: Array<StoreReview & { platform: string }> = [];

    if (app.platform.includes("ios") && this.deps.appStore && app.appStoreId) {
      try {
        const reviews = await this.deps.appStore.getReviews(app.appStoreId);
        for (const r of reviews) {
          const result = insertReview(ctx.db, {
            app_id: app.id,
            platform: "ios",
            review_id: r.reviewId,
            rating: r.rating,
            body: r.body,
          });
          if (result.changes > 0) allReviews.push({ ...r, platform: "ios" });
        }
      } catch (err) {
        logWarn(`[review] iOS review collection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (app.platform.includes("android") && this.deps.playStore && app.playStorePackage) {
      try {
        const reviews = await this.deps.playStore.getReviews(app.playStorePackage);
        for (const r of reviews) {
          const result = insertReview(ctx.db, {
            app_id: app.id,
            platform: "android",
            review_id: r.reviewId,
            rating: r.rating,
            body: r.body,
          });
          if (result.changes > 0) allReviews.push({ ...r, platform: "android" });
        }
      } catch (err) {
        logWarn(`[review] Android review collection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return allReviews;
  }

  private async analyzeSentiment(
    ctx: SkillContext,
    reviews: Array<StoreReview & { platform: string }>,
  ): Promise<void> {
    const reviewsBlock = reviews
      .map((r, i) => `<review index="${String(i + 1)}" rating="${String(r.rating)}">${escapeXml(sanitizeReviewBody(r.body ?? "(no content)"))}</review>`)
      .join("\n");

    const prompt = preparePrompt("review-sentiment", { reviewsBlock });

    try {
      const raw = await ctx.runClaude(prompt);
      const sentiments = JSON.parse(raw) as Array<{ index: number; sentiment: string }>;

      if (Array.isArray(sentiments)) {
        for (const s of sentiments) {
          const review = reviews[s.index - 1];
          if (review && ["positive", "negative", "neutral"].includes(s.sentiment)) {
            updateReviewSentiment(ctx.db, review.reviewId, s.sentiment);
          }
        }
        return;
      }
    } catch {
      // Fallback to rating-based heuristic
    }

    for (const review of reviews) {
      const sentiment = review.rating >= 4 ? "positive" : review.rating <= 2 ? "negative" : "neutral";
      updateReviewSentiment(ctx.db, review.reviewId, sentiment);
    }
  }

  private getSentimentStats(ctx: SkillContext, appId: string) {
    const summary = getSentimentSummary(ctx.db, appId, 7);
    const total = summary.reduce((sum, s) => sum + s.count, 0);
    const negative = summary.find((s) => s.sentiment === "negative")?.count ?? 0;
    const positive = summary.find((s) => s.sentiment === "positive")?.count ?? 0;

    return {
      total,
      positive,
      negative,
      neutral: total - positive - negative,
      negativeRatio: total > 0 ? negative / total : 0,
    };
  }

  private async clusterReviews(
    ctx: SkillContext,
    app: AppConfig,
    reviews: Array<StoreReview & { platform: string }>,
  ): Promise<{ complaints: Array<{ topic: string }>; featureRequests: Array<{ feature: string }> }> {
    const negativeReviews = reviews.filter((r) => r.rating <= 3);
    if (negativeReviews.length === 0) return { complaints: [], featureRequests: [] };

    const reviewsBlock = negativeReviews
      .map((r, i) => `<review index="${String(i + 1)}" rating="${String(r.rating)}">${escapeXml(sanitizeReviewBody(r.body ?? ""))}</review>`)
      .join("\n");

    const prompt = preparePrompt("review-clustering", {
      appName: app.name,
      reviewCount: String(negativeReviews.length),
      reviewsBlock,
    });

    try {
      const raw = await ctx.runClaude(prompt);
      return JSON.parse(raw) as { complaints: Array<{ topic: string }>; featureRequests: Array<{ feature: string }> };
    } catch {
      return { complaints: [], featureRequests: [] };
    }
  }

  private async generateReplyDrafts(
    ctx: SkillContext,
    app: AppConfig,
    reviews: Array<{ review_id: string; rating: number; sentiment: string | null; body: string | null }>,
  ): Promise<Array<{ reviewId: string; reply: string }>> {
    const reviewsBlock = reviews
      .map((r, i) => `<review index="${String(i + 1)}" rating="${String(r.rating)}" sentiment="${r.sentiment ?? "unknown"}">${escapeXml(sanitizeReviewBody(r.body ?? ""))}</review>`)
      .join("\n");

    const prompt = preparePrompt("review-replies", {
      appName: app.name,
      reviewsBlock,
    });

    try {
      const raw = await ctx.runClaude(prompt);
      const replies = JSON.parse(raw) as Array<{ index: number; reply: string }>;
      const drafts: Array<{ reviewId: string; reply: string }> = [];

      if (Array.isArray(replies)) {
        for (const r of replies) {
          const review = reviews[r.index - 1];
          if (review && r.reply) {
            updateReplyDraft(ctx.db, review.review_id, r.reply);
            drafts.push({ reviewId: review.review_id, reply: r.reply });
          }
        }
      }
      return drafts;
    } catch {
      return [];
    }
  }

  private buildSummary(
    app: AppConfig,
    alerts: SkillAlert[],
    newReviewCount: number,
    sentimentStats: { positive: number; negative: number },
    topComplaints: Array<{ topic: string }>,
    replyDraftCount: number,
  ): string {
    const header = alerts.length > 0
      ? `*🟡 [Action] Reviews — ${app.name}*`
      : `*🟢 Reviews — ${app.name}*`;

    const lines = [
      header,
      `• ${String(newReviewCount)} new reviews (positive ${String(sentimentStats.positive)} / negative ${String(sentimentStats.negative)})`,
    ];

    if (topComplaints.length > 0) {
      lines.push(`• Top complaint: "${topComplaints[0]!.topic}"`);
    }

    if (replyDraftCount > 0) {
      lines.push(`• ${String(replyDraftCount)} reply drafts ready`);
    }

    return lines.join("\n");
  }
}
