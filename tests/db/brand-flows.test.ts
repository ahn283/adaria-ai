import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as q from "../../src/db/queries.js";
import { initDatabase } from "../../src/db/schema.js";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adaria-bf-test-"));
  return path.join(dir, "test.db");
}

describe("brand_flows queries", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase(tmpDbPath());
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  const base = (overrides: Partial<Parameters<typeof q.upsertBrandFlow>[1]> = {}) => ({
    flow_id: "flow-1",
    user_id: "U123",
    thread_key: "C1:123.456",
    service_id: null as string | null,
    state: "ASK_TYPE",
    data_json: JSON.stringify({}),
    created_at: 1_000_000,
    updated_at: 1_000_000,
    ...overrides,
  });

  it("inserts a new flow row", () => {
    q.upsertBrandFlow(db, base());
    const row = q.getActiveBrandFlow(db, "U123", "C1:123.456", 0);
    expect(row).not.toBeNull();
    expect(row?.state).toBe("ASK_TYPE");
    expect(row?.flow_id).toBe("flow-1");
  });

  it("upserts on (user_id, thread_key) conflict — advances state in place", () => {
    q.upsertBrandFlow(db, base({ state: "ASK_TYPE" }));
    q.upsertBrandFlow(
      db,
      base({
        flow_id: "flow-1",
        state: "ASK_IDENTIFIER",
        updated_at: 2_000_000,
        data_json: JSON.stringify({ serviceType: "app" }),
      })
    );
    const row = q.getActiveBrandFlow(db, "U123", "C1:123.456", 0);
    expect(row?.state).toBe("ASK_IDENTIFIER");
    expect(row?.updated_at).toBe(2_000_000);
    const count = db
      .prepare("SELECT COUNT(*) as n FROM brand_flows")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("enforces unique (user_id, thread_key) across flow_ids", () => {
    q.upsertBrandFlow(db, base({ flow_id: "flow-1" }));
    // Upsert with a different flow_id but same user+thread should
    // replace the flow_id atomically (tracked as one logical flow).
    q.upsertBrandFlow(db, base({ flow_id: "flow-2", updated_at: 2_000_000 }));
    const rows = db
      .prepare("SELECT flow_id FROM brand_flows")
      .all() as { flow_id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.flow_id).toBe("flow-2");
  });

  it("getActiveBrandFlow respects idleCutoffMs", () => {
    q.upsertBrandFlow(db, base({ updated_at: 1_000 }));
    expect(q.getActiveBrandFlow(db, "U123", "C1:123.456", 500)).not.toBeNull();
    expect(q.getActiveBrandFlow(db, "U123", "C1:123.456", 2_000)).toBeNull();
  });

  it("deleteBrandFlow removes the row", () => {
    q.upsertBrandFlow(db, base());
    q.deleteBrandFlow(db, "flow-1");
    expect(q.getActiveBrandFlow(db, "U123", "C1:123.456", 0)).toBeNull();
  });

  it("deleteStaleBrandFlows removes only rows older than cutoff", () => {
    q.upsertBrandFlow(db, base({ flow_id: "old", thread_key: "t1", updated_at: 100 }));
    q.upsertBrandFlow(db, base({ flow_id: "new", thread_key: "t2", updated_at: 9_999 }));
    q.deleteStaleBrandFlows(db, 1_000);
    const rows = db
      .prepare("SELECT flow_id FROM brand_flows")
      .all() as { flow_id: string }[];
    expect(rows.map((r) => r.flow_id)).toEqual(["new"]);
  });

  it("stores service_id nullable and returns it", () => {
    q.upsertBrandFlow(db, base({ service_id: "fridgify" }));
    const row = q.getActiveBrandFlow(db, "U123", "C1:123.456", 0);
    expect(row?.service_id).toBe("fridgify");
  });

  it("allows different users to have separate flows in the same channel/thread", () => {
    q.upsertBrandFlow(db, base({ flow_id: "a", user_id: "U1" }));
    q.upsertBrandFlow(db, base({ flow_id: "b", user_id: "U2" }));
    expect(q.getActiveBrandFlow(db, "U1", "C1:123.456", 0)?.flow_id).toBe("a");
    expect(q.getActiveBrandFlow(db, "U2", "C1:123.456", 0)?.flow_id).toBe("b");
  });
});
