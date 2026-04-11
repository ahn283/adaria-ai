/**
 * Non-project-scoped memory for adaria-ai.
 *
 * adaria-ai is a single-user marketing daemon with no concept of projects,
 * so the project-scoped memory from pilot-ai is dropped. What remains:
 * a rolling user-preferences file and a day-indexed history log that the
 * daemon can inject into Claude's system prompt for cross-session context.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { MEMORY_DIR } from "../utils/paths.js";

const MAX_MEMORY_LINES = 200;

function getMemoryFilePath(): string {
  return path.join(MEMORY_DIR, "MEMORY.md");
}

function getHistoryPath(date?: Date): string {
  const d = date ?? new Date();
  const dateStr = d.toISOString().split("T")[0];
  return path.join(MEMORY_DIR, "history", `${dateStr}.md`);
}

// --- MEMORY.md (user preferences) ---

export async function readUserMemory(): Promise<string> {
  try {
    return await fs.readFile(getMemoryFilePath(), "utf-8");
  } catch {
    return "";
  }
}

export async function writeUserMemory(content: string): Promise<void> {
  const lines = content.split("\n");
  const trimmed = lines.slice(0, MAX_MEMORY_LINES).join("\n");
  await fs.mkdir(MEMORY_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(getMemoryFilePath(), trimmed);
}

export async function appendUserMemory(entry: string): Promise<void> {
  const existing = await readUserMemory();
  const updated = existing ? `${existing}\n${entry}` : entry;
  await writeUserMemory(updated);
}

// --- History ---

export async function appendHistory(entry: string): Promise<void> {
  const histPath = getHistoryPath();
  await fs.mkdir(path.dirname(histPath), { recursive: true, mode: 0o700 });

  const timestamp = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const line = `- ${timestamp}: ${entry}\n`;

  await fs.appendFile(histPath, line);
}

export async function readHistory(date?: Date): Promise<string> {
  try {
    return await fs.readFile(getHistoryPath(date), "utf-8");
  } catch {
    return "";
  }
}

export async function getRecentHistory(days = 3): Promise<string> {
  const entries: string[] = [];
  const now = new Date();

  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const content = await readHistory(d);
    if (content) {
      const dateStr = d.toISOString().split("T")[0];
      entries.push(`### ${dateStr}\n${content}`);
    }
  }

  return entries.join("\n\n");
}

// --- Assemble memory context for prompts ---

export async function buildMemoryContext(): Promise<string> {
  const parts: string[] = [];

  const userMemory = await readUserMemory();
  if (userMemory) {
    parts.push(`<USER_PREFERENCES>\n${userMemory}\n</USER_PREFERENCES>`);
  }

  const history = await getRecentHistory(3);
  if (history) {
    parts.push(`<RECENT_HISTORY>\n${history}\n</RECENT_HISTORY>`);
  }

  return parts.join("\n\n");
}

/** Test-only reset. */
export async function resetMemory(): Promise<void> {
  await fs.rm(MEMORY_DIR, { recursive: true, force: true });
  await fs.mkdir(path.join(MEMORY_DIR, "history"), {
    recursive: true,
    mode: 0o700,
  });
}
