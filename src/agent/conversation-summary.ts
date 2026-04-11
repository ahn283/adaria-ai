/**
 * Conversation Summary Buffer for thread-based conversation continuity.
 *
 * Maintains a rolling summary of each thread's conversation so that
 * context can be restored when a Claude CLI session is reset (msg_too_long).
 *
 * Strategy: hybrid — normal flow uses --resume for full context; this
 * summary is the fallback injected into a fresh session's system prompt.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { CONVERSATIONS_DIR } from "../utils/paths.js";
import { maskSecrets } from "./audit.js";

export interface TurnSummary {
  /** User message (truncated to 500 chars) */
  userMessage: string;
  /** Agent action summary (truncated to ~800 chars) */
  agentAction: string;
  /** ISO timestamp */
  timestamp: string;
}

export interface ConversationSummary {
  /** Unique key: platform:channelId:threadId */
  threadKey: string;
  /** Recent turn summaries (FIFO, max 15) */
  turns: TurnSummary[];
  /** Accumulated key decisions */
  keyDecisions: string[];
  /** Accumulated modified file paths */
  modifiedFiles: string[];
  /** ISO timestamp of last update */
  lastUpdated: string;
}

const MAX_TURNS = 15;
const MAX_DECISIONS = 20;
const MAX_FILES = 30;
const MAX_USER_MSG_LEN = 500;
const MAX_ACTION_LEN = 800;
const SUMMARY_TTL_MS = 48 * 60 * 60 * 1000;

function getSummaryPath(threadKey: string): string {
  const filename = threadKey.replace(/:/g, "_") + ".json";
  return path.join(CONVERSATIONS_DIR, filename);
}

function buildThreadKey(
  platform: string,
  channelId: string,
  threadId: string,
): string {
  return `${platform}:${channelId}:${threadId}`;
}

export async function loadSummary(
  platform: string,
  channelId: string,
  threadId: string,
): Promise<ConversationSummary | null> {
  const key = buildThreadKey(platform, channelId, threadId);
  const filePath = getSummaryPath(key);
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return JSON.parse(data) as ConversationSummary;
  } catch {
    return null;
  }
}

export async function saveSummary(
  summary: ConversationSummary,
): Promise<void> {
  const filePath = getSummaryPath(summary.threadKey);
  await fs.mkdir(CONVERSATIONS_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, JSON.stringify(summary, null, 2), {
    mode: 0o600,
  });
}

export function extractActionSummary(agentResponse: string): string {
  const sections: string[] = [];

  const firstPara = agentResponse.split("\n\n")[0]?.replace(/\n/g, " ").trim();
  if (firstPara) sections.push(firstPara.slice(0, 400));

  const statusLines = agentResponse.match(
    /(?:❌|✅|⚠️|Error:|Success:|Failed:|Warning:).*/g,
  );
  if (statusLines) {
    for (const line of statusLines.slice(0, 3)) {
      sections.push(line.trim().slice(0, 150));
    }
  }

  const commitLines = agentResponse.match(/commit [0-9a-f]{7,}.*/gi);
  if (commitLines) {
    for (const line of commitLines.slice(0, 2)) {
      sections.push(line.trim().slice(0, 150));
    }
  }

  const result = sections.join(" | ");
  if (result.length <= MAX_ACTION_LEN) return result;

  const truncated = result.slice(0, MAX_ACTION_LEN);
  const lastSep = truncated.lastIndexOf(" | ");
  if (lastSep > MAX_ACTION_LEN * 0.5) {
    return truncated.slice(0, lastSep);
  }
  return truncated + "...";
}

export function extractModifiedFiles(agentResponse: string): string[] {
  const patterns = [
    /(?:Writing|Editing|Creating|Modifying|✏️)\s+([\w./-]+\.\w+)/gi,
    /(?:wrote to|saved|updated|created|modified)\s+([\w./-]+\.\w+)/gi,
    /^\s*([\w./-]+\.\w+)\s*\|/gm,
  ];

  const files = new Set<string>();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(agentResponse)) !== null) {
      const filePath = match[1];
      if (filePath && filePath.includes("/") && !filePath.startsWith("http")) {
        files.add(filePath);
      }
    }
  }
  return [...files];
}

export function extractKeyDecisions(agentResponse: string): string[] {
  const decisions: string[] = [];
  const patterns = [
    /commit\s+[0-9a-f]+\s*[—–-]\s*(.+)/gi,
    /(?:Created|Deleted|Installed|Configured|Updated|Fixed|Removed|Added|Migrated|Refactored)\s+(.{10,100}?)[.!\n]/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(agentResponse)) !== null) {
      const captured = match[1];
      if (!captured) continue;
      const decision = captured.trim().slice(0, 200);
      if (!decisions.includes(decision)) {
        decisions.push(decision);
      }
    }
  }

  return decisions;
}

export async function updateConversationSummary(
  platform: string,
  channelId: string,
  threadId: string,
  rawUserMessage: string,
  rawAgentResponse: string,
): Promise<void> {
  // Mask secrets before any field derived from these blobs is persisted to
  // disk or later re-injected into Claude's system prompt via
  // getConversationSummaryText().
  const userMessage = maskSecrets(rawUserMessage);
  const agentResponse = maskSecrets(rawAgentResponse);

  const key = buildThreadKey(platform, channelId, threadId);
  const existing = await loadSummary(platform, channelId, threadId);

  const summary: ConversationSummary = existing ?? {
    threadKey: key,
    turns: [],
    keyDecisions: [],
    modifiedFiles: [],
    lastUpdated: new Date().toISOString(),
  };

  const turn: TurnSummary = {
    userMessage: userMessage.slice(0, MAX_USER_MSG_LEN),
    agentAction: extractActionSummary(agentResponse),
    timestamp: new Date().toISOString(),
  };
  summary.turns.push(turn);
  if (summary.turns.length > MAX_TURNS) {
    summary.turns = summary.turns.slice(-MAX_TURNS);
  }

  const newFiles = extractModifiedFiles(agentResponse);
  for (const f of newFiles) {
    if (!summary.modifiedFiles.includes(f)) {
      summary.modifiedFiles.push(f);
    }
  }
  if (summary.modifiedFiles.length > MAX_FILES) {
    summary.modifiedFiles = summary.modifiedFiles.slice(-MAX_FILES);
  }

  const newDecisions = extractKeyDecisions(agentResponse);
  for (const d of newDecisions) {
    if (!summary.keyDecisions.includes(d)) {
      summary.keyDecisions.push(d);
    }
  }
  if (summary.keyDecisions.length > MAX_DECISIONS) {
    summary.keyDecisions = summary.keyDecisions.slice(-MAX_DECISIONS);
  }

  summary.lastUpdated = new Date().toISOString();
  await saveSummary(summary);
}

export async function getConversationSummaryText(
  platform: string,
  channelId: string,
  threadId: string,
): Promise<string | null> {
  const summary = await loadSummary(platform, channelId, threadId);
  if (!summary || summary.turns.length === 0) return null;

  const lines: string[] = [];
  lines.push(
    "This is the conversation history from this thread. Use this context to respond to the user's follow-up request.",
  );
  lines.push("");

  lines.push(`## Previous conversation (${summary.turns.length} turns)`);
  for (let i = 0; i < summary.turns.length; i++) {
    const turn = summary.turns[i];
    if (!turn) continue;
    const time = new Date(turn.timestamp).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    lines.push(`${i + 1}. [${time}] User: "${turn.userMessage}"`);
    lines.push(`   → Agent: ${turn.agentAction}`);
    lines.push("");
  }

  if (summary.modifiedFiles.length > 0) {
    lines.push("## Modified files");
    for (const f of summary.modifiedFiles) {
      lines.push(`- ${f}`);
    }
    lines.push("");
  }

  if (summary.keyDecisions.length > 0) {
    lines.push("## Key decisions");
    for (const d of summary.keyDecisions) {
      lines.push(`- ${d}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function cleanupExpiredSummaries(): Promise<number> {
  let removed = 0;
  try {
    const files = await fs.readdir(CONVERSATIONS_DIR);
    const now = Date.now();
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = path.join(CONVERSATIONS_DIR, file);
      try {
        const data = await fs.readFile(filePath, "utf-8");
        const summary = JSON.parse(data) as ConversationSummary;
        const age = now - new Date(summary.lastUpdated).getTime();
        if (age > SUMMARY_TTL_MS) {
          await fs.unlink(filePath);
          removed++;
        }
      } catch {
        await fs.unlink(filePath).catch(() => {});
        removed++;
      }
    }
  } catch {
    // Directory doesn't exist yet.
  }
  return removed;
}
