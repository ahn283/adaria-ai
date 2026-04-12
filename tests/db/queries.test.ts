import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDatabase } from "../../src/db/schema.js";
import * as q from "../../src/db/queries.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adaria-q-test-"));
  return path.join(dir, "test.db");
}

describe("queries", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase(tmpDbPath());
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  // ── Keyword Rankings ──────────────────────────────────────

  describe("keyword rankings", () => {
    it("inserts and retrieves keyword rankings", () => {
      q.insertKeywordRanking(db, {
        app_id: "fridgify", keyword: "recipe app", platform: "ios", rank: 5, search_volume: 1000,
      });
      q.insertKeywordRanking(db, {
        app_id: "fridgify", keyword: "meal planner", platform: "ios", rank: 12, search_volume: 500,
      });

      const rows = q.getRecentKeywordRankings(db, "fridgify", 1);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.keyword).toBe("meal planner"); // DESC order
    });

    it("returns rank change between current and 7-day-ago snapshot", () => {
      q.insertKeywordRanking(db, {
        app_id: "fridgify", keyword: "recipe", platform: "ios", rank: 5, search_volume: 100,
      });

      const change = q.getKeywordRankChange(db, "fridgify", "recipe", "ios");
      expect(change.current_rank).toBe(5);
      expect(change.previous_rank).toBeNull(); // no 7-day-old data
    });
  });

  // ── SDK Events ────────────────────────────────────────────

  describe("sdk events", () => {
    it("upserts sdk events (insert then update)", () => {
      q.upsertSdkEvent(db, { app_id: "fridgify", event_name: "install", count: 10, date: "2026-04-01" });
      q.upsertSdkEvent(db, { app_id: "fridgify", event_name: "install", count: 15, date: "2026-04-01" });

      const rows = q.getSdkEventsByRange(db, "fridgify", "2026-04-01", "2026-04-01");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.count).toBe(15); // upserted
    });

    it("calculates funnel conversion", () => {
      q.upsertSdkEvent(db, { app_id: "app1", event_name: "install", count: 100, date: "2026-04-01" });
      q.upsertSdkEvent(db, { app_id: "app1", event_name: "signup", count: 50, date: "2026-04-01" });
      q.upsertSdkEvent(db, { app_id: "app1", event_name: "subscription", count: 10, date: "2026-04-01" });

      const funnel = q.getFunnelConversion(db, "app1", "2026-04-01", "2026-04-01");
      expect(funnel).toHaveLength(3);

      const installRow = funnel.find((r) => r.event_name === "install");
      expect(installRow?.total).toBe(100);
    });
  });

  // ── Reviews ───────────────────────────────────────────────

  describe("reviews", () => {
    it("inserts and ignores duplicate review_id", () => {
      q.insertReview(db, { app_id: "app1", platform: "ios", review_id: "r1", rating: 5, body: "Great" });
      const result = q.insertReview(db, { app_id: "app1", platform: "ios", review_id: "r1", rating: 1, body: "Bad" });

      expect(result.changes).toBe(0); // INSERT OR IGNORE → no change
    });

    it("retrieves recent reviews", () => {
      q.insertReview(db, { app_id: "app1", platform: "ios", review_id: "r1", rating: 5, body: "Great" });
      q.insertReview(db, { app_id: "app1", platform: "android", review_id: "r2", rating: 3, body: "OK" });

      const rows = q.getRecentReviews(db, "app1", 1);
      expect(rows).toHaveLength(2);
    });

    it("updates sentiment and reply draft", () => {
      q.insertReview(db, { app_id: "app1", platform: "ios", review_id: "r1", rating: 5, body: "Great" });

      q.updateReviewSentiment(db, "r1", "positive");
      q.updateReplyDraft(db, "r1", "Thanks!");
      q.markReviewReplied(db, "r1");

      const rows = q.getRecentReviews(db, "app1", 1);
      expect(rows[0]!.sentiment).toBe("positive");
      expect(rows[0]!.reply_draft).toBe("Thanks!");
      expect(rows[0]!.replied_at).not.toBeNull();
    });

    it("returns sentiment summary", () => {
      q.insertReview(db, { app_id: "app1", platform: "ios", review_id: "r1", rating: 5, body: "Great" });
      q.insertReview(db, { app_id: "app1", platform: "ios", review_id: "r2", rating: 1, body: "Bad" });
      q.updateReviewSentiment(db, "r1", "positive");
      q.updateReviewSentiment(db, "r2", "negative");

      const summary = q.getSentimentSummary(db, "app1", 1);
      expect(summary).toHaveLength(2);
    });

    it("counts 1-star reviews", () => {
      q.insertReview(db, { app_id: "app1", platform: "ios", review_id: "r1", rating: 1, body: "Terrible" });
      q.insertReview(db, { app_id: "app1", platform: "ios", review_id: "r2", rating: 1, body: "Awful" });
      q.insertReview(db, { app_id: "app1", platform: "ios", review_id: "r3", rating: 5, body: "Great" });

      expect(q.getRecentOneStarCount(db, "app1", 1)).toBe(2);
    });
  });

  // ── Competitor Metadata ──────────────────────────────────

  describe("competitor metadata", () => {
    it("inserts with array keywords joined by comma", () => {
      q.insertCompetitorMetadata(db, {
        app_id: "app1", competitor_id: "comp1", platform: "ios",
        title: "Comp App", subtitle: "Sub", description: "Desc",
        keywords: ["kw1", "kw2", "kw3"],
      });

      const row = db.prepare("SELECT keywords FROM competitor_metadata WHERE competitor_id = ?").get("comp1") as { keywords: string };
      expect(row.keywords).toBe("kw1,kw2,kw3");
    });

    it("inserts with string keywords as-is", () => {
      q.insertCompetitorMetadata(db, {
        app_id: "app1", competitor_id: "comp2", platform: "android",
        title: "Comp", subtitle: null, description: null,
        keywords: "already,a,string",
      });

      const row = db.prepare("SELECT keywords FROM competitor_metadata WHERE competitor_id = ?").get("comp2") as { keywords: string };
      expect(row.keywords).toBe("already,a,string");
    });

    it("preserves null keywords as NULL in DB", () => {
      q.insertCompetitorMetadata(db, {
        app_id: "app1", competitor_id: "comp3", platform: "ios",
        title: "T", subtitle: null, description: null, keywords: null,
      });

      const row = db.prepare("SELECT keywords FROM competitor_metadata WHERE competitor_id = ?").get("comp3") as { keywords: string | null };
      expect(row.keywords).toBeNull();
    });
  });

  // ── Agent Metrics ────────────────────────────────────────

  describe("agent metrics", () => {
    it("upserts agent metric (insert then update on conflict)", () => {
      q.insertAgentMetric(db, {
        app_id: "app1", agent: "aso", run_date: "2026-04-12",
        duration_ms: 5000, status: "success",
      });
      q.insertAgentMetric(db, {
        app_id: "app1", agent: "aso", run_date: "2026-04-12",
        duration_ms: 6000, status: "partial", alerts_count: 2,
      });

      const rows = q.getAgentMetrics(db, "app1", "aso", 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.duration_ms).toBe(6000);
      expect(rows[0]!.status).toBe("partial");
      expect(rows[0]!.alerts_count).toBe(2);
    });

    it("serializes metadata as JSON", () => {
      q.insertAgentMetric(db, {
        app_id: "app1", agent: "review", run_date: "2026-04-12",
        duration_ms: 1000, status: "success",
        metadata: { processed: 5, skipped: 1 },
      });

      const rows = q.getAgentMetrics(db, "app1", "review", 1);
      expect(JSON.parse(rows[0]!.metadata!)).toEqual({ processed: 5, skipped: 1 });
    });

    it("returns agent trend", () => {
      q.insertAgentMetric(db, {
        app_id: "app1", agent: "aso", run_date: "2026-04-10",
        duration_ms: 5000, status: "success",
      });
      q.insertAgentMetric(db, {
        app_id: "app1", agent: "aso", run_date: "2026-04-11",
        duration_ms: 6000, status: "success",
      });

      const trend = q.getAgentTrend(db, "app1", 30);
      expect(trend.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Approvals ─────────────────────────────────────────────

  describe("approvals", () => {
    it("inserts and retrieves approvals", () => {
      q.insertApproval(db, {
        app_id: "app1", agent: "aso", action: "metadata_change",
        status: "pending", payload: { field: "title", newValue: "New Title" },
      });

      const rows = q.getRecentApprovals(db, "app1", 1);
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.payload!)).toEqual({ field: "title", newValue: "New Title" });
    });
  });

  // ── Blog Posts ────────────────────────────────────────────

  describe("blog posts", () => {
    it("inserts draft (no published_at) and retrieves", () => {
      q.insertBlogPost(db, {
        app_id: "fridgify", title: "10 Easy Recipes", slug: "10-easy-recipes", keywords: "recipes,easy",
      });

      const slugs = q.getBlogSlugs(db);
      expect(slugs).toEqual(["10-easy-recipes"]);

      const posts = q.getRecentBlogPosts(db, "fridgify", 1);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.title).toBe("10 Easy Recipes");
      expect(posts[0]!.published_at).toBeNull();
    });

    it("inserts with explicit published_at timestamp", () => {
      q.insertBlogPost(db, {
        app_id: "fridgify", title: "Published Post", slug: "published",
        keywords: "test", published_at: "2026-04-12 10:00:00",
      });

      const posts = q.getRecentBlogPosts(db, "fridgify", 1);
      expect(posts[0]!.published_at).toBe("2026-04-12 10:00:00");
    });
  });

  // ── Short-form Performance ────────────────────────────────

  describe("short-form performance", () => {
    it("upserts video performance", () => {
      q.upsertShortFormPerformance(db, {
        app_id: "app1", platform: "youtube", video_id: "v1",
        title: "Short 1", views: 100, likes: 10, comments: 5,
      });
      q.upsertShortFormPerformance(db, {
        app_id: "app1", platform: "youtube", video_id: "v1",
        title: "Short 1", views: 200,
      });

      const rows = q.getRecentShortFormPerformance(db, "app1", 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.views).toBe(200); // upserted
    });
  });

  // ── SEO Metrics ───────────────────────────────────────────

  describe("seo metrics", () => {
    it("upserts and retrieves by range", () => {
      q.upsertSeoMetric(db, { date: "2026-04-01", clicks: 100, impressions: 1000, ctr: 0.1, avg_position: 5.0 });
      q.upsertSeoMetric(db, { date: "2026-04-02", clicks: 120, impressions: 1100, ctr: 0.109, avg_position: 4.5 });

      const rows = q.getSeoMetricsByRange(db, "2026-04-01", "2026-04-02");
      expect(rows).toHaveLength(2);
    });

    it("calculates totals", () => {
      q.upsertSeoMetric(db, { date: "2026-04-01", clicks: 100, impressions: 1000, ctr: 0.1, avg_position: 5.0 });
      q.upsertSeoMetric(db, { date: "2026-04-02", clicks: 200, impressions: 2000, ctr: 0.1, avg_position: 4.0 });

      const totals = q.getSeoTotals(db, "2026-04-01", "2026-04-02");
      expect(totals.total_clicks).toBe(300);
      expect(totals.total_impressions).toBe(3000);
      expect(totals.avg_position).toBe(4.5);
    });

    it("upsert overwrites on date conflict", () => {
      q.upsertSeoMetric(db, { date: "2026-04-01", clicks: 100 });
      q.upsertSeoMetric(db, { date: "2026-04-01", clicks: 999 });

      const rows = q.getSeoMetricsByRange(db, "2026-04-01", "2026-04-01");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.clicks).toBe(999);
    });
  });

  // ── Web Traffic ───────────────────────────────────────────

  describe("web traffic", () => {
    it("upserts and retrieves by range", () => {
      q.upsertWebTraffic(db, { date: "2026-04-01", page_views: 500, users: 200, sessions: 300, bounce_rate: 0.45 });

      const rows = q.getWebTrafficByRange(db, "2026-04-01", "2026-04-01");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.page_views).toBe(500);
    });

    it("calculates totals", () => {
      q.upsertWebTraffic(db, { date: "2026-04-01", page_views: 500, users: 200, sessions: 300, bounce_rate: 0.4 });
      q.upsertWebTraffic(db, { date: "2026-04-02", page_views: 600, users: 250, sessions: 350, bounce_rate: 0.5 });

      const totals = q.getWebTrafficTotals(db, "2026-04-01", "2026-04-02");
      expect(totals.total_pv).toBe(1100);
      expect(totals.total_users).toBe(450);
      expect(totals.avg_bounce_rate).toBeCloseTo(0.45);
    });
  });

  // ── Blog Performance ──────────────────────────────────────

  describe("blog performance", () => {
    it("upserts per-slug daily metrics", () => {
      q.upsertBlogPerformance(db, {
        slug: "my-post", date: "2026-04-01", page_views: 50,
        seo_clicks: 20, seo_impressions: 200, seo_ctr: 0.1, seo_position: 3.0,
      });
      q.upsertBlogPerformance(db, {
        slug: "my-post", date: "2026-04-01", page_views: 75, // upsert
      });

      const rows = q.getBlogPerformanceBySlug(db, "my-post", "2026-04-01", "2026-04-01");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.page_views).toBe(75);
    });

    it("returns top performers by total page views", () => {
      q.upsertBlogPerformance(db, { slug: "post-a", date: "2026-04-01", page_views: 100 });
      q.upsertBlogPerformance(db, { slug: "post-b", date: "2026-04-01", page_views: 300 });
      q.upsertBlogPerformance(db, { slug: "post-c", date: "2026-04-01", page_views: 200 });

      const top = q.getTopBlogPerformance(db, "2026-04-01", "2026-04-01", 2);
      expect(top).toHaveLength(2);
      expect(top[0]!.slug).toBe("post-b");
      expect(top[1]!.slug).toBe("post-c");
    });
  });
});
