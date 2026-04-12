import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ALL_LABELS, getPlistPath, isLabelLoaded } from "./start.js";

const execFileAsync = promisify(execFile);

async function unloadLabel(label: string): Promise<void> {
  if (!(await isLabelLoaded(label))) {
    console.log(`  ${label}: not loaded (skipped)`);
    return;
  }

  const plistPath = getPlistPath(label);

  try {
    await execFileAsync("launchctl", ["unload", plistPath]);
  } catch (err) {
    console.error(
      `  ${label}: launchctl unload failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  try {
    await fs.unlink(plistPath);
  } catch {
    // Plist already removed, ok.
  }

  console.log(`  ${label}: unloaded`);
}

export async function runStop(): Promise<void> {
  console.log("Unloading adaria-ai launchd agents...");

  for (const label of ALL_LABELS) {
    await unloadLabel(label);
  }

  console.log("\nDone.");
}
