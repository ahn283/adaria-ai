/**
 * `adaria-ai start` — load the daemon launchd plist.
 *
 * M1 only loads the reactive daemon. M6 will extend this to additionally
 * load `com.adaria-ai.weekly` (cron Sun 23:00) and `com.adaria-ai.monitor`
 * (cron daily 23:00). Each label is a separate plist; launchctl handles
 * the three independently.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { configExists } from "../config/store.js";
import {
  ADARIA_HOME,
  BUNDLED_LAUNCHD_DIR,
  LOGS_DIR,
} from "../utils/paths.js";

const execFileAsync = promisify(execFile);

export const DAEMON_LABEL = "com.adaria-ai.daemon";
export const WEEKLY_LABEL = "com.adaria-ai.weekly";
export const MONITOR_LABEL = "com.adaria-ai.monitor";

/** All three launchd labels managed by adaria-ai. */
export const ALL_LABELS = [DAEMON_LABEL, WEEKLY_LABEL, MONITOR_LABEL] as const;

const LAUNCH_AGENTS_DIR = path.join(
  process.env["HOME"] ?? "",
  "Library",
  "LaunchAgents",
);

export function getPlistPath(label: string): string {
  return path.join(LAUNCH_AGENTS_DIR, `${label}.plist`);
}

export function getDaemonPlistPath(): string {
  return getPlistPath(DAEMON_LABEL);
}

function getDaemonEntryScriptPath(): string {
  // src/cli/start.ts at runtime lives at dist/cli/start.js. The CLI entry
  // is dist/index.js, one directory up.
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), "..", "index.js");
}

async function renderPlist(label: string = DAEMON_LABEL): Promise<string> {
  const templatePath = path.join(
    BUNDLED_LAUNCHD_DIR,
    `${label}.plist.template`,
  );
  const template = await fs.readFile(templatePath, "utf-8");

  // launchd inherits a near-empty PATH, so we set an explicit one that
  // matches a typical interactive shell. claude-cli usually lives in
  // /opt/homebrew/bin (Apple Silicon) or /usr/local/bin (Intel).
  const pathValue =
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" +
    path.join(process.env["HOME"] ?? "", ".local", "bin");

  return template
    .replaceAll("__NODE_BIN__", process.execPath)
    .replaceAll("__SCRIPT_PATH__", getDaemonEntryScriptPath())
    .replaceAll("__ADARIA_HOME__", ADARIA_HOME)
    .replaceAll("__LOG_DIR__", LOGS_DIR)
    .replaceAll("__PATH__", pathValue);
}

export async function isLabelLoaded(label: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("launchctl", ["list"]);
    return stdout.split("\n").some((l) => l.trim().split(/\s+/)[2] === label);
  } catch {
    return false;
  }
}

export async function isDaemonLoaded(): Promise<boolean> {
  return isLabelLoaded(DAEMON_LABEL);
}

async function loadLabel(label: string): Promise<boolean> {
  if (await isLabelLoaded(label)) {
    console.log(`  ${label}: already loaded (skipped)`);
    return true;
  }

  const plistContent = await renderPlist(label);
  const plistPath = getPlistPath(label);
  await fs.writeFile(plistPath, plistContent, { mode: 0o644 });

  try {
    await execFileAsync("launchctl", ["load", plistPath]);
    console.log(`  ${label}: loaded`);
    return true;
  } catch (err) {
    console.error(
      `  ${label}: launchctl load failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

export async function runStart(): Promise<void> {
  if (!(await configExists())) {
    console.error(
      'No configuration found. Run "adaria-ai init" first to create ~/.adaria/config.yaml.',
    );
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(LOGS_DIR, { recursive: true, mode: 0o700 });
  await fs.mkdir(LAUNCH_AGENTS_DIR, { recursive: true });

  console.log("Loading adaria-ai launchd agents...");

  let allOk = true;
  for (const label of ALL_LABELS) {
    const ok = await loadLabel(label);
    if (!ok) allOk = false;
  }

  if (allOk) {
    console.log(`\nAll 3 agents loaded. Logs: ${LOGS_DIR}/`);
  } else {
    console.error("\nSome agents failed to load. Check errors above.");
    process.exitCode = 1;
  }
}
