import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const thisFile = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(thisFile), "..", "..");

export const BUNDLED_PROMPTS_DIR = path.join(packageRoot, "prompts");
export const BUNDLED_LAUNCHD_DIR = path.join(packageRoot, "launchd");
export const PACKAGE_JSON_PATH = path.join(packageRoot, "package.json");

export const ADARIA_HOME =
  process.env["ADARIA_HOME"] ?? path.join(os.homedir(), ".adaria");

export const CONFIG_PATH = path.join(ADARIA_HOME, "config.yaml");
export const APPS_PATH = path.join(ADARIA_HOME, "apps.yaml");
export const SESSIONS_PATH = path.join(ADARIA_HOME, "sessions.json");
export const AUDIT_PATH = path.join(ADARIA_HOME, "audit.jsonl");
export const DATA_DIR = path.join(ADARIA_HOME, "data");
export const DB_PATH = path.join(DATA_DIR, "adaria.db");
export const LOGS_DIR = path.join(ADARIA_HOME, "logs");
export const MEMORY_DIR = path.join(ADARIA_HOME, "memory");
export const CONVERSATIONS_DIR = path.join(ADARIA_HOME, "conversations");
export const BRANDS_DIR = path.join(ADARIA_HOME, "brands");

/**
 * Allowed shape for service ids used as path components under
 * `$ADARIA_HOME/brands`. Must start with an alphanumeric, may contain
 * letters, digits, `.`, `_`, `-`, and is bounded to 64 chars. This is
 * a whitelist — NUL, newlines, unicode control chars, path separators,
 * leading dots (hidden dirs, `..`) are all rejected.
 */
const SERVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Path helper for brand profile storage (M6.7).
 *
 * With no argument: returns the root brands directory under
 * `$ADARIA_HOME/brands`. With a `serviceId`: returns the per-service
 * directory that holds `brand.yaml` plus optional `logo.*` and
 * `design-system.*` image files.
 *
 * Rejects `serviceId` values that could escape the brands root (path
 * separators, `..`, absolute paths). The loader and generator always
 * resolve service paths through this helper so untrusted input (e.g.
 * a Slack user typing a service id) cannot traverse the filesystem.
 *
 * `ADARIA_HOME` is read at call time so tests can override it via env
 * without re-importing the module.
 */
export function brandsDir(serviceId?: string): string {
  const root =
    process.env["ADARIA_HOME"] !== undefined
      ? path.join(process.env["ADARIA_HOME"], "brands")
      : BRANDS_DIR;
  if (serviceId === undefined) {
    return root;
  }
  if (!SERVICE_ID_PATTERN.test(serviceId)) {
    throw new Error(`invalid serviceId: ${JSON.stringify(serviceId)}`);
  }
  return path.join(root, serviceId);
}
