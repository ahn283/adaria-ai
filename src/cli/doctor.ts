/**
 * `adaria-ai doctor` — health snapshot.
 *
 * Checks configuration, Claude CLI, database, apps, collector
 * credentials, social platform credentials, and MCP tool registration.
 *
 * Exit code is 0 when every check passes, 1 otherwise.
 */
import { loadConfig } from "../config/store.js";
import { initDatabase } from "../db/schema.js";
import { checkClaudeCli, checkClaudeCliAuth } from "../agent/claude.js";
import type { AdariaConfig } from "../config/schema.js";

interface Check {
  name: string;
  pass: boolean;
  message?: string;
}

function check(name: string, pass: boolean, message?: string): Check {
  return message !== undefined ? { name, pass, message } : { name, pass };
}

async function checkConfig(): Promise<{ checks: Check[]; config: AdariaConfig | null }> {
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

    if (config.agent.briefingChannel) {
      checks.push(check("agent.briefingChannel set", true, config.agent.briefingChannel));
    } else {
      // Not a failure — optional for daemon-only setups
      checks.push(check("agent.briefingChannel set", true, "not set (weekly orchestrator will skip posting)"));
    }

    return { checks, config };
  } catch (err) {
    return {
      checks: [
        check(
          "config.yaml loads",
          false,
          err instanceof Error ? err.message : String(err),
        ),
      ],
      config: null,
    };
  }
}

async function checkClaude(cliBinary: string): Promise<Check[]> {
  const installed = await checkClaudeCli(cliBinary);
  if (!installed) {
    return [
      check(
        "claude CLI installed",
        false,
        `\`${cliBinary}\` not found on PATH. Install with 'npm i -g @anthropic-ai/claude-code'.`,
      ),
    ];
  }
  const authed = await checkClaudeCliAuth(cliBinary);
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

function checkDb(): Check[] {
  try {
    const db = initDatabase();
    const tables = db
      .prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .get() as { count: number } | undefined;
    const tableCount = tables?.count ?? 0;
    db.close();
    return [
      check("DB accessible", true, `${String(tableCount)} tables`),
    ];
  } catch (err) {
    return [
      check(
        "DB accessible",
        false,
        err instanceof Error ? err.message : String(err),
      ),
    ];
  }
}

function checkCollectors(config: AdariaConfig): Check[] {
  const checks: Check[] = [];
  const c = config.collectors;

  // Collector credentials are optional — pass=true even when not configured
  checks.push(check("collector: App Store Connect", true, c.appStore ? "configured" : "not configured (optional)"));
  checks.push(check("collector: Google Play", true, c.playStore ? "configured" : "not configured (optional)"));
  checks.push(check("collector: ASOMobile", true, c.asoMobile ? "configured" : "not configured (optional)"));
  checks.push(check("collector: Eodin SDK", true, c.eodinSdk ? "configured" : "not configured (optional)"));
  checks.push(check("collector: Eodin Growth", true, c.eodinGrowth ? "configured" : "not configured (optional)"));
  checks.push(check("collector: YouTube", true, c.youtube ? "configured" : "not configured (optional)"));

  return checks;
}

function checkSocial(config: AdariaConfig): Check[] {
  const checks: Check[] = [];
  const s = config.social;

  // Social credentials are optional — pass=true even when not configured
  checks.push(check("social: Twitter", true, s.twitter ? "configured" : "not configured (optional)"));
  checks.push(check("social: Facebook", true, s.facebook ? "configured" : "not configured (optional)"));
  checks.push(check("social: Threads", true, s.threads ? "configured" : "not configured (optional)"));
  checks.push(check("social: TikTok", true, s.tiktok ? "configured" : "not configured (optional)"));
  checks.push(check("social: YouTube", true, s.youtube ? "configured" : "not configured (optional)"));
  checks.push(check("social: LinkedIn", true, s.linkedin ? "configured" : "not configured (optional)"));

  return checks;
}

export async function runDoctor(): Promise<void> {
  const results: Check[] = [];

  // 1. Config
  console.log("Configuration:");
  const { checks: configChecks, config } = await checkConfig();
  results.push(...configChecks);
  for (const c of configChecks) printCheck(c);

  // 2. Claude CLI
  console.log("\nClaude CLI:");
  const cliBinary = config?.claude.cliBinary ?? "claude";
  const claudeChecks = await checkClaude(cliBinary);
  results.push(...claudeChecks);
  for (const c of claudeChecks) printCheck(c);

  // 3. Database
  console.log("\nDatabase:");
  const dbChecks = checkDb();
  results.push(...dbChecks);
  for (const c of dbChecks) printCheck(c);

  // 4. Collectors (only if config loaded)
  if (config) {
    console.log("\nCollectors:");
    const collectorChecks = checkCollectors(config);
    results.push(...collectorChecks);
    for (const c of collectorChecks) printCheck(c);

    console.log("\nSocial platforms:");
    const socialChecks = checkSocial(config);
    results.push(...socialChecks);
    for (const c of socialChecks) printCheck(c);
  }

  // Summary
  const failed = results.filter((c) => !c.pass).length;
  const total = results.length;
  console.log("");
  if (failed > 0) {
    console.log(`${String(failed)}/${String(total)} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`All ${String(total)} checks passed.`);
  }
}

function printCheck(c: Check): void {
  const icon = c.pass ? "\u2705" : "\u274c";
  const suffix = c.message ? ` \u2014 ${c.message}` : "";
  console.log(`  ${icon} ${c.name}${suffix}`);
}
