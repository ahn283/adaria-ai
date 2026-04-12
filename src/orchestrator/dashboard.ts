/**
 * Cross-app comparison dashboard.
 *
 * Ported from growth-agent `src/dashboard.js`. Generates a mrkdwn summary
 * comparing keyword rankings, funnel metrics, review sentiment, and web
 * traffic across all active apps.
 */

import type Database from "better-sqlite3";
import type { AppConfig } from "../config/apps-schema.js";
import {
  getRecentKeywordRankings,
  getFunnelConversion,
  getSentimentSummary,
  getSeoTotals,
  getWebTrafficTotals,
  getTopBlogPerformance,
} from "../db/queries.js";

interface AppMetrics {
  id: string;
  name: string;
  keywords: KeywordMetrics;
  funnel: FunnelMetrics;
  reviews: ReviewMetrics;
  web: WebDashboardMetrics;
}

interface KeywordMetrics {
  tracked: number;
  avgRank: number | null;
  topKeyword: { keyword: string; rank: number } | null;
}

interface FunnelMetrics {
  install: number;
  signup: number;
  subscription: number;
  installToSignup: number | null;
  signupToSubscription: number | null;
}

interface ReviewMetrics {
  total: number;
  positive: number;
  negative: number;
  sentimentScore: number | null;
}

interface WebDashboardMetrics {
  seoClicks: number;
  seoImpressions: number;
  avgCtr: number;
  avgPosition: number;
  sessions: number;
  users: number;
  bounceRate: number;
  topBlogs: Array<{ slug: string; pv: number }>;
}

export interface DashboardResult {
  apps: AppMetrics[];
  summary: string;
}

export class Dashboard {
  constructor(private readonly db: Database.Database) {}

  generate(
    apps: AppConfig[],
    startDate: string,
    endDate: string,
  ): DashboardResult {
    const appMetrics = apps.map((app) => ({
      id: app.id,
      name: app.name,
      keywords: this.getKeywordMetrics(app.id),
      funnel: this.getFunnelMetrics(app.id, startDate, endDate),
      reviews: this.getReviewMetrics(app.id),
      web: this.getWebMetrics(startDate, endDate),
    }));

    return {
      apps: appMetrics,
      summary: this.buildComparisonSummary(appMetrics),
    };
  }

  private getKeywordMetrics(appId: string): KeywordMetrics {
    const rankings = getRecentKeywordRankings(this.db, appId, 7);
    if (rankings.length === 0) {
      return { tracked: 0, avgRank: null, topKeyword: null };
    }

    const avgRank =
      rankings.reduce((sum, r) => sum + (r.rank ?? 0), 0) / rankings.length;

    const top = rankings.reduce<(typeof rankings)[number] | null>(
      (best, r) =>
        r.rank != null && (best === null || r.rank < (best.rank ?? Infinity))
          ? r
          : best,
      null,
    );

    return {
      tracked: rankings.length,
      avgRank: Math.round(avgRank * 10) / 10,
      topKeyword: top ? { keyword: top.keyword, rank: top.rank! } : null,
    };
  }

  private getFunnelMetrics(
    appId: string,
    startDate: string,
    endDate: string,
  ): FunnelMetrics {
    const data = getFunnelConversion(this.db, appId, startDate, endDate);
    const map: Record<string, number> = {};
    for (const row of data) {
      map[row.event_name] = row.total;
    }

    const install = map["install"] ?? 0;
    const signup = map["signup"] ?? 0;
    const subscription = map["subscription"] ?? 0;

    return {
      install,
      signup,
      subscription,
      installToSignup: install > 0 ? signup / install : null,
      signupToSubscription: signup > 0 ? subscription / signup : null,
    };
  }

  private getReviewMetrics(appId: string): ReviewMetrics {
    const summary = getSentimentSummary(this.db, appId, 7);
    const total = summary.reduce((sum, s) => sum + s.count, 0);
    const positive =
      summary.find((s) => s.sentiment === "positive")?.count ?? 0;
    const negative =
      summary.find((s) => s.sentiment === "negative")?.count ?? 0;

    return {
      total,
      positive,
      negative,
      sentimentScore: total > 0 ? positive / total : null,
    };
  }

  private getWebMetrics(
    startDate: string,
    endDate: string,
  ): WebDashboardMetrics {
    const seo = getSeoTotals(this.db, startDate, endDate);
    const traffic = getWebTrafficTotals(this.db, startDate, endDate);
    const topBlogs = getTopBlogPerformance(this.db, startDate, endDate, 3);

    return {
      seoClicks: seo?.total_clicks ?? 0,
      seoImpressions: seo?.total_impressions ?? 0,
      avgCtr: seo?.avg_ctr ?? 0,
      avgPosition: seo?.avg_position ?? 0,
      sessions: traffic?.total_sessions ?? 0,
      users: traffic?.total_users ?? 0,
      bounceRate: traffic?.avg_bounce_rate ?? 0,
      topBlogs: topBlogs.map((b) => ({ slug: b.slug, pv: b.total_pv })),
    };
  }

  private buildComparisonSummary(appMetrics: AppMetrics[]): string {
    if (appMetrics.length <= 1) return "";

    const lines = ["*Cross-app performance*"];

    for (const app of appMetrics) {
      const parts = [`*${app.name}*`];

      if (app.funnel.installToSignup != null) {
        parts.push(
          `conv ${(app.funnel.installToSignup * 100).toFixed(1)}%`,
        );
      }
      if (app.reviews.sentimentScore != null) {
        parts.push(
          `positive ${(app.reviews.sentimentScore * 100).toFixed(0)}%`,
        );
      }
      if (app.keywords.avgRank != null) {
        parts.push(`avg rank ${String(app.keywords.avgRank)}`);
      }
      if (app.web.sessions > 0) {
        parts.push(`sessions ${String(app.web.sessions)}`);
      }
      if (app.web.seoClicks > 0) {
        parts.push(`SEO clicks ${String(app.web.seoClicks)}`);
      }

      lines.push(`\u2022 ${parts.join(" \u00b7 ")}`);
    }

    return lines.join("\n");
  }
}
