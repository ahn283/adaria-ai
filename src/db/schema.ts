import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DB_PATH } from "../utils/paths.js";

export interface Migration {
  version: number;
  up: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS keyword_rankings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL,
        keyword TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('ios', 'android')),
        rank INTEGER,
        search_volume INTEGER,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_kr_app_keyword
        ON keyword_rankings(app_id, keyword, platform);

      CREATE INDEX IF NOT EXISTS idx_kr_recorded_at
        ON keyword_rankings(recorded_at);

      CREATE TABLE IF NOT EXISTS sdk_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL,
        event_name TEXT NOT NULL CHECK(event_name IN ('install', 'signup', 'subscription')),
        count INTEGER NOT NULL DEFAULT 0,
        date DATE NOT NULL,
        UNIQUE(app_id, event_name, date)
      );

      CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('ios', 'android')),
        review_id TEXT UNIQUE NOT NULL,
        rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        body TEXT,
        sentiment TEXT CHECK(sentiment IN ('positive', 'negative', 'neutral')),
        reply_draft TEXT,
        replied_at DATETIME,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_reviews_app_platform
        ON reviews(app_id, platform);

      CREATE INDEX IF NOT EXISTS idx_reviews_recorded_at
        ON reviews(recorded_at);

      CREATE TABLE IF NOT EXISTS approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL,
        agent TEXT NOT NULL CHECK(agent IN ('aso', 'onboarding', 'review', 'content', 'sdk-request', 'seo-blog', 'short-form')),
        action TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'modified')),
        payload TEXT,
        decided_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_approvals_app_agent
        ON approvals(app_id, agent);
    `,
  },
  {
    version: 2,
    up: `
      CREATE TABLE IF NOT EXISTS competitor_metadata (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL,
        competitor_id TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('ios', 'android')),
        title TEXT,
        subtitle TEXT,
        description TEXT,
        keywords TEXT,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_cm_app_comp
        ON competitor_metadata(app_id, competitor_id, platform);

      CREATE INDEX IF NOT EXISTS idx_cm_recorded_at
        ON competitor_metadata(recorded_at);
    `,
  },
  {
    version: 3,
    up: `
      CREATE TABLE IF NOT EXISTS agent_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        run_date DATE NOT NULL,
        duration_ms INTEGER,
        status TEXT NOT NULL CHECK(status IN ('success', 'partial', 'failure')),
        alerts_count INTEGER DEFAULT 0,
        actions_count INTEGER DEFAULT 0,
        approval_rate REAL,
        metadata TEXT,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(app_id, agent, run_date)
      );

      CREATE INDEX IF NOT EXISTS idx_am_app_agent
        ON agent_metrics(app_id, agent, run_date);
    `,
  },
  {
    version: 4,
    up: `
      CREATE TABLE IF NOT EXISTS blog_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL,
        title TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        keywords TEXT,
        seo_score INTEGER,
        published_at DATETIME,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_bp_app_id
        ON blog_posts(app_id);

      CREATE INDEX IF NOT EXISTS idx_bp_slug
        ON blog_posts(slug);

      CREATE TABLE IF NOT EXISTS short_form_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('youtube', 'tiktok')),
        video_id TEXT UNIQUE NOT NULL,
        title TEXT,
        views INTEGER DEFAULT 0,
        likes INTEGER DEFAULT 0,
        comments INTEGER DEFAULT 0,
        avg_watch_time REAL,
        published_at DATETIME,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_sfp_app_platform
        ON short_form_performance(app_id, platform);
    `,
  },
  {
    version: 5,
    up: `
      CREATE TABLE IF NOT EXISTS seo_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date DATE NOT NULL,
        clicks INTEGER DEFAULT 0,
        impressions INTEGER DEFAULT 0,
        ctr REAL DEFAULT 0,
        avg_position REAL DEFAULT 0,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(date)
      );

      CREATE TABLE IF NOT EXISTS web_traffic (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date DATE NOT NULL,
        page_views INTEGER DEFAULT 0,
        users INTEGER DEFAULT 0,
        sessions INTEGER DEFAULT 0,
        bounce_rate REAL DEFAULT 0,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(date)
      );

      CREATE TABLE IF NOT EXISTS blog_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL,
        date DATE NOT NULL,
        page_views INTEGER DEFAULT 0,
        avg_session_duration REAL DEFAULT 0,
        bounce_rate REAL DEFAULT 0,
        seo_clicks INTEGER DEFAULT 0,
        seo_impressions INTEGER DEFAULT 0,
        seo_ctr REAL DEFAULT 0,
        seo_position REAL DEFAULT 0,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(slug, date)
      );

      CREATE INDEX IF NOT EXISTS idx_bp_perf_slug
        ON blog_performance(slug);

      CREATE INDEX IF NOT EXISTS idx_bp_perf_date
        ON blog_performance(date);
    `,
  },
  {
    version: 6,
    up: `
      CREATE TABLE IF NOT EXISTS social_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('twitter', 'facebook', 'threads', 'tiktok', 'youtube', 'linkedin')),
        post_id TEXT,
        post_url TEXT,
        content TEXT NOT NULL,
        image_url TEXT,
        status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('posted', 'deleted', 'failed')),
        posted_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_sp_app_platform
        ON social_posts(app_id, platform);

      CREATE INDEX IF NOT EXISTS idx_sp_posted_at
        ON social_posts(posted_at);
    `,
  },
];

/**
 * Initialize SQLite database with WAL mode and run pending migrations.
 *
 * DB path defaults to `$ADARIA_HOME/data/adaria.db` (resolved via paths.ts).
 * Callers are responsible for calling `db.close()` on shutdown.
 */
export function initDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? DB_PATH;
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const db = new Database(resolvedPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);

  const row = db
    .prepare("SELECT MAX(version) as v FROM schema_version")
    .get() as { v: number | null } | undefined;
  const currentVersion = row?.v ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      db.transaction(() => {
        db.exec(migration.up);
        db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(
          migration.version,
        );
      })();
    }
  }

  return db;
}

/** Exported for testing — not part of the public API. */
export const _testMigrations = MIGRATIONS;
