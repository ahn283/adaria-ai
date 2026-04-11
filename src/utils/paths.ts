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
