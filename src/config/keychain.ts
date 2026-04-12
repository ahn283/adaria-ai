import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_ADARIA_HOME = path.join(os.homedir(), ".adaria");

/**
 * Derive the Keychain service prefix from the current `ADARIA_HOME` so
 * dev profiles (`ADARIA_HOME=$HOME/.adaria-dev`) cannot clobber the
 * production secrets in `$HOME/.adaria`. Prod stays on `adaria-ai`
 * (backwards-compatible) and any non-default home gets `adaria-ai-<slug>`.
 *
 * Split into a helper so tests can exercise it without touching the
 * real macOS Keychain.
 */
export function deriveServicePrefix(adariaHome?: string): string {
  const home = adariaHome ?? process.env["ADARIA_HOME"] ?? DEFAULT_ADARIA_HOME;
  if (path.resolve(home) === path.resolve(DEFAULT_ADARIA_HOME)) {
    return "adaria-ai";
  }
  const basename = path.basename(home);
  // Strip leading dot(s) and slugify — Keychain service names tolerate
  // alphanumerics, hyphens, and underscores comfortably.
  const slug = basename
    .replace(/^\.+/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .toLowerCase();
  if (slug.length === 0) return "adaria-ai";
  // Preserve the `adaria-ai` prefix and strip any redundant `adaria`
  // fragment the user may have already put into their home name.
  const trimmed = slug.replace(/^adaria[_-]?/, "");
  if (trimmed.length === 0 || trimmed === "ai") return "adaria-ai";
  return `adaria-ai-${trimmed}`;
}

// Account name stays constant across profiles. The prod/dev distinction
// lives in the Keychain *service* name so both profiles can coexist while
// still being user-attributable to the same principal.
const KEYCHAIN_ACCOUNT = "adaria-ai";

function serviceKey(key: string): string {
  return `${deriveServicePrefix()}:${key}`;
}

export async function setSecret(key: string, value: string): Promise<void> {
  const service = serviceKey(key);
  try {
    await execFileAsync("security", ["delete-generic-password", "-s", service]);
  } catch {
    // Not found — expected on first write
  }

  await execFileAsync("security", [
    "add-generic-password",
    "-s",
    service,
    "-a",
    KEYCHAIN_ACCOUNT,
    "-w",
    value,
    "-U",
  ]);
}

export async function getSecret(key: string): Promise<string | null> {
  const service = serviceKey(key);
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function deleteSecret(key: string): Promise<void> {
  const service = serviceKey(key);
  try {
    await execFileAsync("security", ["delete-generic-password", "-s", service]);
  } catch {
    // Not found — nothing to delete
  }
}
