import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DAEMON_LABEL,
  getDaemonPlistPath,
  isDaemonLoaded,
} from "./start.js";

const execFileAsync = promisify(execFile);

export async function runStop(): Promise<void> {
  if (!(await isDaemonLoaded())) {
    console.log("adaria-ai daemon is not loaded.");
    return;
  }

  const plistPath = getDaemonPlistPath();

  try {
    await execFileAsync("launchctl", ["unload", plistPath]);
  } catch (err) {
    console.error(
      `launchctl unload failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    await fs.unlink(plistPath);
  } catch {
    // Plist already removed, ok.
  }

  console.log(`adaria-ai daemon unloaded (${DAEMON_LABEL}).`);
}
