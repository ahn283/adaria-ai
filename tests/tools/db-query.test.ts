import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDbQueryTool, _test } from "../../src/tools/db-query.js";
import { initDatabase } from "../../src/db/schema.js";
import { insertReview, insertKeywordRanking } from "../../src/db/queries.js";
import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adaria-dbq-test-"));
  return path.join(dir, "test.db");
}

describe("db-query tool", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase(tmpDbPath());
  });
  afterEach(() => { try { db.close(); } catch { /* */ } });

  it("queries whitelisted table and returns rows", async () => {
    insertKeywordRanking(db, { app_id: "fridgify", keyword: "recipe", platform: "ios", rank: 5, search_volume: 1000 });

    const tool = createDbQueryTool(db);
    const result = await tool.handler({ table: "keyword_rankings", where: { app_id: "fridgify" } }) as { rowCount: number };

    expect(result.rowCount).toBe(1);
  });

  it("rejects non-whitelisted table", async () => {
    const tool = createDbQueryTool(db);
    const result = await tool.handler({ table: "schema_version" }) as { error: string };

    expect(result.error).toContain("not in the whitelist");
  });

  it("rejects SQL injection in column names", () => {
    expect(() => {
      _test.buildQuery({ table: "reviews", where: { "1=1; DROP TABLE reviews--": "x" } });
    }).toThrow("Invalid column name");
  });

  it("redacts review body and reply_draft columns", async () => {
    insertReview(db, { app_id: "app1", platform: "ios", review_id: "r1", rating: 5, body: "Secret review text" });

    const tool = createDbQueryTool(db);
    const result = await tool.handler({ table: "reviews" }) as { rows: Array<Record<string, unknown>> };

    expect(result.rows[0]!["body"]).toBe("[redacted]");
    expect(result.rows[0]!["reply_draft"]).toBe("[redacted]");
    expect(result.rows[0]!["rating"]).toBe(5);
  });

  it("respects limit cap at 50", async () => {
    for (let i = 0; i < 60; i++) {
      insertKeywordRanking(db, { app_id: "app1", keyword: `kw${String(i)}`, platform: "ios", rank: i, search_volume: 100 });
    }

    const tool = createDbQueryTool(db);
    const result = await tool.handler({ table: "keyword_rankings", limit: 100 }) as { rowCount: number };

    expect(result.rowCount).toBe(50); // capped
  });

  it("supports orderBy with DESC", async () => {
    insertKeywordRanking(db, { app_id: "app1", keyword: "a", platform: "ios", rank: 10, search_volume: 100 });
    insertKeywordRanking(db, { app_id: "app1", keyword: "b", platform: "ios", rank: 1, search_volume: 200 });

    const tool = createDbQueryTool(db);
    const result = await tool.handler({ table: "keyword_rankings", orderBy: "rank ASC", limit: 2 }) as { rows: Array<Record<string, unknown>> };

    expect(result.rows[0]!["rank"]).toBe(1);
  });

  it("rejects invalid orderBy", () => {
    expect(() => {
      _test.buildQuery({ table: "reviews", orderBy: "1; DROP TABLE reviews" });
    }).toThrow("Invalid orderBy");
  });

  it("returns error for missing table field", async () => {
    const tool = createDbQueryTool(db);
    const result = await tool.handler({}) as { error: string };

    expect(result.error).toContain("table");
  });

  it("handles empty result set", async () => {
    const tool = createDbQueryTool(db);
    const result = await tool.handler({ table: "keyword_rankings", where: { app_id: "nonexistent" } }) as { rowCount: number };

    expect(result.rowCount).toBe(0);
  });
});
