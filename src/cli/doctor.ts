/**
 * `adaria-ai doctor` — health snapshot.
 *
 * M1 version: check that the Claude CLI is installed + authed, that
 * config.yaml loads, and that the allowlist is non-empty. M7 will
 * extend this with App Store Connect / Play / ASOMobile / Eodin SDK /
 * Search Console / GA4 / MCP tool readiness.
 *
 * Exit code is 0 when every check passes, 1 otherwise, so
 * `adaria-ai doctor && echo ok` is a useful one-liner.
 */
import { loadConfig } from "../config/store.js";
import { checkClaudeCli, checkClaudeCliAuth } from "../agent/claude.js";

interface Check {
  name: string;
  pass: boolean;
  message?: string;
}

function check(name: string, pass: boolean, message?: string): Check {
  return message !== undefined ? { name, pass, message } : { name, pass };
}

async function checkConfig(): Promise<Check[]> {
  try {
    const config = await loadConfig();
    const checks: Check[] = [check("config.yaml loads", true)];
    const allowlistCount = config.security.allowedUsers.length;
    checks.push(
      check(
        "security.allowedUsers non-empty",
        allowlistCount > 0,
        allowlistCount === 0
          ? 'No allowlisted users. Run "adaria-ai init" and add a Slack user ID.'
          : `${String(allowlistCount)} user(s) allowlisted`,
      ),
    );
    const botOk = config.slack.botToken.startsWith("xoxb-");
    checks.push(
      check(
        "slack.botToken resolved",
        botOk,
        botOk ? undefined : "Bot token is missing or not resolved from Keychain",
      ),
    );
    return checks;
  } catch (err) {
    return [
      check(
        "config.yaml loads",
        false,
        err instanceof Error ? err.message : String(err),
      ),
    ];
  }
}

async function checkClaude(config: { cliBinary: string }): Promise<Check[]> {
  const installed = await checkClaudeCli(config.cliBinary);
  if (!installed) {
    return [
      check(
        "claude CLI installed",
        false,
        `\`${config.cliBinary}\` not found on PATH. Install with 'npm i -g @anthropic-ai/claude-code'.`,
      ),
    ];
  }
  const authed = await checkClaudeCliAuth(config.cliBinary);
  return [
    check("claude CLI installed", true),
    check(
      "claude CLI authenticated",
      authed,
      authed
        ? undefined
        : "Run 'claude /login' to authenticate. Note: during M7 parallel run, do NOT re-run /login (shared auth with growth-agent).",
    ),
  ];
}

export async function runDoctor(): Promise<void> {
  const results: Check[] = [];

  const configChecks = await checkConfig();
  results.push(...configChecks);

  // Claude CLI check only runs if config loaded — otherwise we don't
  // know which binary name to check.
  let cliBinary = "claude";
  try {
    const config = await loadConfig();
    cliBinary = config.claude.cliBinary;
  } catch {
    // config failed — fall through with default 'claude'
  }
  const claudeChecks = await checkClaude({ cliBinary });
  results.push(...claudeChecks);

  let failed = 0;
  for (const c of results) {
    const icon = c.pass ? "✅" : "❌";
    const suffix = c.message ? ` — ${c.message}` : "";
    console.log(`  ${icon} ${c.name}${suffix}`);
    if (!c.pass) failed++;
  }

  if (failed > 0) {
    console.log(`\n${String(failed)} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll checks passed.");
  }
}
