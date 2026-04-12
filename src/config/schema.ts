import { z } from "zod";

/**
 * adaria-ai config schema.
 *
 * Written to `$ADARIA_HOME/config.yaml` by `adaria-ai init`. Secrets may be
 * stored inline or replaced with the sentinel string `***keychain***`, in
 * which case `store.ts` resolves them from the macOS Keychain at load time.
 *
 * Shape diverges from pilot-ai: dropped all personal-agent surfaces (notion,
 * obsidian, linear, figma, github, google workspace, telegram, filesystem
 * sandbox). Only Slack is supported as the messenger in v1.
 */

export const slackConfigSchema = z.object({
  botToken: z.string().min(1),
  appToken: z.string().min(1),
  signingSecret: z.string().min(1),
});

export const claudeConfigSchema = z.object({
  /** M1 ships only the CLI runner. The schema intentionally refuses
   *  `mode: 'api'` at load time rather than silently falling through to
   *  CLI when the user expected an Anthropic SDK invocation (M1 claude
   *  review HIGH #1). A later milestone will re-add `'api'` once the
   *  fallback runner is ported. */
  mode: z.literal("cli").default("cli"),
  cliBinary: z.string().default("claude"),
  apiKey: z.string().nullable().default(null),
  /** Default Claude CLI timeout in ms — adaria-ai defaults to 120s for
   *  reactive Slack calls; weekly orchestrator overrides this per-call. */
  timeoutMs: z.number().int().positive().default(120_000),
});

export const securityConfigSchema = z.object({
  /** Slack user IDs allowed to mention the bot. Non-allowlisted users are
   *  silently ignored. */
  allowedUsers: z.array(z.string()).default([]),
  /** If true, only direct messages (no public channel mentions) are accepted. */
  dmOnly: z.boolean().default(false),
  auditLog: z
    .object({
      enabled: z.boolean().default(true),
      maskSecrets: z.boolean().default(true),
    })
    .default({ enabled: true, maskSecrets: true }),
});

export const safetyConfigSchema = z.object({
  dangerousActionsRequireApproval: z.boolean().default(true),
  approvalTimeoutMinutes: z.number().int().positive().default(30),
});

export const thresholdsConfigSchema = z.object({
  /** Keyword rank drop (positions) to trigger a critical alert. */
  keywordRankAlert: z.number().int().positive().default(5),
  /** Negative review ratio (0–1) to trigger a critical alert. */
  reviewSentimentAlert: z.number().min(0).max(1).default(0.3),
  /** 1-star reviews in 24h to trigger a warning. */
  oneStarReviewAlert: z.number().int().nonnegative().default(3),
  /** Install→signup conversion drop ratio (0–1) to trigger a warning. */
  installSignupDropAlert: z.number().min(0).max(1).default(0.15),
  /** Signup→subscription conversion drop ratio (0–1) to trigger a warning. */
  subscriptionDropAlert: z.number().min(0).max(1).default(0.2),
  /** SEO clicks WoW drop ratio to trigger a warning. */
  seoClicksDropAlert: z.number().min(0).max(1).default(0.3),
  /** SEO impressions WoW drop ratio to trigger a warning. */
  seoImpressionsDropAlert: z.number().min(0).max(1).default(0.3),
  /** Web traffic sessions WoW drop ratio to trigger a warning. */
  webTrafficDropAlert: z.number().min(0).max(1).default(0.25),
});

export const agentConfigSchema = z.object({
  /** Whether to stream Claude's thinking snippets back to the Slack message. */
  showThinking: z.boolean().default(true),
  /** Default briefing channel (e.g. "#growth"). Used by the weekly
   *  orchestrator (M6) for posting the Sunday briefing. */
  briefingChannel: z.string().optional(),
  /** Claude CLI timeout override for weekly orchestrator (ms). Weekly
   *  analysis skills may take much longer than interactive commands. */
  weeklyTimeoutMs: z.number().int().positive().default(900_000),
});

// ---------------------------------------------------------------------------
// Collector credentials (global — per-app identifiers live in apps.yaml)
// ---------------------------------------------------------------------------

/**
 * `config.yaml.collectors` holds the global secrets each collector needs.
 * Every block is optional so users can enable collectors incrementally:
 * an unset block means the skill/orchestrator that depends on it will
 * simply skip that data source. Secret fields accept the keychain
 * sentinel the same way `slack.*` does.
 */
export const appStoreCollectorConfigSchema = z.object({
  keyId: z.string().min(1),
  issuerId: z.string().min(1),
  privateKey: z.string().min(1),
});

export const playStoreCollectorConfigSchema = z.object({
  serviceAccountJson: z.string().min(1),
});

export const eodinSdkCollectorConfigSchema = z.object({
  apiKey: z.string().min(1),
});

export const eodinGrowthCollectorConfigSchema = z.object({
  token: z.string().min(1),
});

export const asoMobileCollectorConfigSchema = z.object({
  apiKey: z.string().min(1),
});

export const youtubeCollectorConfigSchema = z.object({
  apiKey: z.string().min(1),
});

export const ardenTtsCollectorConfigSchema = z.object({
  /** Not a secret — the user-hosted TTS endpoint URL. */
  endpoint: z.string().url(),
});

export const collectorsConfigSchema = z
  .object({
    appStore: appStoreCollectorConfigSchema.optional(),
    playStore: playStoreCollectorConfigSchema.optional(),
    eodinSdk: eodinSdkCollectorConfigSchema.optional(),
    eodinGrowth: eodinGrowthCollectorConfigSchema.optional(),
    asoMobile: asoMobileCollectorConfigSchema.optional(),
    youtube: youtubeCollectorConfigSchema.optional(),
    ardenTts: ardenTtsCollectorConfigSchema.optional(),
  })
  .default({});

export const configSchema = z.object({
  slack: slackConfigSchema,
  claude: claudeConfigSchema,
  security: securityConfigSchema,
  safety: safetyConfigSchema.default({
    dangerousActionsRequireApproval: true,
    approvalTimeoutMinutes: 30,
  }),
  agent: agentConfigSchema.default({
    showThinking: true,
    weeklyTimeoutMs: 900_000,
  }),
  thresholds: thresholdsConfigSchema.default({
    keywordRankAlert: 5,
    reviewSentimentAlert: 0.3,
    oneStarReviewAlert: 3,
    installSignupDropAlert: 0.15,
    subscriptionDropAlert: 0.2,
    seoClicksDropAlert: 0.3,
    seoImpressionsDropAlert: 0.3,
    webTrafficDropAlert: 0.25,
  }),
  collectors: collectorsConfigSchema,
});

export type AdariaConfig = z.infer<typeof configSchema>;
export type SlackConfig = z.infer<typeof slackConfigSchema>;
export type ClaudeConfig = z.infer<typeof claudeConfigSchema>;
export type SecurityConfig = z.infer<typeof securityConfigSchema>;
export type SafetyConfig = z.infer<typeof safetyConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type ThresholdsConfig = z.infer<typeof thresholdsConfigSchema>;
export type CollectorsConfig = z.infer<typeof collectorsConfigSchema>;
export type AppStoreCollectorConfig = z.infer<
  typeof appStoreCollectorConfigSchema
>;
export type PlayStoreCollectorConfig = z.infer<
  typeof playStoreCollectorConfigSchema
>;
export type EodinSdkCollectorConfig = z.infer<
  typeof eodinSdkCollectorConfigSchema
>;
export type EodinGrowthCollectorConfig = z.infer<
  typeof eodinGrowthCollectorConfigSchema
>;
export type AsoMobileCollectorConfig = z.infer<
  typeof asoMobileCollectorConfigSchema
>;
export type YoutubeCollectorConfig = z.infer<
  typeof youtubeCollectorConfigSchema
>;
export type ArdenTtsCollectorConfig = z.infer<
  typeof ardenTtsCollectorConfigSchema
>;

export const KEYCHAIN_SENTINEL = "***keychain***";

/**
 * Keychain slot names for every secret field in the config. Kept in one
 * place so init.ts (writes) and store.ts (reads) can't drift out of sync.
 */
export const KEYCHAIN_KEYS = {
  slackBotToken: "slack-bot-token",
  slackAppToken: "slack-app-token",
  slackSigningSecret: "slack-signing-secret",
  anthropicApiKey: "anthropic-api-key",
  appStorePrivateKey: "collector-appstore-private-key",
  playStoreServiceAccount: "collector-playstore-service-account",
  eodinSdkApiKey: "collector-eodin-sdk-api-key",
  eodinGrowthToken: "collector-eodin-growth-token",
  asoMobileApiKey: "collector-asomobile-api-key",
  youtubeApiKey: "collector-youtube-api-key",
} as const;
