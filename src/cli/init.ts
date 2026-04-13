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
import { configExists, loadRawConfig, saveConfig } from "../config/store.js";
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
      ...(config.security ?? {}),
      allowedUsers: [
        ...new Set([
          slack.allowedUser,
          ...((config.security as Record<string, unknown> | undefined)?.["allowedUsers"] as string[] ?? []),
        ]),
      ],
      dmOnly: false,
      auditLog: { enabled: true, maskSecrets: true },
    },
    agent,
  };
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

type CollectorsDraft = {
  appStore?: { keyId: string; issuerId: string; privateKey: typeof KEYCHAIN_SENTINEL } | undefined;
  playStore?: { serviceAccountJson: typeof KEYCHAIN_SENTINEL } | undefined;
  eodinSdk?: { apiKey: typeof KEYCHAIN_SENTINEL } | undefined;
  eodinGrowth?: { token: typeof KEYCHAIN_SENTINEL } | undefined;
  fridgify?: { baseUrl: string } | undefined;
  asoMobile?: { apiKey: typeof KEYCHAIN_SENTINEL } | undefined;
  youtube?: { apiKey: typeof KEYCHAIN_SENTINEL } | undefined;
  ardenTts?: { endpoint: string } | undefined;
};

async function askAppStore(): Promise<CollectorsDraft["appStore"] | undefined> {
  console.log("\n  How to get App Store Connect API keys:");
  console.log("  1. Go to https://appstoreconnect.apple.com/access/integrations/api");
  console.log("  2. Click '+' to generate a new key (Admin role recommended)");
  console.log("  3. Copy the Key ID (10-char alphanumeric, shown in the table)");
  console.log("  4. Copy the Issuer ID (UUID, shown at the top of the page)");
  console.log("  5. Download the .p8 private key file (only available once!)\n");

  const answers = await inquirer.prompt<{
    keyId: string;
    issuerId: string;
    privateKey: string;
  }>([
    { type: "input", name: "keyId", message: "Key ID (e.g. ABC1234DEF):", validate: (v: string) => v.length > 0 || "Required" },
    { type: "input", name: "issuerId", message: "Issuer ID (UUID):", validate: (v: string) => v.length > 0 || "Required" },
    {
      type: "editor",
      name: "privateKey",
      message: "Private key (paste .p8 file contents, editor will open):",
      validate: (v: string) => v.includes("BEGIN PRIVATE KEY") || "Expected PEM block (-----BEGIN PRIVATE KEY-----)",
    },
  ]);
  await setSecret(KEYCHAIN_KEYS.appStorePrivateKey, answers.privateKey);
  return { keyId: answers.keyId, issuerId: answers.issuerId, privateKey: KEYCHAIN_SENTINEL };
}

async function askPlayStore(): Promise<CollectorsDraft["playStore"] | undefined> {
  console.log("\n  How to get Google Play service account:");
  console.log("  1. Go to https://console.cloud.google.com > IAM & Admin > Service Accounts");
  console.log("  2. Create a service account (or use an existing one)");
  console.log("  3. Click the account > Keys tab > Add Key > Create new key > JSON");
  console.log("  4. Download the JSON file");
  console.log("  5. In Google Play Console > Settings > API access, link this service account\n");

  const { serviceAccountJson } = await inquirer.prompt<{ serviceAccountJson: string }>([
    {
      type: "editor",
      name: "serviceAccountJson",
      message: "Service account JSON (paste the downloaded JSON file contents):",
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

async function askSecret(label: string, keychainKey: string): Promise<typeof KEYCHAIN_SENTINEL> {
  const { value } = await inquirer.prompt<{ value: string }>([
    { type: "password", name: "value", message: `${label} key/token:`, mask: "*", validate: (v: string) => v.length > 0 || "Required" },
  ]);
  await setSecret(keychainKey, value);
  return KEYCHAIN_SENTINEL;
}

async function askArdenTts(): Promise<CollectorsDraft["ardenTts"]> {
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

type CollectorChoice = "appStore" | "playStore" | "eodinSdk" | "eodinGrowth" | "fridgify" | "asoMobile" | "youtube" | "ardenTts";

const COLLECTOR_CHOICES: Array<{ name: string; value: CollectorChoice; hint: string }> = [
  { name: "App Store Connect", value: "appStore", hint: "iOS ASO + reviews — appstoreconnect.apple.com > Keys" },
  { name: "Google Play", value: "playStore", hint: "Android reviews — console.cloud.google.com > Service Accounts" },
  { name: "Eodin SDK", value: "eodinSdk", hint: "installs / funnel / cohort — Eodin dashboard > API Keys" },
  { name: "Eodin Growth", value: "eodinGrowth", hint: "blog / SEO / GA4 — GROWTH_AGENT_TOKEN" },
  { name: "Fridgify Recipes", value: "fridgify", hint: "recipe-aware blog posts — Fridgify API base URL" },
  { name: "ASOMobile", value: "asoMobile", hint: "keyword rankings — asomobile.net > Settings > API" },
  { name: "YouTube Data API", value: "youtube", hint: "Shorts performance — console.cloud.google.com > YouTube API" },
  { name: "Arden TTS", value: "ardenTts", hint: "voiceover — your self-hosted endpoint URL" },
];

async function applyCollectors(
  config: Partial<AdariaConfig>,
): Promise<Partial<AdariaConfig>> {
  console.log("\n--- Data Collectors ---");
  console.log("Select the data sources you want to configure.");
  console.log("You can add more later with `adaria-ai init collectors`.\n");

  const existing = (config.collectors ?? {}) as CollectorsDraft;
  const alreadyConfigured = Object.keys(existing).filter((k) => existing[k as keyof CollectorsDraft] != null);

  const { selected } = await inquirer.prompt<{ selected: CollectorChoice[] }>([
    {
      type: "checkbox",
      name: "selected",
      message: "Which collectors do you want to configure? (space to toggle, enter to confirm)",
      choices: COLLECTOR_CHOICES.map((c) => ({
        name: `${c.name} — ${c.hint}`,
        value: c.value,
        checked: alreadyConfigured.includes(c.value),
      })),
    },
  ]);

  const draft: CollectorsDraft = { ...existing };

  for (const choice of selected) {
    // Skip if already configured and not re-selected
    if (existing[choice] && alreadyConfigured.includes(choice)) {
      const { reconfigure } = await inquirer.prompt<{ reconfigure: boolean }>([
        { type: "confirm", name: "reconfigure", message: `${choice} is already configured. Reconfigure?`, default: false },
      ]);
      if (!reconfigure) continue;
    }

    console.log(`\nConfiguring ${COLLECTOR_CHOICES.find((c) => c.value === choice)?.name ?? choice}...`);

    switch (choice) {
      case "appStore": {
        const r = await askAppStore();
        if (r) draft.appStore = r;
        break;
      }
      case "playStore": {
        const r = await askPlayStore();
        if (r) draft.playStore = r;
        break;
      }
      case "eodinSdk":
        console.log("  Get your API key from the Eodin dashboard > Settings > API Keys\n");
        draft.eodinSdk = { apiKey: await askSecret("Eodin SDK API key", KEYCHAIN_KEYS.eodinSdkApiKey) };
        break;
      case "eodinGrowth":
        console.log("  This is the GROWTH_AGENT_TOKEN from your Eodin Growth service config\n");
        draft.eodinGrowth = { token: await askSecret("Eodin Growth token", KEYCHAIN_KEYS.eodinGrowthToken) };
        break;
      case "fridgify": {
        console.log("  Enter the base URL for the Fridgify Recipes API\n");
        const { fridgifyUrl } = await inquirer.prompt<{ fridgifyUrl: string }>([
          { type: "input", name: "fridgifyUrl", message: "Fridgify API base URL:", validate: (v: string) => v.startsWith("https://") || "Must be an https:// URL" },
        ]);
        draft.fridgify = { baseUrl: fridgifyUrl.trim() };
        break;
      }
      case "asoMobile":
        console.log("  Get your API key from https://asomobile.net > Settings > API\n");
        draft.asoMobile = { apiKey: await askSecret("ASOMobile API key", KEYCHAIN_KEYS.asoMobileApiKey) };
        break;
      case "youtube":
        console.log("  1. Go to https://console.cloud.google.com > APIs & Services > Credentials");
        console.log("  2. Create an API key (or use existing)");
        console.log("  3. Enable 'YouTube Data API v3' in the API library\n");
        draft.youtube = { apiKey: await askSecret("YouTube API key", KEYCHAIN_KEYS.youtubeApiKey) };
        break;
      case "ardenTts":
        console.log("  Enter the base URL of your Arden TTS service endpoint\n");
        draft.ardenTts = await askArdenTts();
        break;
    }
  }

  return { ...config, collectors: draft as CollectorsConfig };
}

// ---------------------------------------------------------------------------
// Social Platforms
// ---------------------------------------------------------------------------

type SocialDraft = {
  twitter?: { apiKey: typeof KEYCHAIN_SENTINEL; apiSecret: typeof KEYCHAIN_SENTINEL; accessToken: typeof KEYCHAIN_SENTINEL; accessTokenSecret: typeof KEYCHAIN_SENTINEL } | undefined;
  facebook?: { appId: string; appSecret: typeof KEYCHAIN_SENTINEL; accessToken: typeof KEYCHAIN_SENTINEL; pageId: string } | undefined;
  threads?: { accessToken: typeof KEYCHAIN_SENTINEL; userId: string } | undefined;
  tiktok?: { clientKey: string; clientSecret: typeof KEYCHAIN_SENTINEL; accessToken: typeof KEYCHAIN_SENTINEL } | undefined;
  youtube?: { accessToken: typeof KEYCHAIN_SENTINEL; channelId: string } | undefined;
  linkedin?: { accessToken: typeof KEYCHAIN_SENTINEL; organizationId: string } | undefined;
};

async function askTwitter(): Promise<SocialDraft["twitter"]> {
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

async function askFacebook(): Promise<SocialDraft["facebook"]> {
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

async function askThreads(): Promise<SocialDraft["threads"]> {
  const answers = await inquirer.prompt<{ accessToken: string; userId: string }>([
    { type: "password", name: "accessToken", message: "Access Token:", mask: "*", validate: (v: string) => v.length > 0 || "Required" },
    { type: "input", name: "userId", message: "User ID:", validate: (v: string) => v.length > 0 || "Required" },
  ]);
  await setSecret(KEYCHAIN_KEYS.threadsAccessToken, answers.accessToken);
  return { accessToken: KEYCHAIN_SENTINEL, userId: answers.userId };
}

async function askTikTok(): Promise<SocialDraft["tiktok"]> {
  const answers = await inquirer.prompt<{ clientKey: string; clientSecret: string; accessToken: string }>([
    { type: "input", name: "clientKey", message: "Client Key:", validate: (v: string) => v.length > 0 || "Required" },
    { type: "password", name: "clientSecret", message: "Client Secret:", mask: "*", validate: (v: string) => v.length > 0 || "Required" },
    { type: "password", name: "accessToken", message: "Access Token:", mask: "*", validate: (v: string) => v.length > 0 || "Required" },
  ]);
  await setSecret(KEYCHAIN_KEYS.tiktokClientSecret, answers.clientSecret);
  await setSecret(KEYCHAIN_KEYS.tiktokAccessToken, answers.accessToken);
  return { clientKey: answers.clientKey, clientSecret: KEYCHAIN_SENTINEL, accessToken: KEYCHAIN_SENTINEL };
}

async function askYouTubeSocial(): Promise<SocialDraft["youtube"]> {
  const answers = await inquirer.prompt<{ accessToken: string; channelId: string }>([
    { type: "password", name: "accessToken", message: "OAuth Access Token:", mask: "*", validate: (v: string) => v.length > 0 || "Required" },
    { type: "input", name: "channelId", message: "Channel ID (UC…):", validate: (v: string) => v.length > 0 || "Required" },
  ]);
  await setSecret(KEYCHAIN_KEYS.youtubeAccessToken, answers.accessToken);
  return { accessToken: KEYCHAIN_SENTINEL, channelId: answers.channelId };
}

async function askLinkedIn(): Promise<SocialDraft["linkedin"]> {
  const answers = await inquirer.prompt<{ accessToken: string; organizationId: string }>([
    { type: "password", name: "accessToken", message: "Access Token:", mask: "*", validate: (v: string) => v.length > 0 || "Required" },
    { type: "input", name: "organizationId", message: "Organization ID:", validate: (v: string) => v.length > 0 || "Required" },
  ]);
  await setSecret(KEYCHAIN_KEYS.linkedinAccessToken, answers.accessToken);
  return { accessToken: KEYCHAIN_SENTINEL, organizationId: answers.organizationId };
}

type SocialChoice = "twitter" | "facebook" | "threads" | "tiktok" | "youtube" | "linkedin";

const SOCIAL_CHOICES: Array<{ name: string; value: SocialChoice; hint: string }> = [
  { name: "Twitter/X", value: "twitter", hint: "developer.twitter.com > Keys and Tokens" },
  { name: "Facebook", value: "facebook", hint: "developers.facebook.com > App Dashboard" },
  { name: "Threads", value: "threads", hint: "developers.facebook.com > Threads API" },
  { name: "TikTok", value: "tiktok", hint: "developers.tiktok.com (requires app review)" },
  { name: "YouTube Community", value: "youtube", hint: "console.cloud.google.com > OAuth 2.0" },
  { name: "LinkedIn", value: "linkedin", hint: "developer.linkedin.com > My Apps > Auth" },
];

async function applySocial(
  config: Partial<AdariaConfig>,
): Promise<Partial<AdariaConfig>> {
  console.log("\n--- Social Media Platforms ---");
  console.log("Select platforms for automated marketing posts.\n");

  const existing = (config.social ?? {}) as SocialDraft;
  const alreadyConfigured = Object.keys(existing).filter((k) => existing[k as keyof SocialDraft] != null);

  const { selected } = await inquirer.prompt<{ selected: SocialChoice[] }>([
    {
      type: "checkbox",
      name: "selected",
      message: "Which social platforms? (space to toggle, enter to confirm)",
      choices: SOCIAL_CHOICES.map((c) => ({
        name: `${c.name} — ${c.hint}`,
        value: c.value,
        checked: alreadyConfigured.includes(c.value),
      })),
    },
  ]);

  const draft: SocialDraft = { ...existing };

  for (const choice of selected) {
    if (existing[choice] && alreadyConfigured.includes(choice)) {
      const { reconfigure } = await inquirer.prompt<{ reconfigure: boolean }>([
        { type: "confirm", name: "reconfigure", message: `${choice} is already configured. Reconfigure?`, default: false },
      ]);
      if (!reconfigure) continue;
    }

    const label = SOCIAL_CHOICES.find((c) => c.value === choice)?.name ?? choice;
    console.log(`\nConfiguring ${label}...`);

    switch (choice) {
      case "twitter":
        draft.twitter = await askTwitter();
        break;
      case "facebook":
        draft.facebook = await askFacebook();
        break;
      case "threads":
        draft.threads = await askThreads();
        break;
      case "tiktok":
        draft.tiktok = await askTikTok();
        break;
      case "youtube":
        draft.youtube = await askYouTubeSocial();
        break;
      case "linkedin":
        draft.linkedin = await askLinkedIn();
        break;
    }
  }

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
      config = await loadRawConfig() as Partial<AdariaConfig>;
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

  // Guard: section-only init on a fresh install requires Slack first
  if (section && !config.slack) {
    console.error(
      `\nSlack is not configured yet. Run "adaria-ai init slack" first,` +
      ` or "adaria-ai init" for full setup.`,
    );
    process.exitCode = 1;
    return;
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
