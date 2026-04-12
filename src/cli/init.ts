/**
 * `adaria-ai init` — interactive setup wizard.
 *
 * Collects every credential the daemon needs:
 *   - Slack bot token, app token, signing secret
 *   - At least one allowlisted Slack user ID
 *   - Optional briefing channel (M6 weekly orchestrator target)
 *   - Optional per-collector credentials (App Store Connect, Google
 *     Play, Eodin SDK, Eodin Growth/Blog, ASOMobile, YouTube, Arden TTS)
 *
 * Every secret is stored in the macOS Keychain by default; the YAML
 * file keeps the sentinel `***keychain***` in the corresponding field.
 * Users who want to pin a secret inline can re-edit
 * `~/.adaria/config.yaml` afterwards.
 *
 * Per-app identifiers (App Store numeric id, Play package name, etc.)
 * live in `apps.yaml`, not here — see `apps.example.yaml` at the repo
 * root. Collector secrets are global; apps are the iteration axis.
 */
import inquirer from "inquirer";
import {
  configSchema,
  KEYCHAIN_KEYS,
  KEYCHAIN_SENTINEL,
  type AdariaConfig,
  type CollectorsConfig,
} from "../config/schema.js";
import { configExists, saveConfig } from "../config/store.js";
import { setSecret } from "../config/keychain.js";
import { APPS_PATH, CONFIG_PATH } from "../utils/paths.js";

interface SlackAnswers {
  botToken: string;
  appToken: string;
  signingSecret: string;
  allowedUser: string;
  briefingChannel: string;
}

/**
 * Schema-shape of the collectors section we'll hand to `configSchema`.
 * Every secret field gets written as the keychain sentinel.
 */
type CollectorsDraft = {
  appStore?: {
    keyId: string;
    issuerId: string;
    privateKey: typeof KEYCHAIN_SENTINEL;
  };
  playStore?: {
    serviceAccountJson: typeof KEYCHAIN_SENTINEL;
  };
  eodinSdk?: {
    apiKey: typeof KEYCHAIN_SENTINEL;
  };
  eodinGrowth?: {
    token: typeof KEYCHAIN_SENTINEL;
  };
  asoMobile?: {
    apiKey: typeof KEYCHAIN_SENTINEL;
  };
  youtube?: {
    apiKey: typeof KEYCHAIN_SENTINEL;
  };
  ardenTts?: {
    endpoint: string;
  };
};

async function askSlack(): Promise<SlackAnswers> {
  return inquirer.prompt<SlackAnswers>([
    {
      type: "password",
      name: "botToken",
      message: "Slack bot token (xoxb-…):",
      mask: "*",
      validate: (v: string) =>
        v.startsWith("xoxb-") || "Slack bot tokens start with 'xoxb-'",
    },
    {
      type: "password",
      name: "appToken",
      message: "Slack app token (xapp-…):",
      mask: "*",
      validate: (v: string) =>
        v.startsWith("xapp-") || "Slack app tokens start with 'xapp-'",
    },
    {
      type: "password",
      name: "signingSecret",
      message: "Slack signing secret:",
      mask: "*",
      validate: (v: string) =>
        v.length > 0 || "Signing secret cannot be empty",
    },
    {
      type: "input",
      name: "allowedUser",
      message: "Allowlisted Slack user ID (U…):",
      validate: (v: string) =>
        /^U[A-Z0-9]+$/.test(v) ||
        "Slack user IDs start with 'U' and contain uppercase letters and digits",
    },
    {
      type: "input",
      name: "briefingChannel",
      message:
        "Default briefing channel (leave blank; M6 weekly orchestrator uses this):",
      default: "",
    },
  ]);
}

async function askEnable(
  label: string,
  hint: string
): Promise<boolean> {
  const { enable } = await inquirer.prompt<{ enable: boolean }>([
    {
      type: "confirm",
      name: "enable",
      message: `Configure ${label}? (${hint})`,
      default: false,
    },
  ]);
  return enable;
}

async function askAppStore(): Promise<CollectorsDraft["appStore"] | null> {
  if (!(await askEnable("App Store Connect", "iOS ASO + reviews"))) return null;

  const answers = await inquirer.prompt<{
    keyId: string;
    issuerId: string;
    privateKey: string;
  }>([
    {
      type: "input",
      name: "keyId",
      message: "Key ID:",
      validate: (v: string) => v.length > 0 || "Key ID is required",
    },
    {
      type: "input",
      name: "issuerId",
      message: "Issuer ID:",
      validate: (v: string) => v.length > 0 || "Issuer ID is required",
    },
    {
      type: "editor",
      name: "privateKey",
      message:
        "Private key (paste PKCS#8 PEM, editor will open):",
      validate: (v: string) =>
        v.includes("BEGIN PRIVATE KEY") ||
        "Expected a PEM block starting with '-----BEGIN PRIVATE KEY-----'",
    },
  ]);

  await setSecret(KEYCHAIN_KEYS.appStorePrivateKey, answers.privateKey);

  return {
    keyId: answers.keyId,
    issuerId: answers.issuerId,
    privateKey: KEYCHAIN_SENTINEL,
  };
}

async function askPlayStore(): Promise<CollectorsDraft["playStore"] | null> {
  if (!(await askEnable("Google Play", "Android reviews + metadata"))) {
    return null;
  }

  const { serviceAccountJson } = await inquirer.prompt<{
    serviceAccountJson: string;
  }>([
    {
      type: "editor",
      name: "serviceAccountJson",
      message:
        "Service account JSON (paste the full file contents, editor will open):",
      validate: (v: string) => {
        try {
          const parsed: unknown = JSON.parse(v);
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            "client_email" in parsed &&
            "private_key" in parsed
          ) {
            return true;
          }
          return "JSON must include client_email and private_key";
        } catch {
          return "Must be valid JSON";
        }
      },
    },
  ]);

  await setSecret(KEYCHAIN_KEYS.playStoreServiceAccount, serviceAccountJson);

  return { serviceAccountJson: KEYCHAIN_SENTINEL };
}

async function askEodinSdk(): Promise<CollectorsDraft["eodinSdk"] | null> {
  if (!(await askEnable("Eodin SDK analytics", "installs / funnel / cohort"))) {
    return null;
  }
  const { apiKey } = await inquirer.prompt<{ apiKey: string }>([
    {
      type: "password",
      name: "apiKey",
      message: "Eodin SDK API key:",
      mask: "*",
      validate: (v: string) => v.length > 0 || "API key is required",
    },
  ]);
  await setSecret(KEYCHAIN_KEYS.eodinSdkApiKey, apiKey);
  return { apiKey: KEYCHAIN_SENTINEL };
}

async function askEodinGrowth(): Promise<
  CollectorsDraft["eodinGrowth"] | null
> {
  if (!(await askEnable("Eodin Growth (blog/SEO/GA4)", "GROWTH_AGENT_TOKEN"))) {
    return null;
  }
  const { token } = await inquirer.prompt<{ token: string }>([
    {
      type: "password",
      name: "token",
      message: "GROWTH_AGENT_TOKEN:",
      mask: "*",
      validate: (v: string) => v.length > 0 || "Token is required",
    },
  ]);
  await setSecret(KEYCHAIN_KEYS.eodinGrowthToken, token);
  return { token: KEYCHAIN_SENTINEL };
}

async function askAsoMobile(): Promise<CollectorsDraft["asoMobile"] | null> {
  if (!(await askEnable("ASOMobile", "keyword rankings"))) return null;
  const { apiKey } = await inquirer.prompt<{ apiKey: string }>([
    {
      type: "password",
      name: "apiKey",
      message: "ASOMobile API key:",
      mask: "*",
      validate: (v: string) => v.length > 0 || "API key is required",
    },
  ]);
  await setSecret(KEYCHAIN_KEYS.asoMobileApiKey, apiKey);
  return { apiKey: KEYCHAIN_SENTINEL };
}

async function askYoutube(): Promise<CollectorsDraft["youtube"] | null> {
  if (!(await askEnable("YouTube Data API", "Shorts performance"))) return null;
  const { apiKey } = await inquirer.prompt<{ apiKey: string }>([
    {
      type: "password",
      name: "apiKey",
      message: "YouTube Data API key:",
      mask: "*",
      validate: (v: string) => v.length > 0 || "API key is required",
    },
  ]);
  await setSecret(KEYCHAIN_KEYS.youtubeApiKey, apiKey);
  return { apiKey: KEYCHAIN_SENTINEL };
}

async function askArdenTts(): Promise<CollectorsDraft["ardenTts"] | null> {
  if (!(await askEnable("Arden TTS", "voiceover for short-form scripts"))) {
    return null;
  }
  const { endpoint } = await inquirer.prompt<{ endpoint: string }>([
    {
      type: "input",
      name: "endpoint",
      message: "Arden TTS endpoint URL (e.g. https://arden-tts.eodin.app):",
      validate: (v: string) => {
        try {
          const parsed = new URL(v.trim());
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return "Endpoint must use http(s)";
          }
          return true;
        } catch {
          return "Must be a valid URL";
        }
      },
    },
  ]);
  return { endpoint: endpoint.trim() };
}

async function askCollectors(): Promise<CollectorsDraft> {
  console.log(
    "\nCollector credentials — each block is optional. Press Enter to\n" +
      "skip any you don't use yet; you can re-run `adaria-ai init` later.\n"
  );

  const draft: CollectorsDraft = {};
  const ap = await askAppStore();
  if (ap) draft.appStore = ap;
  const ps = await askPlayStore();
  if (ps) draft.playStore = ps;
  const es = await askEodinSdk();
  if (es) draft.eodinSdk = es;
  const eg = await askEodinGrowth();
  if (eg) draft.eodinGrowth = eg;
  const am = await askAsoMobile();
  if (am) draft.asoMobile = am;
  const yt = await askYoutube();
  if (yt) draft.youtube = yt;
  const at = await askArdenTts();
  if (at) draft.ardenTts = at;
  return draft;
}

export async function runInit(): Promise<void> {
  console.log("adaria-ai init — interactive setup\n");

  if (await configExists()) {
    // Deliberately do NOT try to parse the existing YAML — users run
    // `init` precisely when their config is broken, and `loadRawConfig()`
    // would throw on malformed content, trapping them in a state they
    // can't escape from within the tool (M1 CLI review HIGH #2). The
    // wizard overwrites the file unconditionally.
    console.log(
      `Existing config at ${CONFIG_PATH} will be overwritten.\n`
    );
  } else {
    console.log(`Config will be written to ${CONFIG_PATH}.\n`);
  }

  const slack = await askSlack();
  const collectors = await askCollectors();

  // Stash Slack secrets in the Keychain.
  await setSecret(KEYCHAIN_KEYS.slackBotToken, slack.botToken);
  await setSecret(KEYCHAIN_KEYS.slackAppToken, slack.appToken);
  await setSecret(KEYCHAIN_KEYS.slackSigningSecret, slack.signingSecret);

  const agent: AdariaConfig["agent"] = { showThinking: true };
  if (slack.briefingChannel.trim().length > 0) {
    agent.briefingChannel = slack.briefingChannel.trim();
  }

  // Construct and validate via the schema before writing.
  const candidate: AdariaConfig = configSchema.parse({
    slack: {
      botToken: KEYCHAIN_SENTINEL,
      appToken: KEYCHAIN_SENTINEL,
      signingSecret: KEYCHAIN_SENTINEL,
    },
    claude: {
      mode: "cli",
      cliBinary: "claude",
      apiKey: null,
      timeoutMs: 120_000,
    },
    security: {
      allowedUsers: [slack.allowedUser],
      dmOnly: false,
      auditLog: { enabled: true, maskSecrets: true },
    },
    safety: {
      dangerousActionsRequireApproval: true,
      approvalTimeoutMinutes: 30,
    },
    agent,
    collectors: collectors as CollectorsConfig,
  });

  await saveConfig(candidate);

  console.log("\nConfig written to", CONFIG_PATH);
  console.log("Secrets stored in the macOS Keychain (service: adaria-ai).");
  console.log(
    "\nNext: copy `apps.example.yaml` from the repo root to\n" +
      `${APPS_PATH} and edit it with your app portfolio.`
  );
  console.log("\nNext steps:");
  console.log(
    "  adaria-ai doctor         # verify Slack + Claude CLI are reachable"
  );
  console.log(
    "  npm run smoke:collectors # exercise each configured collector"
  );
  console.log(
    "  adaria-ai start          # load the reactive daemon into launchd"
  );
}
