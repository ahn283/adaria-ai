import fs from "node:fs/promises";
import yaml from "js-yaml";

import { APPS_PATH } from "../utils/paths.js";
import { ConfigError } from "../utils/errors.js";
import {
  appsFileSchema,
  type AppConfig,
  type AppsFile,
} from "./apps-schema.js";

export interface LoadAppsOptions {
  /** Include `active: false` apps in the result. Default false. */
  includeInactive?: boolean;
  /** Override path for tests or one-off runs. */
  path?: string;
}

/**
 * Load and validate `apps.yaml`. Returns only active apps unless
 * `includeInactive` is set. Missing file or schema mismatch throws
 * `ConfigError` with a user-friendly hint.
 */
export async function loadApps(
  options: LoadAppsOptions = {}
): Promise<AppsFile & { apps: AppConfig[] }> {
  const filePath = options.path ?? APPS_PATH;

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (cause) {
    throw new ConfigError(`Apps config file not found at ${filePath}`, {
      cause,
      userMessage: `apps.yaml not found at ${filePath}. Copy \`apps.example.yaml\` from the repo root and edit it, or re-run \`adaria-ai init\`.`,
    });
  }

  const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  const result = appsFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid apps.yaml:\n${issues}`, {
      userMessage: `apps.yaml at ${filePath} is invalid. See details below.`,
    });
  }

  const filtered = options.includeInactive
    ? result.data.apps
    : result.data.apps.filter((app) => app.active);

  return { apps: filtered };
}
