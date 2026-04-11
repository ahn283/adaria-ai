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
  mode: z.enum(["cli", "api"]).default("cli"),
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

export const agentConfigSchema = z.object({
  /** Whether to stream Claude's thinking snippets back to the Slack message. */
  showThinking: z.boolean().default(true),
  /** Default briefing channel (e.g. "#growth"). Used by the weekly
   *  orchestrator (M6) for posting the Sunday briefing. Optional until M6. */
  briefingChannel: z.string().optional(),
});

export const configSchema = z.object({
  slack: slackConfigSchema,
  claude: claudeConfigSchema,
  security: securityConfigSchema,
  safety: safetyConfigSchema.default({
    dangerousActionsRequireApproval: true,
    approvalTimeoutMinutes: 30,
  }),
  agent: agentConfigSchema.default({ showThinking: true }),
});

export type AdariaConfig = z.infer<typeof configSchema>;
export type SlackConfig = z.infer<typeof slackConfigSchema>;
export type ClaudeConfig = z.infer<typeof claudeConfigSchema>;
export type SecurityConfig = z.infer<typeof securityConfigSchema>;
export type SafetyConfig = z.infer<typeof safetyConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const KEYCHAIN_SENTINEL = "***keychain***";
