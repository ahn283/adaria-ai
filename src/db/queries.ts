/**
 * DB query helpers — typed prepared statements with WeakMap caching.
 *
 * Ported from growth-agent `src/db/queries.js`. All functions take a
 * better-sqlite3 Database instance as the first argument so callers
 * control the connection lifecycle.
 *
 * Convention: insert/upsert params use snake_case field names matching
 * the DDL column names. Return types are typed where consumers exist.
 */

import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Statement cache
// ---------------------------------------------------------------------------

const stmtCache = new WeakMap<Database.Database, Map<string, Database.Statement>>();

function getStmt(db: Database.Database, sql: string): Database.Statement {
  let cache = stmtCache.get(db);
  if (!cache) {
    cache = new Map();
    stmtCache.set(db, cache);
  }
  if (!cache.has(sql)) {
    cache.set(sql, db.prepare(sql));
  }
  return cache.get(sql)!;
}

// ---------------------------------------------------------------------------
// Row types — lightweight shapes matching the DDL columns.
// ---------------------------------------------------------------------------

export interface KeywordRankingRow {
  id: number;
  app_id: string;
  keyword: string;
  platform: string;
  rank: number | null;
  search_volume: number | null;
  recorded_at: string;
}

export interface RankChangeRow {
  current_rank: number | null;
  previous_rank: number | null;
}

export interface SdkEventRow {
  id: number;
  app_id: string;
  event_name: string;
  count: number;
  date: string;
}

export interface FunnelRow {
  event_name: string;
  total: number;
}

export interface ReviewRow {
  id: number;
  app_id: string;
  platform: string;
  review_id: string;
  rating: number;
  body: string | null;
  sentiment: string | null;
  reply_draft: string | null;
  replied_at: string | null;
  recorded_at: string;
}

export interface SentimentRow {
  sentiment: string | null;
  count: number;
}

export interface CompetitorMetadataRow {
  id: number;
  app_id: string;
  competitor_id: string;
  platform: string;
  title: string | null;
  subtitle: string | null;
  description: string | null;
  keywords: string | null;
  recorded_at: string;
}

export interface AgentMetricRow {
  id: number;
  app_id: string;
  agent: string;
  run_date: string;
  duration_ms: number | null;
  status: string;
  alerts_count: number;
  actions_count: number;
  approval_rate: number | null;
  metadata: string | null;
  recorded_at: string;
}

export interface AgentTrendRow {
  agent: string;
  run_date: string;
  duration_ms: number | null;
  status: string;
  alerts_count: number;
  actions_count: number;
  approval_rate: number | null;
}

export interface ApprovalRow {
  id: number;
  app_id: string;
  agent: string;
  action: string;
  status: string;
  payload: string | null;
  decided_at: string;
}

export interface BlogPostRow {
  id: number;
  app_id: string;
  title: string;
  slug: string;
  keywords: string | null;
  seo_score: number | null;
  published_at: string | null;
  recorded_at: string;
}

export interface ShortFormRow {
  id: number;
  app_id: string;
  platform: string;
  video_id: string;
  title: string | null;
  views: number;
  likes: number;
  comments: number;
  avg_watch_time: number | null;
  published_at: string | null;
  recorded_at: string;
}

export interface SeoMetricRow {
  id: number;
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  avg_position: number;
  recorded_at: string;
}

export interface SeoTotalsRow {
  total_clicks: number | null;
  total_impressions: number | null;
  avg_ctr: number | null;
  avg_position: number | null;
}

export interface WebTrafficRow {
  id: number;
  date: string;
  page_views: number;
  users: number;
  sessions: number;
  bounce_rate: number;
  recorded_at: string;
}

export interface WebTrafficTotalsRow {
  total_pv: number | null;
  total_users: number | null;
  total_sessions: number | null;
  avg_bounce_rate: number | null;
}

export interface BlogPerformanceRow {
  id: number;
  slug: string;
  date: string;
  page_views: number;
  avg_session_duration: number;
  bounce_rate: number;
  seo_clicks: number;
  seo_impressions: number;
  seo_ctr: number;
  seo_position: number;
  recorded_at: string;
}

export interface TopBlogPerformanceRow {
  slug: string;
  total_pv: number;
  total_clicks: number;
  avg_duration: number;
  avg_bounce: number;
}

// ---------------------------------------------------------------------------
// Keyword Rankings
// ---------------------------------------------------------------------------

const SQL_INSERT_KEYWORD = `INSERT INTO keyword_rankings (app_id, keyword, platform, rank, search_volume)
       VALUES (?, ?, ?, ?, ?)`;

const SQL_RECENT_KEYWORDS = `SELECT * FROM keyword_rankings
       WHERE app_id = ? AND recorded_at >= datetime('now', ?)
       ORDER BY recorded_at DESC`;

const SQL_RANK_CHANGE = `SELECT
         (SELECT rank FROM keyword_rankings
          WHERE app_id = ? AND keyword = ? AND platform = ?
          ORDER BY recorded_at DESC LIMIT 1) as current_rank,
         (SELECT rank FROM keyword_rankings
          WHERE app_id = ? AND keyword = ? AND platform = ?
          AND recorded_at < datetime('now', '-7 days')
          ORDER BY recorded_at DESC LIMIT 1) as previous_rank`;

export function insertKeywordRanking(
  db: Database.Database,
  params: { app_id: string; keyword: string; platform: string; rank: number | null; search_volume: number | null },
): Database.RunResult {
  return getStmt(db, SQL_INSERT_KEYWORD).run(
    params.app_id, params.keyword, params.platform, params.rank, params.search_volume,
  );
}

export function getRecentKeywordRankings(
  db: Database.Database,
  appId: string,
  days = 7,
): KeywordRankingRow[] {
  return getStmt(db, SQL_RECENT_KEYWORDS).all(appId, `-${days} days`) as KeywordRankingRow[];
}

export function getKeywordRankChange(
  db: Database.Database,
  appId: string,
  keyword: string,
  platform: string,
): RankChangeRow {
  return getStmt(db, SQL_RANK_CHANGE).get(
    appId, keyword, platform, appId, keyword, platform,
  ) as RankChangeRow;
}

// ---------------------------------------------------------------------------
// SDK Events
// ---------------------------------------------------------------------------

const SQL_UPSERT_EVENT = `INSERT INTO sdk_events (app_id, event_name, count, date)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(app_id, event_name, date) DO UPDATE SET count = excluded.count`;

const SQL_EVENTS_BY_RANGE = `SELECT * FROM sdk_events
       WHERE app_id = ? AND date BETWEEN ? AND ?
       ORDER BY date ASC, event_name ASC`;

const SQL_FUNNEL = `SELECT event_name, SUM(count) as total
       FROM sdk_events
       WHERE app_id = ? AND date BETWEEN ? AND ?
       GROUP BY event_name`;

export function upsertSdkEvent(
  db: Database.Database,
  params: { app_id: string; event_name: string; count: number; date: string },
): Database.RunResult {
  return getStmt(db, SQL_UPSERT_EVENT).run(
    params.app_id, params.event_name, params.count, params.date,
  );
}

export function getSdkEventsByRange(
  db: Database.Database,
  appId: string,
  startDate: string,
  endDate: string,
): SdkEventRow[] {
  return getStmt(db, SQL_EVENTS_BY_RANGE).all(appId, startDate, endDate) as SdkEventRow[];
}

export function getFunnelConversion(
  db: Database.Database,
  appId: string,
  startDate: string,
  endDate: string,
): FunnelRow[] {
  return getStmt(db, SQL_FUNNEL).all(appId, startDate, endDate) as FunnelRow[];
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

const SQL_INSERT_REVIEW = `INSERT OR IGNORE INTO reviews (app_id, platform, review_id, rating, body)
       VALUES (?, ?, ?, ?, ?)`;

const SQL_RECENT_REVIEWS = `SELECT * FROM reviews
       WHERE app_id = ? AND recorded_at >= datetime('now', ?)
       ORDER BY recorded_at DESC`;

const SQL_UPDATE_SENTIMENT = "UPDATE reviews SET sentiment = ? WHERE review_id = ?";
const SQL_UPDATE_REPLY = "UPDATE reviews SET reply_draft = ? WHERE review_id = ?";
const SQL_MARK_REPLIED = "UPDATE reviews SET replied_at = datetime('now') WHERE review_id = ?";

const SQL_SENTIMENT_SUMMARY = `SELECT sentiment, COUNT(*) as count
       FROM reviews
       WHERE app_id = ? AND recorded_at >= datetime('now', ?)
       GROUP BY sentiment`;

const SQL_ONE_STAR_COUNT = `SELECT COUNT(*) as count FROM reviews
       WHERE app_id = ? AND rating = 1 AND recorded_at >= datetime('now', ?)`;

export function insertReview(
  db: Database.Database,
  params: { app_id: string; platform: string; review_id: string; rating: number; body: string | null },
): Database.RunResult {
  return getStmt(db, SQL_INSERT_REVIEW).run(
    params.app_id, params.platform, params.review_id, params.rating, params.body,
  );
}

export function getRecentReviews(
  db: Database.Database,
  appId: string,
  days = 7,
): ReviewRow[] {
  return getStmt(db, SQL_RECENT_REVIEWS).all(appId, `-${days} days`) as ReviewRow[];
}

export function updateReviewSentiment(
  db: Database.Database,
  reviewId: string,
  sentiment: string,
): Database.RunResult {
  return getStmt(db, SQL_UPDATE_SENTIMENT).run(sentiment, reviewId);
}

export function updateReplyDraft(
  db: Database.Database,
  reviewId: string,
  replyDraft: string,
): Database.RunResult {
  return getStmt(db, SQL_UPDATE_REPLY).run(replyDraft, reviewId);
}

export function markReviewReplied(
  db: Database.Database,
  reviewId: string,
): Database.RunResult {
  return getStmt(db, SQL_MARK_REPLIED).run(reviewId);
}

export function getSentimentSummary(
  db: Database.Database,
  appId: string,
  days = 7,
): SentimentRow[] {
  return getStmt(db, SQL_SENTIMENT_SUMMARY).all(appId, `-${days} days`) as SentimentRow[];
}

export function getRecentOneStarCount(
  db: Database.Database,
  appId: string,
  days = 1,
): number {
  const row = getStmt(db, SQL_ONE_STAR_COUNT).get(appId, `-${days} days`) as { count: number } | undefined;
  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Competitor Metadata
// ---------------------------------------------------------------------------

const SQL_INSERT_COMPETITOR = `INSERT INTO competitor_metadata (app_id, competitor_id, platform, title, subtitle, description, keywords)
       VALUES (?, ?, ?, ?, ?, ?, ?)`;

const SQL_PREV_COMPETITOR = `SELECT * FROM competitor_metadata
       WHERE app_id = ? AND competitor_id = ? AND platform = ?
       AND recorded_at < datetime('now', '-7 days')
       ORDER BY recorded_at DESC LIMIT 1`;

export function insertCompetitorMetadata(
  db: Database.Database,
  params: {
    app_id: string;
    competitor_id: string;
    platform: string;
    title: string | null;
    subtitle: string | null;
    description: string | null;
    keywords: string | string[] | null;
  },
): Database.RunResult {
  const kw = Array.isArray(params.keywords)
    ? params.keywords.join(",")
    : params.keywords;
  return getStmt(db, SQL_INSERT_COMPETITOR).run(
    params.app_id, params.competitor_id, params.platform,
    params.title, params.subtitle, params.description, kw,
  );
}

export function getPreviousCompetitorMetadata(
  db: Database.Database,
  appId: string,
  competitorId: string,
  platform: string,
): CompetitorMetadataRow | undefined {
  return getStmt(db, SQL_PREV_COMPETITOR).get(appId, competitorId, platform) as CompetitorMetadataRow | undefined;
}

// ---------------------------------------------------------------------------
// Agent Metrics
// ---------------------------------------------------------------------------

const SQL_INSERT_METRIC = `INSERT INTO agent_metrics (app_id, agent, run_date, duration_ms, status, alerts_count, actions_count, approval_rate, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id, agent, run_date) DO UPDATE SET
         duration_ms = excluded.duration_ms,
         status = excluded.status,
         alerts_count = excluded.alerts_count,
         actions_count = excluded.actions_count,
         approval_rate = excluded.approval_rate,
         metadata = excluded.metadata,
         recorded_at = CURRENT_TIMESTAMP`;

const SQL_RECENT_METRICS = `SELECT * FROM agent_metrics
       WHERE app_id = ? AND agent = ? AND run_date >= date('now', ?)
       ORDER BY run_date DESC`;

const SQL_AGENT_TREND = `SELECT agent, run_date, duration_ms, status, alerts_count, actions_count, approval_rate
       FROM agent_metrics
       WHERE app_id = ? AND run_date >= date('now', ?)
       ORDER BY agent, run_date ASC`;

export function insertAgentMetric(
  db: Database.Database,
  params: {
    app_id: string;
    agent: string;
    run_date: string;
    duration_ms: number | null;
    status: string;
    alerts_count?: number;
    actions_count?: number;
    approval_rate?: number | null;
    metadata?: Record<string, unknown> | null;
  },
): Database.RunResult {
  return getStmt(db, SQL_INSERT_METRIC).run(
    params.app_id, params.agent, params.run_date, params.duration_ms, params.status,
    params.alerts_count ?? 0, params.actions_count ?? 0, params.approval_rate ?? null,
    params.metadata ? JSON.stringify(params.metadata) : null,
  );
}

export function getAgentMetrics(
  db: Database.Database,
  appId: string,
  agent: string,
  days = 30,
): AgentMetricRow[] {
  return getStmt(db, SQL_RECENT_METRICS).all(appId, agent, `-${days} days`) as AgentMetricRow[];
}

export function getAgentTrend(
  db: Database.Database,
  appId: string,
  days = 30,
): AgentTrendRow[] {
  return getStmt(db, SQL_AGENT_TREND).all(appId, `-${days} days`) as AgentTrendRow[];
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

const SQL_INSERT_APPROVAL = `INSERT INTO approvals (app_id, agent, action, status, payload)
       VALUES (?, ?, ?, ?, ?)`;

const SQL_RECENT_APPROVALS = `SELECT * FROM approvals
       WHERE app_id = ? AND decided_at >= datetime('now', ?)
       ORDER BY decided_at DESC`;

export function insertApproval(
  db: Database.Database,
  params: {
    app_id: string;
    agent: string;
    action: string;
    status: string;
    payload: unknown;
  },
): Database.RunResult {
  return getStmt(db, SQL_INSERT_APPROVAL).run(
    params.app_id, params.agent, params.action, params.status, JSON.stringify(params.payload),
  );
}

export function getRecentApprovals(
  db: Database.Database,
  appId: string,
  days = 30,
): ApprovalRow[] {
  return getStmt(db, SQL_RECENT_APPROVALS).all(appId, `-${days} days`) as ApprovalRow[];
}

// ---------------------------------------------------------------------------
// Blog Posts
// ---------------------------------------------------------------------------

const SQL_INSERT_BLOG = `INSERT INTO blog_posts (app_id, title, slug, keywords, seo_score, published_at)
       VALUES (?, ?, ?, ?, ?, ?)`;

const SQL_GET_BLOG_SLUGS = "SELECT slug FROM blog_posts ORDER BY recorded_at DESC";

const SQL_RECENT_BLOGS = `SELECT * FROM blog_posts
       WHERE app_id = ? AND recorded_at >= datetime('now', ?)
       ORDER BY recorded_at DESC`;

export function insertBlogPost(
  db: Database.Database,
  params: {
    app_id: string;
    title: string;
    slug: string;
    keywords: string | null;
    seo_score?: number | null;
    published_at?: string | null;
  },
): Database.RunResult {
  return getStmt(db, SQL_INSERT_BLOG).run(
    params.app_id, params.title, params.slug, params.keywords,
    params.seo_score ?? null, params.published_at ?? null,
  );
}

export function getBlogSlugs(db: Database.Database): string[] {
  return (getStmt(db, SQL_GET_BLOG_SLUGS).all() as Array<{ slug: string }>).map((r) => r.slug);
}

export function getRecentBlogPosts(
  db: Database.Database,
  appId: string,
  days = 30,
): BlogPostRow[] {
  return getStmt(db, SQL_RECENT_BLOGS).all(appId, `-${days} days`) as BlogPostRow[];
}

// ---------------------------------------------------------------------------
// Short-form Performance
// ---------------------------------------------------------------------------

const SQL_UPSERT_SHORT_FORM = `INSERT INTO short_form_performance (app_id, platform, video_id, title, views, likes, comments, avg_watch_time, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(video_id) DO UPDATE SET
         views = excluded.views,
         likes = excluded.likes,
         comments = excluded.comments,
         avg_watch_time = excluded.avg_watch_time,
         recorded_at = CURRENT_TIMESTAMP`;

const SQL_RECENT_SHORT_FORM = `SELECT * FROM short_form_performance
       WHERE app_id = ? AND recorded_at >= datetime('now', ?)
       ORDER BY views DESC`;

export function upsertShortFormPerformance(
  db: Database.Database,
  params: {
    app_id: string;
    platform: string;
    video_id: string;
    title: string | null;
    views?: number;
    likes?: number;
    comments?: number;
    avg_watch_time?: number | null;
    published_at?: string | null;
  },
): Database.RunResult {
  return getStmt(db, SQL_UPSERT_SHORT_FORM).run(
    params.app_id, params.platform, params.video_id, params.title,
    params.views ?? 0, params.likes ?? 0, params.comments ?? 0,
    params.avg_watch_time ?? null, params.published_at ?? null,
  );
}

export function getRecentShortFormPerformance(
  db: Database.Database,
  appId: string,
  days = 30,
): ShortFormRow[] {
  return getStmt(db, SQL_RECENT_SHORT_FORM).all(appId, `-${days} days`) as ShortFormRow[];
}

// ---------------------------------------------------------------------------
// SEO Metrics
// ---------------------------------------------------------------------------

const SQL_UPSERT_SEO = `INSERT INTO seo_metrics (date, clicks, impressions, ctr, avg_position)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         clicks = excluded.clicks,
         impressions = excluded.impressions,
         ctr = excluded.ctr,
         avg_position = excluded.avg_position,
         recorded_at = CURRENT_TIMESTAMP`;

const SQL_SEO_BY_RANGE = `SELECT * FROM seo_metrics
       WHERE date BETWEEN ? AND ?
       ORDER BY date ASC`;

const SQL_SEO_TOTALS = `SELECT
       SUM(clicks) as total_clicks,
       SUM(impressions) as total_impressions,
       AVG(ctr) as avg_ctr,
       AVG(avg_position) as avg_position
       FROM seo_metrics WHERE date BETWEEN ? AND ?`;

export function upsertSeoMetric(
  db: Database.Database,
  params: { date: string; clicks?: number; impressions?: number; ctr?: number; avg_position?: number },
): Database.RunResult {
  return getStmt(db, SQL_UPSERT_SEO).run(
    params.date, params.clicks ?? 0, params.impressions ?? 0, params.ctr ?? 0, params.avg_position ?? 0,
  );
}

export function getSeoMetricsByRange(
  db: Database.Database,
  startDate: string,
  endDate: string,
): SeoMetricRow[] {
  return getStmt(db, SQL_SEO_BY_RANGE).all(startDate, endDate) as SeoMetricRow[];
}

export function getSeoTotals(
  db: Database.Database,
  startDate: string,
  endDate: string,
): SeoTotalsRow {
  return getStmt(db, SQL_SEO_TOTALS).get(startDate, endDate) as SeoTotalsRow;
}

// ---------------------------------------------------------------------------
// Web Traffic
// ---------------------------------------------------------------------------

const SQL_UPSERT_TRAFFIC = `INSERT INTO web_traffic (date, page_views, users, sessions, bounce_rate)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         page_views = excluded.page_views,
         users = excluded.users,
         sessions = excluded.sessions,
         bounce_rate = excluded.bounce_rate,
         recorded_at = CURRENT_TIMESTAMP`;

const SQL_TRAFFIC_BY_RANGE = `SELECT * FROM web_traffic
       WHERE date BETWEEN ? AND ?
       ORDER BY date ASC`;

const SQL_TRAFFIC_TOTALS = `SELECT
       SUM(page_views) as total_pv,
       SUM(users) as total_users,
       SUM(sessions) as total_sessions,
       AVG(bounce_rate) as avg_bounce_rate
       FROM web_traffic WHERE date BETWEEN ? AND ?`;

export function upsertWebTraffic(
  db: Database.Database,
  params: { date: string; page_views?: number; users?: number; sessions?: number; bounce_rate?: number },
): Database.RunResult {
  return getStmt(db, SQL_UPSERT_TRAFFIC).run(
    params.date, params.page_views ?? 0, params.users ?? 0, params.sessions ?? 0, params.bounce_rate ?? 0,
  );
}

export function getWebTrafficByRange(
  db: Database.Database,
  startDate: string,
  endDate: string,
): WebTrafficRow[] {
  return getStmt(db, SQL_TRAFFIC_BY_RANGE).all(startDate, endDate) as WebTrafficRow[];
}

export function getWebTrafficTotals(
  db: Database.Database,
  startDate: string,
  endDate: string,
): WebTrafficTotalsRow {
  return getStmt(db, SQL_TRAFFIC_TOTALS).get(startDate, endDate) as WebTrafficTotalsRow;
}

// ---------------------------------------------------------------------------
// Blog Performance
// ---------------------------------------------------------------------------

const SQL_UPSERT_BLOG_PERF = `INSERT INTO blog_performance
       (slug, date, page_views, avg_session_duration, bounce_rate, seo_clicks, seo_impressions, seo_ctr, seo_position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug, date) DO UPDATE SET
         page_views = excluded.page_views,
         avg_session_duration = excluded.avg_session_duration,
         bounce_rate = excluded.bounce_rate,
         seo_clicks = excluded.seo_clicks,
         seo_impressions = excluded.seo_impressions,
         seo_ctr = excluded.seo_ctr,
         seo_position = excluded.seo_position,
         recorded_at = CURRENT_TIMESTAMP`;

const SQL_BLOG_PERF_BY_SLUG = `SELECT * FROM blog_performance
       WHERE slug = ? AND date BETWEEN ? AND ?
       ORDER BY date ASC`;

const SQL_BLOG_PERF_TOP = `SELECT slug,
       SUM(page_views) as total_pv,
       SUM(seo_clicks) as total_clicks,
       AVG(avg_session_duration) as avg_duration,
       AVG(bounce_rate) as avg_bounce
       FROM blog_performance
       WHERE date BETWEEN ? AND ?
       GROUP BY slug
       ORDER BY total_pv DESC
       LIMIT ?`;

export function upsertBlogPerformance(
  db: Database.Database,
  params: {
    slug: string;
    date: string;
    page_views?: number;
    avg_session_duration?: number;
    bounce_rate?: number;
    seo_clicks?: number;
    seo_impressions?: number;
    seo_ctr?: number;
    seo_position?: number;
  },
): Database.RunResult {
  return getStmt(db, SQL_UPSERT_BLOG_PERF).run(
    params.slug, params.date, params.page_views ?? 0,
    params.avg_session_duration ?? 0, params.bounce_rate ?? 0,
    params.seo_clicks ?? 0, params.seo_impressions ?? 0,
    params.seo_ctr ?? 0, params.seo_position ?? 0,
  );
}

export function getBlogPerformanceBySlug(
  db: Database.Database,
  slug: string,
  startDate: string,
  endDate: string,
): BlogPerformanceRow[] {
  return getStmt(db, SQL_BLOG_PERF_BY_SLUG).all(slug, startDate, endDate) as BlogPerformanceRow[];
}

export function getTopBlogPerformance(
  db: Database.Database,
  startDate: string,
  endDate: string,
  limit = 5,
): TopBlogPerformanceRow[] {
  return getStmt(db, SQL_BLOG_PERF_TOP).all(startDate, endDate, limit) as TopBlogPerformanceRow[];
}

// ---------------------------------------------------------------------------
// Social Posts
// ---------------------------------------------------------------------------

export interface SocialPostRow {
  id: number;
  app_id: string;
  platform: string;
  post_id: string | null;
  post_url: string | null;
  content: string;
  image_url: string | null;
  status: string;
  posted_at: string;
}

const SQL_INSERT_SOCIAL_POST = `INSERT INTO social_posts (app_id, platform, post_id, post_url, content, image_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`;

const SQL_SOCIAL_POSTS_BY_APP = `SELECT * FROM social_posts
       WHERE app_id = ? AND posted_at >= datetime('now', ?)
       ORDER BY posted_at DESC`;

const SQL_SOCIAL_POSTS_BY_PLATFORM = `SELECT * FROM social_posts
       WHERE app_id = ? AND platform = ? AND posted_at >= datetime('now', ?)
       ORDER BY posted_at DESC`;

const SQL_UPDATE_SOCIAL_POST_STATUS = "UPDATE social_posts SET status = ? WHERE id = ?";

export function insertSocialPost(
  db: Database.Database,
  params: {
    app_id: string;
    platform: string;
    post_id: string | null;
    post_url: string | null;
    content: string;
    image_url: string | null;
    status?: string;
  },
): Database.RunResult {
  return getStmt(db, SQL_INSERT_SOCIAL_POST).run(
    params.app_id, params.platform, params.post_id, params.post_url,
    params.content, params.image_url, params.status ?? "posted",
  );
}

export function getSocialPostsByApp(
  db: Database.Database,
  appId: string,
  days = 30,
): SocialPostRow[] {
  return getStmt(db, SQL_SOCIAL_POSTS_BY_APP).all(appId, `-${String(days)} days`) as SocialPostRow[];
}

export function getSocialPostsByPlatform(
  db: Database.Database,
  appId: string,
  platform: string,
  days = 30,
): SocialPostRow[] {
  return getStmt(db, SQL_SOCIAL_POSTS_BY_PLATFORM).all(appId, platform, `-${String(days)} days`) as SocialPostRow[];
}

export function updateSocialPostStatus(
  db: Database.Database,
  id: number,
  status: "posted" | "deleted" | "failed",
): Database.RunResult {
  return getStmt(db, SQL_UPDATE_SOCIAL_POST_STATUS).run(status, id);
}

// ---------------------------------------------------------------------------
// Brand flows (M6.7 — multi-turn BrandSkill state persistence)
// ---------------------------------------------------------------------------

export interface BrandFlowRow {
  flow_id: string;
  user_id: string;
  thread_key: string;
  service_id: string | null;
  state: string;
  data_json: string;
  created_at: number;
  updated_at: number;
}

const SQL_UPSERT_BRAND_FLOW = `
  INSERT INTO brand_flows (
    flow_id, user_id, thread_key, service_id, state, data_json,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, thread_key) DO UPDATE SET
    flow_id = excluded.flow_id,
    service_id = excluded.service_id,
    state = excluded.state,
    data_json = excluded.data_json,
    updated_at = excluded.updated_at
`;

const SQL_GET_ACTIVE_BRAND_FLOW = `
  SELECT * FROM brand_flows
  WHERE user_id = ? AND thread_key = ? AND updated_at >= ?
`;

const SQL_DELETE_BRAND_FLOW = "DELETE FROM brand_flows WHERE flow_id = ?";

const SQL_DELETE_STALE_BRAND_FLOWS =
  "DELETE FROM brand_flows WHERE updated_at < ?";

export function upsertBrandFlow(
  db: Database.Database,
  params: {
    flow_id: string;
    user_id: string;
    thread_key: string;
    service_id: string | null;
    state: string;
    data_json: string;
    created_at: number;
    updated_at: number;
  },
): Database.RunResult {
  return getStmt(db, SQL_UPSERT_BRAND_FLOW).run(
    params.flow_id,
    params.user_id,
    params.thread_key,
    params.service_id,
    params.state,
    params.data_json,
    params.created_at,
    params.updated_at,
  );
}

/**
 * Look up an active brand flow for a (user, thread) pair. Returns null
 * when no row exists or the row has been idle past `idleCutoffMs`
 * (milliseconds since epoch — flows older than this are considered
 * abandoned and should be cleaned up by `deleteStaleBrandFlows`).
 */
export function getActiveBrandFlow(
  db: Database.Database,
  userId: string,
  threadKey: string,
  idleCutoffMs: number,
): BrandFlowRow | null {
  const row = getStmt(db, SQL_GET_ACTIVE_BRAND_FLOW).get(
    userId,
    threadKey,
    idleCutoffMs,
  ) as BrandFlowRow | undefined;
  return row ?? null;
}

export function deleteBrandFlow(
  db: Database.Database,
  flowId: string,
): Database.RunResult {
  return getStmt(db, SQL_DELETE_BRAND_FLOW).run(flowId);
}

export function deleteStaleBrandFlows(
  db: Database.Database,
  cutoffMs: number,
): Database.RunResult {
  return getStmt(db, SQL_DELETE_STALE_BRAND_FLOWS).run(cutoffMs);
}
