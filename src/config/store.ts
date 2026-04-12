import fs from "node:fs/promises";
import yaml from "js-yaml";
import {
  configSchema,
  KEYCHAIN_KEYS,
  KEYCHAIN_SENTINEL,
  type AdariaConfig,
} from "./schema.js";
import { getSecret } from "./keychain.js";
import {
  ADARIA_HOME,
  CONFIG_PATH,
  CONVERSATIONS_DIR,
  DATA_DIR,
  LOGS_DIR,
  MEMORY_DIR,
} from "../utils/paths.js";
import { ConfigError } from "../utils/errors.js";

const ADARIA_SUBDIRS = [LOGS_DIR, DATA_DIR, MEMORY_DIR, CONVERSATIONS_DIR];

/**
 * Create $ADARIA_HOME and all required subdirectories and force 0700 perms.
 *
 * The explicit `fs.chmod` calls are load-bearing: `fs.mkdir({ mode })` silently
 * ignores the mode argument on pre-existing directories, so if the user ever
 * created `~/.adaria` by hand or via a prior tool at 0755, we need to tighten
 * it on every daemon startup. Same pattern applies to `saveConfig` below.
 */
export async function ensureAdariaDir(): Promise<void> {
  await fs.mkdir(ADARIA_HOME, { recursive: true, mode: 0o700 });
  await fs.chmod(ADARIA_HOME, 0o700);
  for (const sub of ADARIA_SUBDIRS) {
    await fs.mkdir(sub, { recursive: true, mode: 0o700 });
    await fs.chmod(sub, 0o700);
  }
}

/**
 * Load and validate the config from $ADARIA_HOME/config.yaml.
 * Throws ConfigError if the file is missing or invalid.
 * Secrets flagged with KEYCHAIN_SENTINEL are resolved from the macOS Keychain.
 *
 * TODO(M6): cache resolved config for daemon hot path — cron shots currently
 * fork the `security` CLI up to 4× per loadConfig() call. Fine during M1
 * startup, but M6 weekly/monitor cron will benefit from in-memory caching
 * with SIGHUP invalidation.
 */
export async function loadConfig(): Promise<AdariaConfig> {
  await ensureAdariaDir();

  let raw: unknown;
  try {
    const content = await fs.readFile(CONFIG_PATH, "utf-8");
    raw = yaml.load(content, { schema: yaml.JSON_SCHEMA });
  } catch (cause) {
    throw new ConfigError(
      `Configuration file not found at ${CONFIG_PATH}`,
      {
        cause,
        userMessage:
          'Configuration file not found. Run "adaria-ai init" to create it.',
      }
    );
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid configuration:\n${issues}`, {
      userMessage: `Configuration file at ${CONFIG_PATH} is invalid. See details below and run "adaria-ai init" to regenerate.`,
    });
  }

  return resolveKeychainSecrets(result.data);
}

async function resolveSecretField(slot: string): Promise<string> {
  return (await getSecret(slot)) ?? "";
}

async function resolveKeychainSecrets(
  config: AdariaConfig
): Promise<AdariaConfig> {
  const resolved = structuredClone(config);

  if (resolved.slack.botToken === KEYCHAIN_SENTINEL) {
    resolved.slack.botToken = await resolveSecretField(
      KEYCHAIN_KEYS.slackBotToken
    );
  }
  if (resolved.slack.appToken === KEYCHAIN_SENTINEL) {
    resolved.slack.appToken = await resolveSecretField(
      KEYCHAIN_KEYS.slackAppToken
    );
  }
  if (resolved.slack.signingSecret === KEYCHAIN_SENTINEL) {
    resolved.slack.signingSecret = await resolveSecretField(
      KEYCHAIN_KEYS.slackSigningSecret
    );
  }

  if (resolved.claude.apiKey === KEYCHAIN_SENTINEL) {
    resolved.claude.apiKey =
      (await getSecret(KEYCHAIN_KEYS.anthropicApiKey)) ?? null;
  }

  // Collector secrets. Each block is optional — skip resolution if the
  // user hasn't configured that collector.
  const collectors = resolved.collectors;
  if (collectors.appStore?.privateKey === KEYCHAIN_SENTINEL) {
    collectors.appStore.privateKey = await resolveSecretField(
      KEYCHAIN_KEYS.appStorePrivateKey
    );
  }
  if (collectors.playStore?.serviceAccountJson === KEYCHAIN_SENTINEL) {
    collectors.playStore.serviceAccountJson = await resolveSecretField(
      KEYCHAIN_KEYS.playStoreServiceAccount
    );
  }
  if (collectors.eodinSdk?.apiKey === KEYCHAIN_SENTINEL) {
    collectors.eodinSdk.apiKey = await resolveSecretField(
      KEYCHAIN_KEYS.eodinSdkApiKey
    );
  }
  if (collectors.eodinGrowth?.token === KEYCHAIN_SENTINEL) {
    collectors.eodinGrowth.token = await resolveSecretField(
      KEYCHAIN_KEYS.eodinGrowthToken
    );
  }
  if (collectors.asoMobile?.apiKey === KEYCHAIN_SENTINEL) {
    collectors.asoMobile.apiKey = await resolveSecretField(
      KEYCHAIN_KEYS.asoMobileApiKey
    );
  }
  if (collectors.youtube?.apiKey === KEYCHAIN_SENTINEL) {
    collectors.youtube.apiKey = await resolveSecretField(
      KEYCHAIN_KEYS.youtubeApiKey
    );
  }

  return resolved;
}

/**
 * Read the YAML file as-is without schema validation or keychain resolution.
 * Used by `adaria-ai init` when updating an existing config.
 */
export async function loadRawConfig(): Promise<Record<string, unknown>> {
  await ensureAdariaDir();

  let content: string;
  try {
    content = await fs.readFile(CONFIG_PATH, "utf-8");
  } catch (cause) {
    throw new ConfigError(
      `Configuration file not found at ${CONFIG_PATH}`,
      {
        cause,
        userMessage:
          'Configuration file not found. Run "adaria-ai init" to create it.',
      }
    );
  }

  const parsed = yaml.load(content, { schema: yaml.JSON_SCHEMA });
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(
      `Configuration file at ${CONFIG_PATH} is not an object`
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Write a (possibly partial) config object to disk as YAML with 0600 perms.
 *
 * The explicit `fs.chmod` is load-bearing: `fs.writeFile({ mode })` only applies
 * the mode when creating a new file. Without the chmod, a config accidentally
 * written with a loose umask (e.g. 0022 → 0644) would stay loose across
 * subsequent saves. Callers are responsible for writing a structure that will
 * pass schema validation on the next load.
 */
export async function saveConfig(
  config: Partial<AdariaConfig> | Record<string, unknown>
): Promise<void> {
  await ensureAdariaDir();
  const content = yaml.dump(config, { indent: 2, lineWidth: 100 });
  await fs.writeFile(CONFIG_PATH, content, { mode: 0o600 });
  await fs.chmod(CONFIG_PATH, 0o600);
}

export async function configExists(): Promise<boolean> {
  try {
    await fs.access(CONFIG_PATH);
    return true;
  } catch {
    return false;
  }
}
