import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { LOGS_DIR } from "../utils/paths.js";

function todayLogPath(): string {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_DIR, `adaria-${today}.log`);
}

async function findMostRecentLog(): Promise<string | null> {
  try {
    const entries = await fs.readdir(LOGS_DIR);
    const adariaLogs = entries
      .filter((name) => name.startsWith("adaria-") && name.endsWith(".log"))
      .sort();
    const newest = adariaLogs.at(-1);
    return newest ? path.join(LOGS_DIR, newest) : null;
  } catch {
    return null;
  }
}

export async function runLogs(
  options: { follow?: boolean } = {},
): Promise<void> {
  // Prefer today's log; if it doesn't exist yet (fresh install, before the
  // first event), fall back to the newest `adaria-YYYY-MM-DD.log`.
  let logPath: string | null = todayLogPath();
  try {
    await fs.access(logPath);
  } catch {
    logPath = await findMostRecentLog();
  }

  if (!logPath) {
    console.log(`No log files found in ${LOGS_DIR}.`);
    return;
  }

  if (options.follow) {
    console.log(`Following ${logPath} (Ctrl+C to stop):\n`);
    const child = spawn("tail", ["-f", logPath], { stdio: "inherit" });
    process.on("SIGINT", () => {
      child.kill();
      process.exit(0);
    });
    return;
  }

  const content = await fs.readFile(logPath, "utf-8");
  const lines = content.split("\n");
  const tail = lines.slice(-50).join("\n");
  console.log(tail);
}
