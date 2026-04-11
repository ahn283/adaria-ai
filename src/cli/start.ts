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

const LAUNCH_AGENTS_DIR = path.join(
  process.env["HOME"] ?? "",
  "Library",
  "LaunchAgents",
);

export function getDaemonPlistPath(): string {
  return path.join(LAUNCH_AGENTS_DIR, `${DAEMON_LABEL}.plist`);
}

function getDaemonEntryScriptPath(): string {
  // src/cli/start.ts at runtime lives at dist/cli/start.js. The CLI entry
  // is dist/index.js, one directory up.
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), "..", "index.js");
}

async function renderPlist(): Promise<string> {
  const templatePath = path.join(
    BUNDLED_LAUNCHD_DIR,
    `${DAEMON_LABEL}.plist.template`,
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

export async function isDaemonLoaded(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("launchctl", ["list"]);
    return stdout.includes(DAEMON_LABEL);
  } catch {
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

  if (await isDaemonLoaded()) {
    console.log(`adaria-ai daemon is already loaded (${DAEMON_LABEL}).`);
    console.log(
      'Run "adaria-ai stop" first if you want to re-render the plist with updated paths or config changes (M1 CLI review MED #3).',
    );
    return;
  }

  await fs.mkdir(LOGS_DIR, { recursive: true, mode: 0o700 });
  await fs.mkdir(LAUNCH_AGENTS_DIR, { recursive: true });

  const plistContent = await renderPlist();
  const plistPath = getDaemonPlistPath();
  await fs.writeFile(plistPath, plistContent, { mode: 0o644 });

  try {
    await execFileAsync("launchctl", ["load", plistPath]);
    console.log(`adaria-ai daemon loaded (${DAEMON_LABEL}).`);
    console.log(`  Logs: ${LOGS_DIR}/daemon.out.log`);
    console.log(`  Plist: ${plistPath}`);
  } catch (err) {
    console.error(
      `launchctl load failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}
