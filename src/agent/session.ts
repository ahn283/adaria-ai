/**
 * Session store for mapping Slack threads to Claude CLI sessions.
 * Enables multi-turn conversations where each Slack thread maintains a
 * continuous Claude session with full context.
 */
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { SESSIONS_PATH } from "../utils/paths.js";

export interface SessionEntry {
  /** Claude CLI session ID (UUID) */
  sessionId: string;
  /** Messenger thread ID */
  threadId: string;
  /** Channel ID */
  channelId: string;
  /** Platform — slack only for adaria-ai, left generic for future messengers */
  platform: "slack";
  /** When this session was created */
  createdAt: string;
  /** When this session was last used */
  lastUsedAt: string;
  /** Number of turns in this session */
  turnCount: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSION_TURNS = 10;

let sessions: Map<string, SessionEntry> = new Map();
let loadPromise: Promise<void> | null = null;

function threadKey(
  platform: string,
  channelId: string,
  threadId: string,
): string {
  return `${platform}:${channelId}:${threadId}`;
}

async function ensureLoaded(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const data = await fs.readFile(SESSIONS_PATH, "utf-8");
      const entries = JSON.parse(data) as SessionEntry[];
      sessions = new Map(
        entries.map((e) => [threadKey(e.platform, e.channelId, e.threadId), e]),
      );
    } catch {
      sessions = new Map();
    }
  })();
  return loadPromise;
}

async function save(): Promise<void> {
  const entries = Array.from(sessions.values());
  await fs.writeFile(SESSIONS_PATH, JSON.stringify(entries, null, 2), {
    mode: 0o600,
  });
}

export async function getSession(
  platform: string,
  channelId: string,
  threadId: string,
): Promise<SessionEntry | null> {
  await ensureLoaded();
  const key = threadKey(platform, channelId, threadId);
  const entry = sessions.get(key);
  if (!entry) return null;

  const age = Date.now() - new Date(entry.lastUsedAt).getTime();
  if (age > SESSION_TTL_MS) {
    sessions.delete(key);
    await save();
    return null;
  }

  if (entry.turnCount >= MAX_SESSION_TURNS) {
    sessions.delete(key);
    await save();
    return null;
  }

  return entry;
}

export async function createSession(
  platform: "slack",
  channelId: string,
  threadId: string,
  explicitSessionId?: string,
): Promise<SessionEntry> {
  await ensureLoaded();

  const entry: SessionEntry = {
    // When `explicitSessionId` is provided, the caller is responsible for
    // ensuring the same UUID is handed to Claude CLI via `--session-id`.
    // The msg_too_long fallback in `core.ts` relies on this to keep the
    // stored mapping and Claude's actual session in lock-step; otherwise
    // the next message on the thread would `--resume` a UUID Claude has
    // never seen (M1 core review HIGH #1).
    sessionId: explicitSessionId ?? crypto.randomUUID(),
    threadId,
    channelId,
    platform,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    turnCount: 1,
  };

  const key = threadKey(platform, channelId, threadId);
  sessions.set(key, entry);
  await save();
  return entry;
}

export async function touchSession(
  platform: string,
  channelId: string,
  threadId: string,
): Promise<void> {
  await ensureLoaded();
  const key = threadKey(platform, channelId, threadId);
  const entry = sessions.get(key);
  if (entry) {
    entry.lastUsedAt = new Date().toISOString();
    entry.turnCount++;
    await save();
  }
}

/** Deletes a specific session. Used for error recovery (msg_too_long). */
export async function deleteSession(
  platform: string,
  channelId: string,
  threadId: string,
): Promise<boolean> {
  await ensureLoaded();
  const key = threadKey(platform, channelId, threadId);
  const deleted = sessions.delete(key);
  if (deleted) await save();
  return deleted;
}

export async function cleanupSessions(): Promise<number> {
  await ensureLoaded();
  const now = Date.now();
  let removed = 0;
  for (const [key, entry] of sessions) {
    const age = now - new Date(entry.lastUsedAt).getTime();
    if (age > SESSION_TTL_MS) {
      sessions.delete(key);
      removed++;
    }
  }
  if (removed > 0) await save();
  return removed;
}

export async function getSessionCount(): Promise<number> {
  await ensureLoaded();
  return sessions.size;
}

export function getRemainingTurns(entry: SessionEntry): number {
  return Math.max(0, MAX_SESSION_TURNS - entry.turnCount);
}

/** Test-only reset. */
export function resetSessionStore(): void {
  sessions = new Map();
  loadPromise = null;
}
