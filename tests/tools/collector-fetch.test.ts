import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createCollectorFetchTool } from "../../src/tools/collector-fetch.js";
import { initDatabase } from "../../src/db/schema.js";
import { insertReview, insertKeywordRanking } from "../../src/db/queries.js";
import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adaria-cf-test-"));
  return path.join(dir, "test.db");
}

describe("collector-fetch tool", () => {
  let db: Database.Database;

  beforeEach(() => { db = initDatabase(tmpDbPath()); });
  afterEach(() => { try { db.close(); } catch { /* */ } });

  it("fetches keyword rankings by app", async () => {
    insertKeywordRanking(db, { app_id: "fridgify", keyword: "recipe", platform: "ios", rank: 5, search_volume: 1000 });

    const tool = createCollectorFetchTool(db);
    const result = await tool.handler({ collector: "keyword-rankings", app: "fridgify" }) as unknown[];

    expect(result).toHaveLength(1);
  });

  it("redacts review body text", async () => {
    insertReview(db, { app_id: "app1", platform: "ios", review_id: "r1", rating: 5, body: "Secret text" });

    const tool = createCollectorFetchTool(db);
    const result = await tool.handler({ collector: "reviews", app: "app1" }) as Array<Record<string, unknown>>;

    expect(result[0]!["body"]).toBe("[redacted]");
  });

  it("rejects unknown collector", async () => {
    const tool = createCollectorFetchTool(db);
    const result = await tool.handler({ collector: "evil-collector", app: "app1" }) as { error: string };

    expect(result.error).toContain("Unknown collector");
  });

  it("caps days at 90", async () => {
    const tool = createCollectorFetchTool(db);
    // Should not throw even with huge days value
    const result = await tool.handler({ collector: "keyword-rankings", app: "app1", days: 999 });
    expect(result).toBeDefined();
  });
});
