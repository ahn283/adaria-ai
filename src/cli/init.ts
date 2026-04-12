/**
 * `adaria-ai init` — modular interactive setup wizard.
 *
 * Supports both full setup and individual section setup:
 *   adaria-ai init            — full guided setup (all sections)
 *   adaria-ai init slack      — Slack credentials only
 *   adaria-ai init collectors — data collector credentials only
 *   adaria-ai init social     — social media platform credentials only
 *
 * When re-running a section, the wizard merges with the existing config
 * instead of overwriting the entire file. Secrets are stored in the
 * macOS Keychain; YAML keeps the sentinel `***keychain***`.
 */
import inquirer from "inquirer";
import {
  configSchema,
  KEYCHAIN_KEYS,
  KEYCHAIN_SENTINEL,
  type AdariaConfig,
  type CollectorsConfig,
  type SocialConfig,
} from "../config/schema.js";
import { configExists, loadConfig, saveConfig } from "../config/store.js";
import { setSecret } from "../config/keychain.js";
import { APPS_PATH, CONFIG_PATH } from "../utils/paths.js";

export type InitSection = "slack" | "collectors" | "social";

const ALL_SECTIONS: InitSection[] = ["slack", "collectors", "social"];

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

interface SlackAnswers {
  botToken: string;
  appToken: string;
  signingSecret: string;
  allowedUser: string;
  briefingChannel: string;
}

async function askSlack(): Promise<SlackAnswers> {
  console.log("\n--- Slack ---");
  console.log("Get tokens from https://api.slack.com/apps > your app:");
  console.log("  Bot Token:      OAuth & Permissions > Bot User OAuth Token (xoxb-...)");
  console.log("  App Token:      Basic Information > App-Level Tokens > Generate (xapp-...)");
  console.log("  Signing Secret: Basic Information > App Credentials > Signing Secret");
  console.log("  User ID:        Slack > click your profile > '...' > Copy member ID\n");

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
      message: "Briefing channel for weekly reports (e.g. #growth):",
      default: "",
    },
  ]);
}

async function applySlack(
  config: Partial<AdariaConfig>,
): Promise<Partial<AdariaConfig>> {
  const slack = await askSlack();

  await setSecret(KEYCHAIN_KEYS.slackBotToken, slack.botToken);
  await setSecret(KEYCHAIN_KEYS.slackAppToken, slack.appToken);
  await setSecret(KEYCHAIN_KEYS.slackSigningSecret, slack.signingSecret);

  const agent = {
    showThinking: true,
    weeklyTimeoutMs: 900_000,
    ...(config.agent ?? {}),
  };
  if (slack.briefingChannel.trim().length > 0) {
    agent.briefingChannel = slack.briefingChannel.trim();
  }

  return {
    ...config,
    slack: {
      botToken: KEYCHAIN_SENTINEL,
      appToken: KEYCHAIN_SENTINEL,
      signingSecret: KEYCHAIN_SENTINEL,
    },
    security: {
      allowedUsers: [slack.allowedUser],
      dmOnly: false,
      auditLog: { enabled: true, maskSecrets: true },
      ...(config.security ?? {}),
    },
    agent,
  };
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

type CollectorsDraft = {
  appStore?: { keyId: string; issuerId: string; privateKey: typeof KEYCHAIN_SENTINEL };
  playStore?: { serviceAccountJson: typeof KEYCHAIN_SENTINEL };
  eodinSdk?: { apiKey: typeof KEYCHAIN_SENTINEL };
  eodinGrowth?: { token: typeof KEYCHAIN_SENTINEL };
  asoMobile?: { apiKey: typeof KEYCHAIN_SENTINEL };
  youtube?: { apiKey: typeof KEYCHAIN_SENTINEL };
  ardenTts?: { endpoint: string };
};

async function askEnable(label: string, hint: string): Promise<boolean> {
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

async function askAppStore(): Promise<CollectorsDraft["appStore"] | undefined> {
  if (!(await askEnable("App Store Connect", "iOS ASO + reviews"))) return undefined;
  const answers = await inquirer.prompt<{
    keyId: string;
    issuerId: string;
    privateKey: string;
  }>([
    { type: "input", name: "keyId", message: "Key ID:", validate: (v: string) => v.length > 0 || "Required" },
    { type: "input", name: "issuerId", message: "Issuer ID:", validate: (v: string) => v.length > 0 || "Required" },
    {
      type: "editor",
      name: "privateKey",
      message: "Private key (paste PKCS#8 PEM, editor will open):",
      validate: (v: string) => v.includes("BEGIN PRIVATE KEY") || "Expected PEM block",
    },
  ]);
  await setSecret(KEYCHAIN_KEYS.appStorePrivateKey, answers.privateKey);
  return { keyId: answers.keyId, issuerId: answers.issuerId, privateKey: KEYCHAIN_SENTINEL };
}

async function askPlayStore(): Promise<CollectorsDraft["playStore"] | undefined> {
  if (!(await askEnable("Google Play", "Android reviews + metadata"))) return undefined;
  const { serviceAccountJson } = await inquirer.prompt<{ serviceAccountJson: string }>([
    {
      type: "editor",
      name: "serviceAccountJson",
      message: "Service account JSON (paste full file, editor will open):",
      validate: (v: string) => {
        try {
          const p: unknown = JSON.parse(v);
          return typeof p === "object" && p !== null && "client_email" in p && "private_key" in p
            ? true : "JSON must include client_email and private_key";
        } catch { return "Must be valid JSON"; }
      },
    },
  ]);
  await setSecret(KEYCHAIN_KEYS.playStoreServiceAccount, serviceAccountJson);
  return { serviceAccountJson: KEYCHAIN_SENTINEL };
}

async function askSecret(label: string, keychainKey: string): Promise<typeof KEYCHAIN_SENTINEL | undefined> {
  if (!(await askEnable(label, ""))) return undefined;
  const { value } = await inquirer.prompt<{ value: string }>([
    { type: "password", name: "value", message: `${label} key/token:`, mask: "*", validate: (v: string) => v.length > 0 || "Required" },
  ]);
  await setSecret(keychainKey, value);
  return KEYCHAIN_SENTINEL;
}

async function askArdenTts(): Promise<CollectorsDraft["ardenTts"] | undefined> {
  if (!(await askEnable("Arden TTS", "voiceover for short-form scripts"))) return undefined;
  const { endpoint } = await inquirer.prompt<{ endpoint: string }>([
    {
      type: "input",
      name: "endpoint",
      message: "Arden TTS endpoint URL:",
      validate: (v: string) => {
        try {
          const p = new URL(v.trim());
          return p.protocol === "http:" || p.protocol === "https:" ? true : "Must use http(s)";
        } catch { return "Must be a valid URL"; }
      },
    },
  ]);
  return { endpoint: endpoint.trim() };
}

async function applyCollectors(
  config: Partial<AdariaConfig>,
): Promise<Partial<AdariaConfig>> {
  console.log("\n--- Data Collectors ---");
  console.log("Each collector is optional. Skip any you don't use yet.");
  console.log("You can add them later with `adaria-ai init collectors`.\n");
  console.log("Where to get each key:");
  console.log("  App Store Connect:  https://appstoreconnect.apple.com > Users and Access > Keys");
  console.log("  Google Play:        https://console.cloud.google.com > Service Accounts > Create Key (JSON)");
  console.log("  Eodin SDK:          Your Eodin dashboard > Settings > API Keys");
  console.log("  Eodin Growth:       Same dashboard, GROWTH_AGENT_TOKEN");
  console.log("  ASOMobile:          https://asomobile.net > Settings > API");
  console.log("  YouTube:            https://console.cloud.google.com > APIs > YouTube Data API v3 > Create Credentials");
  console.log("  Arden TTS:          Your self-hosted Arden TTS endpoint URL\n");

  const existing = (config.collectors ?? {}) as CollectorsDraft;
  const draft: CollectorsDraft = { ...existing };

  const ap = await askAppStore();
  if (ap) draft.appStore = ap;
  const ps = await askPlayStore();
  if (ps) draft.playStore = ps;

  const es = await askSecret("Eodin SDK (installs/funnel/cohort)", KEYCHAIN_KEYS.eodinSdkApiKey);
  if (es) draft.eodinSdk = { apiKey: es };
  const eg = await askSecret("Eodin Growth (blog/SEO/GA4)", KEYCHAIN_KEYS.eodinGrowthToken);
  if (eg) draft.eodinGrowth = { token: eg };
  const am = await askSecret("ASOMobile (keyword rankings)", KEYCHAIN_KEYS.asoMobileApiKey);
  if (am) draft.asoMobile = { apiKey: am };
  const yt = await askSecret("YouTube Data API", KEYCHAIN_KEYS.youtubeApiKey);
  if (yt) draft.youtube = { apiKey: yt };

  const at = await askArdenTts();
  if (at) draft.ardenTts = at;

  return { ...config, collectors: draft as CollectorsConfig };
}

// ---------------------------------------------------------------------------
// Social Platforms
// ---------------------------------------------------------------------------

type SocialDraft = {
  twitter?: { apiKey: typeof KEYCHAIN_SENTINEL; apiSecret: typeof KEYCHAIN_SENTINEL; accessToken: typeof KEYCHAIN_SENTINEL; accessTokenSecret: typeof KEYCHAIN_SENTINEL };
  facebook?: { appId: string; appSecret: typeof KEYCHAIN_SENTINEL; accessToken: typeof KEYCHAIN_SENTINEL; pageId: string };
  threads?: { accessToken: typeof KEYCHAIN_SENTINEL; userId: string };
  tiktok?: { clientKey: string; clientSecret: typeof KEYCHAIN_SENTINEL; accessToken: typeof KEYCHAIN_SENTINEL };
  youtube?: { accessToken: typeof KEYCHAIN_SENTINEL; channelId: string };
  linkedin?: { accessToken: typeof KEYCHAIN_SENTINEL; organizationId: string };
};

async function askTwitter(): Promise<SocialDraft["twitter"] | undefined> {
  if (!(await askEnable("Twitter/X", "tweet marketing content"))) return undefined;
  const answers = await inquirer.prompt<{ apiKey: string; apiSecret: string; accessToken: string; accessTokenSecret: string }>([
    { type: "password", name: "apiKey", message: "API Key:", mask: "*", validate: (v: string) => v.length > 0 || "Required" },
    { type: "password", name: "apiSecret", message: "API Secret:", mask: "*", validate: (v: string) => v.length > 0 || "Required" },
    { type: "password", name: "accessToken", message: "Access Token:", mask: "*", validate: (v: string) => v.length > 0 || "Required" },
    { type: "password", name: "accessTokenSecret", message: "Access Token Secret:", mask: "*", validate: (v: string) => v.length > 0 || "Required" },
  ]);
  await setSecret(KEYCHAIN_KEYS.twitterApiKey, answers.apiKey);
  await setSecret(KEYCHAIN_KEYS.twitterApiSecret, answers.apiSecret);
  await setSecret(KEYCHAIN_KEYS.twitterAccessToken, answers.accessToken);
  await setSecret(KEYCHAIN_KEYS.twitterAccessTokenSecret, answers.accessTokenSecret);
  return { apiKey: KEYCHAIN_SENTINEL, apiSecret: KEYCHAIN_SENTINEL, accessToken: KEYCHAIN_SENTINEL, accessTokenSecret: KEYCHAIN_SENTINEL };
}

async function askFacebook(): Promise<SocialDraft["facebook"] | undefined> {
  if (!(await askEnable("Facebook", "page posts"))) return undefined;
  const answers = await inquirer.prompt<{ appId: string; appSecret: string; accessToken: string; pageId: string }>([
    { type: "input", name: "appId", message: "App ID:", validate: (v: string) => v.length > 0 || "Required" },
    { type: "password", name: "appSecret", message: "App Secret:", mask: "*", validate: (v: string) => v.length > 0 || "Required" },
    { type: "password", name: "accessToken", message: "User Access Token:", mask: "*", validate: (v: string) => v.length > 0 || "Required" },
    { type: "input", name: "pageId", message: "Page ID:", validate: (v: string) => v.length > 0 || "Required" },
  ]);
  await setSecret(KEYCHAIN_KEYS.facebookAppSecret, answers.appSecret);
  await setSecret(KEYCHAIN_KEYS.facebookAccessToken, answers.accessToken);
  return { appId: answers.appId, appSecret: KEYCHAIN_SENTINEL, accessToken: KEYCHAIN_SENTINEL, pageId: answers.pageId };
}

async function askThreads(): Promise<SocialDraft["threads"] | undefined> {
  if (!(await askEnable("Threads", "Meta Threads posts"))) return undefined;
  const answers = await inquirer.prompt<{ accessToken: string; userId: string }>([
    { type: "password", name: "accessToken", message: "Access Token:", mask: "*", validate: (v: string) => v.length > 0 || "Required" },
    { type: "input", name: "userId", message: "User ID:", validate: (v: string) => v.length > 0 || "Required" },
  ]);
  await setSecret(KEYCHAIN_KEYS.threadsAccessToken, answers.accessToken);
  return { accessToken: KEYCHAIN_SENTINEL, userId: answers.userId };
}

async function askTikTok(): Promise<SocialDraft["tiktok"] | undefined> {
  if (!(await askEnable("TikTok", "content posting (requires app review)"))) return undefined;
  const answers = await inquirer.prompt<{ clientKey: string; clientSecret: string; accessToken: string }>([
    { type: "input", name: "clientKey", message: "Client Key:", validate: (v: string) => v.length > 0 || "Required" },
    { type: "password", name: "clientSecret", message: "Client Secret:", mask: "*", validate: (v: string) => v.length > 0 || "Required" },
    { type: "password", name: "accessToken", message: "Access Token:", mask: "*", validate: (v: string) => v.length > 0 || "Required" },
  ]);
  await setSecret(KEYCHAIN_KEYS.tiktokClientSecret, answers.clientSecret);
  await setSecret(KEYCHAIN_KEYS.tiktokAccessToken, answers.accessToken);
  return { clientKey: answers.clientKey, clientSecret: KEYCHAIN_SENTINEL, accessToken: KEYCHAIN_SENTINEL };
}

async function askYouTubeSocial(): Promise<SocialDraft["youtube"] | undefined> {
  if (!(await askEnable("YouTube Community", "community posts"))) return undefined;
  const answers = await inquirer.prompt<{ accessToken: string; channelId: string }>([
    { type: "password", name: "accessToken", message: "OAuth Access Token:", mask: "*", validate: (v: string) => v.length > 0 || "Required" },
    { type: "input", name: "channelId", message: "Channel ID (UC…):", validate: (v: string) => v.length > 0 || "Required" },
  ]);
  await setSecret(KEYCHAIN_KEYS.youtubeAccessToken, answers.accessToken);
  return { accessToken: KEYCHAIN_SENTINEL, channelId: answers.channelId };
}

async function askLinkedIn(): Promise<SocialDraft["linkedin"] | undefined> {
  if (!(await askEnable("LinkedIn", "organization page posts"))) return undefined;
  const answers = await inquirer.prompt<{ accessToken: string; organizationId: string }>([
    { type: "password", name: "accessToken", message: "Access Token:", mask: "*", validate: (v: string) => v.length > 0 || "Required" },
    { type: "input", name: "organizationId", message: "Organization ID:", validate: (v: string) => v.length > 0 || "Required" },
  ]);
  await setSecret(KEYCHAIN_KEYS.linkedinAccessToken, answers.accessToken);
  return { accessToken: KEYCHAIN_SENTINEL, organizationId: answers.organizationId };
}

async function applySocial(
  config: Partial<AdariaConfig>,
): Promise<Partial<AdariaConfig>> {
  console.log("\n--- Social Media Platforms ---");
  console.log("Configure platforms for automated marketing posts.");
  console.log("You can add them later with `adaria-ai init social`.\n");
  console.log("Where to get each key:");
  console.log("  Twitter/X:   https://developer.twitter.com > Dashboard > Keys and Tokens");
  console.log("               Need: API Key, API Secret, Access Token, Access Token Secret");
  console.log("  Facebook:    https://developers.facebook.com > My Apps > App Dashboard");
  console.log("               Need: App ID, App Secret, Page Access Token, Page ID");
  console.log("  Threads:     https://developers.facebook.com > Threads API > Access Token");
  console.log("  TikTok:      https://developers.tiktok.com > Manage Apps > Client Key/Secret");
  console.log("               Note: Content Posting API requires app review approval");
  console.log("  YouTube:     https://console.cloud.google.com > OAuth 2.0 > Access Token");
  console.log("  LinkedIn:    https://developer.linkedin.com > My Apps > Auth > Access Token\n");

  const existing = (config.social ?? {}) as SocialDraft;
  const draft: SocialDraft = { ...existing };

  const tw = await askTwitter();
  if (tw) draft.twitter = tw;
  const fb = await askFacebook();
  if (fb) draft.facebook = fb;
  const th = await askThreads();
  if (th) draft.threads = th;
  const tk = await askTikTok();
  if (tk) draft.tiktok = tk;
  const yt = await askYouTubeSocial();
  if (yt) draft.youtube = yt;
  const li = await askLinkedIn();
  if (li) draft.linkedin = li;

  return { ...config, social: draft as SocialConfig };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary(config: AdariaConfig): void {
  console.log("\n========================================");
  console.log("           Setup Summary");
  console.log("========================================\n");

  // Slack
  const slackOk = config.slack.botToken === KEYCHAIN_SENTINEL;
  console.log(`Slack:       ${slackOk ? "\u2705 configured" : "\u274c missing"}`);
  console.log(`  Channel:   ${config.agent.briefingChannel ?? "(not set)"}`);
  console.log(`  Allowlist: ${String(config.security.allowedUsers.length)} user(s)`);

  // Collectors
  const c = config.collectors;
  console.log("\nData Collectors:");
  console.log(`  App Store Connect:  ${c.appStore ? "\u2705" : "\u2013"}`);
  console.log(`  Google Play:        ${c.playStore ? "\u2705" : "\u2013"}`);
  console.log(`  ASOMobile:          ${c.asoMobile ? "\u2705" : "\u2013"}`);
  console.log(`  Eodin SDK:          ${c.eodinSdk ? "\u2705" : "\u2013"}`);
  console.log(`  Eodin Growth:       ${c.eodinGrowth ? "\u2705" : "\u2013"}`);
  console.log(`  YouTube:            ${c.youtube ? "\u2705" : "\u2013"}`);
  console.log(`  Arden TTS:          ${c.ardenTts ? "\u2705" : "\u2013"}`);

  // Social
  const s = config.social;
  console.log("\nSocial Platforms:");
  console.log(`  Twitter/X:          ${s.twitter ? "\u2705" : "\u2013"}`);
  console.log(`  Facebook:           ${s.facebook ? "\u2705" : "\u2013"}`);
  console.log(`  Threads:            ${s.threads ? "\u2705" : "\u2013"}`);
  console.log(`  TikTok:             ${s.tiktok ? "\u2705" : "\u2013"}`);
  console.log(`  YouTube Community:  ${s.youtube ? "\u2705" : "\u2013"}`);
  console.log(`  LinkedIn:           ${s.linkedin ? "\u2705" : "\u2013"}`);

  console.log("\n========================================\n");
}

function printNextSteps(): void {
  console.log("Next steps:");
  console.log(`  1. Edit ${APPS_PATH} with your app portfolio`);
  console.log("     (copy apps.example.yaml from the repo root as a starting point)");
  console.log("  2. adaria-ai doctor        # verify all credentials");
  console.log("  3. adaria-ai start         # load daemon + cron plists");
  console.log("");
  console.log("To add or update a specific section later:");
  console.log("  adaria-ai init slack       # Slack credentials");
  console.log("  adaria-ai init collectors  # data collector API keys");
  console.log("  adaria-ai init social      # social media platforms");
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runInit(section?: InitSection): Promise<void> {
  const sections = section ? [section] : ALL_SECTIONS;

  if (!section) {
    console.log("adaria-ai init \u2014 interactive setup\n");
  } else {
    console.log(`adaria-ai init ${section}\n`);
  }

  // Load existing config if available (for merge), otherwise start fresh
  let config: Partial<AdariaConfig> = {};
  if (await configExists()) {
    try {
      config = await loadConfig() as Partial<AdariaConfig>;
      if (!section) {
        console.log(`Existing config at ${CONFIG_PATH} will be merged.\n`);
      }
    } catch {
      console.log(`Existing config at ${CONFIG_PATH} could not be parsed. Starting fresh.\n`);
    }
  } else {
    if (!section) {
      console.log(`Config will be written to ${CONFIG_PATH}.\n`);
    }
  }

  // Apply requested sections
  for (const s of sections) {
    switch (s) {
      case "slack":
        config = await applySlack(config);
        break;
      case "collectors":
        config = await applyCollectors(config);
        break;
      case "social":
        config = await applySocial(config);
        break;
    }
  }

  // Ensure required defaults exist
  if (!config.claude) {
    config.claude = { mode: "cli" as const, cliBinary: "claude", apiKey: null, timeoutMs: 120_000 };
  }
  if (!config.safety) {
    config.safety = { dangerousActionsRequireApproval: true, approvalTimeoutMinutes: 30 };
  }
  if (!config.agent) {
    config.agent = { showThinking: true, weeklyTimeoutMs: 900_000 };
  }

  // Validate and save
  const validated = configSchema.parse(config);
  await saveConfig(validated);

  console.log(`\nConfig written to ${CONFIG_PATH}`);
  console.log("Secrets stored in macOS Keychain.");

  printSummary(validated);
  printNextSteps();
}
