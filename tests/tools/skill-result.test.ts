import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSkillResultTool } from "../../src/tools/skill-result.js";
import { initDatabase } from "../../src/db/schema.js";
import { insertAgentMetric } from "../../src/db/queries.js";
import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adaria-sr-test-"));
  return path.join(dir, "test.db");
}

describe("skill-result tool", () => {
  let db: Database.Database;

  beforeEach(() => { db = initDatabase(tmpDbPath()); });
  afterEach(() => { try { db.close(); } catch { /* */ } });

  it("returns recent agent metrics for a skill", async () => {
    insertAgentMetric(db, {
      app_id: "fridgify", agent: "aso", run_date: new Date().toISOString().slice(0, 10),
      duration_ms: 5000, status: "success",
    });

    const tool = createSkillResultTool(db);
    const result = await tool.handler({ skill: "aso", app: "fridgify" }) as unknown[];

    expect(result).toHaveLength(1);
  });

  it("rejects unknown skill", async () => {
    const tool = createSkillResultTool(db);
    const result = await tool.handler({ skill: "evil-skill", app: "app1" }) as { error: string };

    expect(result.error).toContain("Unknown skill");
  });

  it("caps limit at 20", async () => {
    const tool = createSkillResultTool(db);
    const result = await tool.handler({ skill: "aso", app: "app1", limit: 100 });
    expect(result).toBeDefined();
  });
});
