import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate $ADARIA_HOME BEFORE importing session (paths.ts reads it once at
// module load).
const TEST_HOME = path.join(
  os.tmpdir(),
  `adaria-test-session-${String(process.pid)}-${Math.random().toString(36).slice(2, 8)}`,
);
process.env["ADARIA_HOME"] = TEST_HOME;

const {
  createSession,
  getSession,
  touchSession,
  deleteSession,
  cleanupSessions,
  getSessionCount,
  getRemainingTurns,
  resetSessionStore,
} = await import("../../src/agent/session.js");
const { SESSIONS_PATH } = await import("../../src/utils/paths.js");

describe("session store", () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_HOME, { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(TEST_HOME, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  beforeEach(() => {
    try {
      fs.rmSync(SESSIONS_PATH, { force: true });
    } catch {
      // ignore
    }
    resetSessionStore();
  });

  it("createSession persists a new entry and assigns a UUID sessionId", async () => {
    const entry = await createSession("slack", "C1", "T1");
    expect(entry.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(entry.turnCount).toBe(1);
    expect(fs.existsSync(SESSIONS_PATH)).toBe(true);
  });

  it("getSession returns null for unknown thread", async () => {
    expect(await getSession("slack", "C1", "unknown")).toBeNull();
  });

  it("getSession returns the entry for a known thread", async () => {
    const created = await createSession("slack", "C1", "T2");
    const got = await getSession("slack", "C1", "T2");
    expect(got?.sessionId).toBe(created.sessionId);
  });

  it("touchSession increments turnCount and updates lastUsedAt", async () => {
    const created = await createSession("slack", "C1", "T3");
    const before = created.lastUsedAt;
    await new Promise((r) => setTimeout(r, 5));
    await touchSession("slack", "C1", "T3");
    const after = await getSession("slack", "C1", "T3");
    expect(after?.turnCount).toBe(2);
    expect(after?.lastUsedAt).not.toBe(before);
  });

  it("getSession returns null once turnCount hits the limit and deletes the entry", async () => {
    await createSession("slack", "C1", "T4");
    for (let i = 0; i < 9; i++) {
      await touchSession("slack", "C1", "T4");
    }
    // turnCount is now 10 (create=1 + 9 touches). getSession should evict.
    const got = await getSession("slack", "C1", "T4");
    expect(got).toBeNull();
    expect(await getSessionCount()).toBe(0);
  });

  it("deleteSession removes the entry and returns true exactly once", async () => {
    await createSession("slack", "C1", "T5");
    expect(await deleteSession("slack", "C1", "T5")).toBe(true);
    expect(await deleteSession("slack", "C1", "T5")).toBe(false);
  });

  it("cleanupSessions removes entries whose lastUsedAt is older than the TTL", async () => {
    await createSession("slack", "C1", "T6");
    // Forge an expired entry directly on disk.
    const raw = JSON.parse(fs.readFileSync(SESSIONS_PATH, "utf-8")) as {
      lastUsedAt: string;
    }[];
    const expired = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    if (raw[0]) raw[0].lastUsedAt = expired;
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify(raw));
    resetSessionStore();

    const removed = await cleanupSessions();
    expect(removed).toBe(1);
    expect(await getSessionCount()).toBe(0);
  });

  it("getRemainingTurns reports turns-left from the max", async () => {
    const entry = await createSession("slack", "C1", "T7");
    expect(getRemainingTurns(entry)).toBe(9);
  });
});
