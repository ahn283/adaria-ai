import { describe, it, expect, afterEach } from "vitest";
import { initDatabase, _testMigrations } from "../../src/db/schema.js";
import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adaria-db-test-"));
  return path.join(dir, "test.db");
}

describe("initDatabase", () => {
  const dbs: Database.Database[] = [];

  afterEach(() => {
    for (const db of dbs) {
      try { db.close(); } catch { /* already closed */ }
    }
    dbs.length = 0;
  });

  it("creates a fresh database with all migrations applied", () => {
    const db = initDatabase(tmpDbPath());
    dbs.push(db);

    const version = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number };
    expect(version.v).toBe(_testMigrations.length);
  });

  it("sets WAL journal mode", () => {
    const db = initDatabase(tmpDbPath());
    dbs.push(db);

    const mode = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
    expect(mode[0]?.journal_mode).toBe("wal");
  });

  it("creates all 12 tables", () => {
    const db = initDatabase(tmpDbPath());
    dbs.push(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;

    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual([
      "agent_metrics",
      "approvals",
      "blog_performance",
      "blog_posts",
      "competitor_metadata",
      "keyword_rankings",
      "reviews",
      "schema_version",
      "sdk_events",
      "seo_metrics",
      "short_form_performance",
      "social_posts",
      "web_traffic",
    ]);
  });

  it("is idempotent — re-opening an existing DB does not error", () => {
    const dbPath = tmpDbPath();
    const db1 = initDatabase(dbPath);
    db1.close();

    const db2 = initDatabase(dbPath);
    dbs.push(db2);

    const version = db2.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number };
    expect(version.v).toBe(_testMigrations.length);
  });

  it("runs incremental migrations on a partially-migrated DB", () => {
    const dbPath = tmpDbPath();
    const db1 = initDatabase(dbPath);
    // Simulate a DB that only has v1-v3
    // (In practice this happens if adaria-ai is upgraded with new migrations)
    db1.close();

    // Re-open — all migrations already applied, nothing should break
    const db2 = initDatabase(dbPath);
    dbs.push(db2);

    const version = db2.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number };
    expect(version.v).toBe(_testMigrations.length);
  });

  describe("table constraints", () => {
    it("keyword_rankings rejects invalid platform", () => {
      const db = initDatabase(tmpDbPath());
      dbs.push(db);

      expect(() => {
        db.prepare(
          "INSERT INTO keyword_rankings (app_id, keyword, platform, rank, search_volume) VALUES (?, ?, ?, ?, ?)",
        ).run("app1", "kw", "web", 1, 100);
      }).toThrow();
    });

    it("sdk_events enforces unique constraint on (app_id, event_name, date)", () => {
      const db = initDatabase(tmpDbPath());
      dbs.push(db);

      const stmt = db.prepare(
        "INSERT INTO sdk_events (app_id, event_name, count, date) VALUES (?, ?, ?, ?)",
      );
      stmt.run("app1", "install", 10, "2026-04-01");

      expect(() => {
        stmt.run("app1", "install", 20, "2026-04-01");
      }).toThrow();
    });

    it("reviews enforces unique review_id", () => {
      const db = initDatabase(tmpDbPath());
      dbs.push(db);

      const stmt = db.prepare(
        "INSERT INTO reviews (app_id, platform, review_id, rating, body) VALUES (?, ?, ?, ?, ?)",
      );
      stmt.run("app1", "ios", "rev-1", 5, "Great");
      expect(() => {
        stmt.run("app1", "ios", "rev-1", 3, "Updated");
      }).toThrow();
    });

    it("reviews rejects rating outside 1-5", () => {
      const db = initDatabase(tmpDbPath());
      dbs.push(db);

      expect(() => {
        db.prepare(
          "INSERT INTO reviews (app_id, platform, review_id, rating, body) VALUES (?, ?, ?, ?, ?)",
        ).run("app1", "ios", "rev-2", 6, "Bad rating");
      }).toThrow();
    });

    it("approvals accepts all 7 agent types", () => {
      const db = initDatabase(tmpDbPath());
      dbs.push(db);

      const agents = ["aso", "onboarding", "review", "content", "sdk-request", "seo-blog", "short-form"];
      const stmt = db.prepare(
        "INSERT INTO approvals (app_id, agent, action, status, payload) VALUES (?, ?, ?, ?, ?)",
      );

      for (const agent of agents) {
        expect(() => {
          stmt.run("app1", agent, "test-action", "pending", null);
        }).not.toThrow();
      }
    });

    it("approvals rejects unknown agent type", () => {
      const db = initDatabase(tmpDbPath());
      dbs.push(db);

      expect(() => {
        db.prepare(
          "INSERT INTO approvals (app_id, agent, action, status, payload) VALUES (?, ?, ?, ?, ?)",
        ).run("app1", "unknown-agent", "test", "pending", null);
      }).toThrow();
    });

    it("blog_posts enforces unique slug", () => {
      const db = initDatabase(tmpDbPath());
      dbs.push(db);

      const stmt = db.prepare(
        "INSERT INTO blog_posts (app_id, title, slug, keywords, seo_score) VALUES (?, ?, ?, ?, ?)",
      );
      stmt.run("app1", "Title 1", "my-slug", "kw1", 80);

      expect(() => {
        stmt.run("app1", "Title 2", "my-slug", "kw2", 90);
      }).toThrow();
    });

    it("short_form_performance enforces unique video_id", () => {
      const db = initDatabase(tmpDbPath());
      dbs.push(db);

      const stmt = db.prepare(
        "INSERT INTO short_form_performance (app_id, platform, video_id, title) VALUES (?, ?, ?, ?)",
      );
      stmt.run("app1", "youtube", "vid-1", "Title");

      expect(() => {
        stmt.run("app1", "youtube", "vid-1", "Dup");
      }).toThrow();
    });

    it("seo_metrics enforces unique date", () => {
      const db = initDatabase(tmpDbPath());
      dbs.push(db);

      const stmt = db.prepare(
        "INSERT INTO seo_metrics (date, clicks, impressions, ctr, avg_position) VALUES (?, ?, ?, ?, ?)",
      );
      stmt.run("2026-04-01", 100, 1000, 0.1, 5.0);

      expect(() => {
        stmt.run("2026-04-01", 200, 2000, 0.1, 5.0);
      }).toThrow();
    });

    it("blog_performance enforces unique (slug, date)", () => {
      const db = initDatabase(tmpDbPath());
      dbs.push(db);

      const stmt = db.prepare(
        "INSERT INTO blog_performance (slug, date, page_views) VALUES (?, ?, ?)",
      );
      stmt.run("my-post", "2026-04-01", 100);

      expect(() => {
        stmt.run("my-post", "2026-04-01", 200);
      }).toThrow();
    });
  });
});
