/**
 * `adaria-ai init` — interactive setup wizard.
 *
 * Collects the minimum config needed to boot the reactive daemon:
 *   - Slack bot token, app token, signing secret
 *   - At least one allowlisted Slack user ID
 *   - Optional briefing channel (M6 weekly orchestrator target)
 *
 * Secrets are stored in the macOS Keychain by default and the YAML file
 * stores the sentinel `***keychain***`. Users who want to pin a secret
 * inline can re-edit `~/.adaria/config.yaml` afterwards.
 *
 * This is a lot smaller than pilot-ai's 834-LOC init — adaria-ai doesn't
 * need Google/Figma/Linear OAuth, project directory discovery, memory
 * bootstrap, or the personal-agent tool registry install flow. Those are
 * all dropped.
 */
import inquirer from "inquirer";
import {
  configSchema,
  KEYCHAIN_SENTINEL,
  type AdariaConfig,
} from "../config/schema.js";
import { configExists, saveConfig } from "../config/store.js";
import { setSecret } from "../config/keychain.js";
import { CONFIG_PATH } from "../utils/paths.js";

interface WizardAnswers {
  botToken: string;
  appToken: string;
  signingSecret: string;
  allowedUser: string;
  briefingChannel: string;
}

export async function runInit(): Promise<void> {
  console.log("adaria-ai init — interactive setup\n");

  if (await configExists()) {
    // Deliberately do NOT try to parse the existing YAML — users run
    // `init` precisely when their config is broken, and
    // `loadRawConfig()` would throw on malformed content, trapping the
    // user in a state they can't escape from within the tool (M1 CLI
    // review HIGH #2). The wizard overwrites the file unconditionally.
    console.log(
      `Existing config at ${CONFIG_PATH} will be overwritten.\n`,
    );
  } else {
    console.log(`Config will be written to ${CONFIG_PATH}.\n`);
  }

  const answers = await inquirer.prompt<WizardAnswers>([
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
      validate: (v: string) => v.length > 0 || "Signing secret cannot be empty",
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

  // Stash secrets in the Keychain.
  await setSecret("slack-bot-token", answers.botToken);
  await setSecret("slack-app-token", answers.appToken);
  await setSecret("slack-signing-secret", answers.signingSecret);

  const agent: AdariaConfig["agent"] = { showThinking: true };
  if (answers.briefingChannel.trim().length > 0) {
    agent.briefingChannel = answers.briefingChannel.trim();
  }

  // Construct and validate via the schema before writing — this catches
  // shape drift early and runs every default-filling zod layer.
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
      allowedUsers: [answers.allowedUser],
      dmOnly: false,
      auditLog: { enabled: true, maskSecrets: true },
    },
    safety: {
      dangerousActionsRequireApproval: true,
      approvalTimeoutMinutes: 30,
    },
    agent,
  });

  await saveConfig(candidate);

  console.log("\nConfig written to", CONFIG_PATH);
  console.log("Secrets stored in the macOS Keychain (service: adaria-ai).");
  console.log("\nNext steps:");
  console.log("  adaria-ai doctor   # verify Slack + Claude CLI are reachable");
  console.log("  adaria-ai start    # load the reactive daemon into launchd");
}
