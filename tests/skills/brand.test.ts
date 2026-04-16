/* eslint-disable @typescript-eslint/require-await */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrandSkill } from "../../src/skills/brand.js";
import { initDatabase } from "../../src/db/schema.js";
import type { SkillContext } from "../../src/types/skill.js";

let tempHome: string;
const originalHome = process.env["ADARIA_HOME"];

function mockConfig(): SkillContext["config"] {
  // Only the fields the skill reads need to be present; cast through
  // unknown to satisfy the rest of the AdariaConfig shape.
  return {} as unknown as SkillContext["config"];
}

function mkCtx(
  db: Database.Database,
  overrides: Partial<SkillContext> = {},
): SkillContext {
  return {
    db,
    apps: [],
    config: mockConfig(),
    runClaude: async () => "",
    flowContext: { userId: "U1", threadKey: "C1:123.456" },
    ...overrides,
  };
}

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "adaria-brand-skill-"));
  process.env["ADARIA_HOME"] = tempHome;
});

afterEach(async () => {
  await fs.rm(tempHome, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env["ADARIA_HOME"];
  else process.env["ADARIA_HOME"] = originalHome;
});

function tmpDbPath(): string {
  return path.join(tempHome, "brand-skill.db");
}

describe("BrandSkill.dispatch", () => {
  it("starts a new flow and persists ASK_TYPE", async () => {
    const db = initDatabase(tmpDbPath());
    const skill = new BrandSkill();
    const ctx = mkCtx(db);

    const result = await skill.dispatch(ctx, "brand");

    expect(result.continuation?.state).toBe("ASK_TYPE");
    expect(result.summary).toContain("app");
    const row = db
      .prepare("SELECT state FROM brand_flows WHERE flow_id = ?")
      .get(result.continuation!.flowId) as { state: string };
    expect(row.state).toBe("ASK_TYPE");
    db.close();
  });

  it("returns a friendly error when flowContext is missing", async () => {
    const db = initDatabase(tmpDbPath());
    const skill = new BrandSkill();
    const ctx = mkCtx(db, { flowContext: undefined });

    const result = await skill.dispatch(ctx, "brand");
    expect(result.continuation).toBeUndefined();
    expect(result.summary).toContain("쓰레드");
    db.close();
  });
});

describe("BrandSkill.continueFlow", () => {
  it("advances ASK_TYPE → ASK_IDENTIFIER on 'app' reply", async () => {
    const db = initDatabase(tmpDbPath());
    const skill = new BrandSkill();
    const ctx = mkCtx(db);

    const start = await skill.dispatch(ctx, "brand");
    const flowId = start.continuation!.flowId;

    const next = await skill.continueFlow(ctx, flowId, {
      text: "app",
      files: [],
    });
    expect(next.continuation?.state).toBe("ASK_IDENTIFIER");

    const row = db
      .prepare("SELECT state, data_json FROM brand_flows WHERE flow_id = ?")
      .get(flowId) as { state: string; data_json: string };
    expect(row.state).toBe("ASK_IDENTIFIER");
    expect(JSON.parse(row.data_json)).toMatchObject({ serviceType: "app" });
    db.close();
  });

  it("drives the generator when reducer hits COLLECTING (web)", async () => {
    const db = initDatabase(tmpDbPath());
    const runGenerate = vi.fn(async () => ({
      profile: {
        _meta: {
          serviceType: "web" as const,
          generatedAt: "2026-04-15T00:00:00Z",
          sources: ["web"],
          identifiers: {},
        },
        identity: {
          tagline: "Track the fridge",
          mission: "",
          positioning: "Simple",
          category: "",
        },
        voice: { tone: "friendly", personality: "", do: [], dont: [] },
        audience: { primary: "Young pros", painPoints: [], motivations: [] },
        visual: { primaryColor: "", style: "" },
        competitors: { differentiation: "Photo entry" },
        goals: { currentQuarter: "", keyMetrics: [] },
      },
      yamlPath: path.join(tempHome, "brands", "eodin-app", "brand.yaml"),
    }));
    const skill = new BrandSkill({ runGenerate });
    const ctx = mkCtx(db);

    await skill.dispatch(ctx, "brand");
    const row1 = db.prepare("SELECT flow_id FROM brand_flows").get() as {
      flow_id: string;
    };
    await skill.continueFlow(ctx, row1.flow_id, {
      text: "web",
      files: [],
    });
    const preview = await skill.continueFlow(ctx, row1.flow_id, {
      text: "https://eodin.app",
      files: [],
    });

    expect(runGenerate).toHaveBeenCalledOnce();
    expect(preview.continuation?.state).toBe("PREVIEW");
    expect(preview.summary).toContain("Track the fridge");
    db.close();
  });

  it("cancels from any state when user says '취소'", async () => {
    const db = initDatabase(tmpDbPath());
    const skill = new BrandSkill();
    const ctx = mkCtx(db);

    const start = await skill.dispatch(ctx, "brand");
    const flowId = start.continuation!.flowId;

    const cancel = await skill.continueFlow(ctx, flowId, {
      text: "취소",
      files: [],
    });
    expect(cancel.continuation?.state).toBe("CANCELLED");

    const row = db
      .prepare("SELECT COUNT(*) as n FROM brand_flows WHERE flow_id = ?")
      .get(flowId) as { n: number };
    expect(row.n).toBe(0);
    db.close();
  });

  it("saves uploaded logo and advances to ASK_DESIGN", async () => {
    const db = initDatabase(tmpDbPath());
    const downloadFile = vi.fn(async (_file, destPath: string) => {
      await fs.writeFile(destPath, Buffer.from("LOGO"));
    });

    const skill = new BrandSkill();
    const ctx = mkCtx(db, { downloadFile });

    // Seed a flow directly into ASK_LOGO with a serviceId.
    const flowId = "flow-logo";
    const nowMs = Date.now();
    db.prepare(
      "INSERT INTO brand_flows (flow_id, user_id, thread_key, service_id, state, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      flowId,
      "U1",
      "C1:123.456",
      "fridgify",
      "ASK_LOGO",
      JSON.stringify({ serviceType: "app", serviceId: "fridgify" }),
      nowMs,
      nowMs,
    );

    const res = await skill.continueFlow(ctx, flowId, {
      text: "",
      files: [
        {
          url: "https://files.slack.com/logo.png",
          mimeType: "image/png",
          filename: "logo.png",
        },
      ],
    });

    expect(downloadFile).toHaveBeenCalledOnce();
    expect(res.continuation?.state).toBe("ASK_DESIGN");
    const saved = await fs.readFile(
      path.join(tempHome, "brands", "fridgify", "logo.png"),
    );
    expect(saved.toString()).toBe("LOGO");
    db.close();
  });

  it("rejects unsupported image MIME without advancing", async () => {
    const db = initDatabase(tmpDbPath());
    const downloadFile = vi.fn();
    const skill = new BrandSkill();
    const ctx = mkCtx(db, { downloadFile });

    const flowId = "flow-bad-mime";
    const nowMs = Date.now();
    db.prepare(
      "INSERT INTO brand_flows (flow_id, user_id, thread_key, service_id, state, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      flowId,
      "U1",
      "C1:123.456",
      "fridgify",
      "ASK_LOGO",
      JSON.stringify({ serviceType: "app", serviceId: "fridgify" }),
      nowMs,
      nowMs,
    );

    const res = await skill.continueFlow(ctx, flowId, {
      text: "",
      files: [
        { url: "x", mimeType: "image/gif", filename: "logo.gif" },
      ],
    });

    expect(downloadFile).not.toHaveBeenCalled();
    expect(res.continuation?.state).toBe("ASK_LOGO");
    expect(res.summary).toContain("PNG/JPG/WEBP");
    db.close();
  });

  it("terminates on unknown flow id", async () => {
    const db = initDatabase(tmpDbPath());
    const skill = new BrandSkill();
    const ctx = mkCtx(db);

    const res = await skill.continueFlow(ctx, "ghost", {
      text: "app",
      files: [],
    });
    expect(res.continuation).toBeUndefined();
    expect(res.summary).toContain("활성화된");
    db.close();
  });

  it("cleans up orphaned brand.yaml on PREVIEW cancel", async () => {
    const db = initDatabase(tmpDbPath());
    const yamlDir = path.join(tempHome, "brands", "eodin-app");
    await fs.mkdir(yamlDir, { recursive: true });
    const yamlPath = path.join(yamlDir, "brand.yaml");
    await fs.writeFile(yamlPath, "# partial");

    const flowId = "flow-preview";
    const nowMs = Date.now();
    db.prepare(
      "INSERT INTO brand_flows (flow_id, user_id, thread_key, service_id, state, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      flowId,
      "U1",
      "C1:123.456",
      "eodin-app",
      "PREVIEW",
      JSON.stringify({
        serviceType: "web",
        serviceId: "eodin-app",
        _yamlPath: yamlPath,
      }),
      nowMs,
      nowMs,
    );

    const skill = new BrandSkill();
    const ctx = mkCtx(db);
    const res = await skill.continueFlow(ctx, flowId, {
      text: "취소",
      files: [],
    });
    expect(res.continuation?.state).toBe("CANCELLED");
    await expect(fs.access(yamlPath)).rejects.toThrow();
    db.close();
  });

  it("isolates concurrent flows for the same user in different threads", async () => {
    const db = initDatabase(tmpDbPath());
    const skill = new BrandSkill();

    const ctxA = mkCtx(db, {
      flowContext: { userId: "U1", threadKey: "C1:thread-A" },
    });
    const ctxB = mkCtx(db, {
      flowContext: { userId: "U1", threadKey: "C1:thread-B" },
    });

    const a = await skill.dispatch(ctxA, "brand");
    const b = await skill.dispatch(ctxB, "brand");

    expect(a.continuation?.flowId).not.toBe(b.continuation?.flowId);

    // Advance thread A without disturbing thread B.
    await skill.continueFlow(ctxA, a.continuation!.flowId, {
      text: "app",
      files: [],
    });

    const rowA = db
      .prepare("SELECT state FROM brand_flows WHERE flow_id = ?")
      .get(a.continuation!.flowId) as { state: string };
    const rowB = db
      .prepare("SELECT state FROM brand_flows WHERE flow_id = ?")
      .get(b.continuation!.flowId) as { state: string };
    expect(rowA.state).toBe("ASK_IDENTIFIER");
    expect(rowB.state).toBe("ASK_TYPE");
    db.close();
  });

  it("surfaces generator errors as CANCELLED transition", async () => {
    const db = initDatabase(tmpDbPath());
    const runGenerate = vi.fn(async () => {
      throw new Error("upstream down");
    });
    const skill = new BrandSkill({ runGenerate });
    const ctx = mkCtx(db);

    await skill.dispatch(ctx, "brand");
    const row = db.prepare("SELECT flow_id FROM brand_flows").get() as {
      flow_id: string;
    };
    await skill.continueFlow(ctx, row.flow_id, { text: "web", files: [] });
    const boom = await skill.continueFlow(ctx, row.flow_id, {
      text: "https://eodin.app",
      files: [],
    });
    expect(boom.continuation?.state).toBe("CANCELLED");
    expect(boom.summary).toContain("upstream down");

    const count = db
      .prepare("SELECT COUNT(*) as n FROM brand_flows")
      .get() as { n: number };
    expect(count.n).toBe(0);
    db.close();
  });
});
