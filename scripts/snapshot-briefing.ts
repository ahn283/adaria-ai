/**
 * Snapshot briefing script for M7 parity verification.
 *
 * Runs `runWeeklyAnalysis` with a null messenger that captures all
 * Slack outputs instead of posting them. Writes the captured briefings
 * to a timestamped JSON file in `$ADARIA_HOME/snapshots/` so they can
 * be diffed against the equivalent growth-agent briefing.
 *
 * Usage:
 *   npx tsx scripts/snapshot-briefing.ts
 *   ADARIA_HOME=~/.adaria-dev npx tsx scripts/snapshot-briefing.ts
 *
 * The script posts nothing to Slack and respects ADARIA_DRY_RUN.
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config/store.js";
import { loadApps } from "../src/config/load-apps.js";
import { initDatabase } from "../src/db/schema.js";
import { ADARIA_HOME } from "../src/utils/paths.js";
import {
  runWeeklyAnalysis,
  type WeeklySkillDispatchers,
} from "../src/orchestrator/weekly.js";
import { createProductionRegistry } from "../src/skills/registry.js";
import type { MessengerAdapter } from "../src/messenger/adapter.js";
import type { SkillContext, SkillResult } from "../src/types/skill.js";
import type { AppConfig } from "../src/config/apps-schema.js";

// ---------------------------------------------------------------------------
// Capturing messenger — records all outputs
// ---------------------------------------------------------------------------

interface CapturedMessage {
  type: "text" | "approval" | "blocks";
  channel: string;
  text: string;
  blocks?: readonly Record<string, unknown>[];
}

function createCapturingMessenger(): MessengerAdapter & {
  captured: CapturedMessage[];
} {
  const captured: CapturedMessage[] = [];
  return {
    captured,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    onMessage: () => {},
    onApproval: () => {},
    sendText: (channelId, text) => {
      captured.push({ type: "text", channel: channelId, text });
      return Promise.resolve("snapshot-ts");
    },
    updateText: () => Promise.resolve(),
    sendApproval: (channelId, text, _taskId) => {
      captured.push({ type: "approval", channel: channelId, text });
      return Promise.resolve();
    },
    sendBlocks: (channelId, fallbackText, blocks) => {
      captured.push({
        type: "blocks",
        channel: channelId,
        text: fallbackText,
        blocks,
      });
      return Promise.resolve("snapshot-block-ts");
    },
  };
}

// ---------------------------------------------------------------------------
// Build skill dispatchers from production registry
// ---------------------------------------------------------------------------

function buildDispatchers(
  ctx: SkillContext,
): WeeklySkillDispatchers {
  const registry = createProductionRegistry(ctx.config);
  const skills = registry.getSkills();

  function findDispatcher(
    name: string,
  ): (app: AppConfig) => Promise<SkillResult> {
    const skill = skills.find((s) => s.name === name);
    if (!skill) {
      return () =>
        Promise.resolve({
          summary: `(skill "${name}" not found)`,
          alerts: [],
          approvals: [],
        });
    }
    return (app: AppConfig) => skill.dispatch(ctx, `${skill.commands[0]} ${app.id}`);
  }

  return {
    aso: findDispatcher("aso"),
    review: findDispatcher("review"),
    onboarding: findDispatcher("onboarding"),
    seoBlog: findDispatcher("seo-blog"),
    shortForm: findDispatcher("short-form"),
    sdkRequest: findDispatcher("sdk-request"),
    content: findDispatcher("content"),
    socialPublish: findDispatcher("social-publish"),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Force dry-run to prevent any writes
  process.env["ADARIA_DRY_RUN"] = "1";

  console.log("Loading config...");
  const config = await loadConfig();
  const { apps } = await loadApps();
  const dbPath = path.join(ADARIA_HOME, "data", "adaria.db");

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run the daemon first.`);
    process.exit(1);
  }

  const db = initDatabase(dbPath);
  const messenger = createCapturingMessenger();

  const ctx: SkillContext = {
    db,
    apps,
    config,
    runClaude: async (prompt: string) => {
      const { invokeClaudeCli } = await import("../src/agent/claude.js");
      const result = await invokeClaudeCli({
        prompt,
        cliBinary: config.claude.cliBinary,
        timeoutMs: config.claude.timeoutMs,
      });
      return result.result;
    },
  };

  const dispatchers = buildDispatchers(ctx);

  const activeApps = apps.filter((a: AppConfig) => a.active);
  console.log(
    `Running weekly analysis for ${String(activeApps.length)} active apps...`,
  );

  await runWeeklyAnalysis({
    db,
    config,
    apps,
    messenger,
    dispatchers,
  });

  // Write snapshot
  const snapshotDir = path.join(ADARIA_HOME, "snapshots");
  fs.mkdirSync(snapshotDir, { recursive: true });

  const now = new Date();
  const dateStr = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(snapshotDir, `briefing-${dateStr}.json`);

  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        timestamp: now.toISOString(),
        adariaHome: ADARIA_HOME,
        dryRun: true,
        messages: messenger.captured.map((m) => ({
          type: m.type,
          channel: m.channel,
          text: m.text,
          ...(m.blocks ? { blockCount: m.blocks.length } : {}),
        })),
      },
      null,
      2,
    ),
  );

  console.log(`\nSnapshot written to ${outPath}`);
  console.log(
    `Captured ${String(messenger.captured.length)} messages (${String(messenger.captured.filter((m) => m.type === "text").length)} text, ${String(messenger.captured.filter((m) => m.type === "blocks").length)} blocks, ${String(messenger.captured.filter((m) => m.type === "approval").length)} approvals)`,
  );

  db.close();
}

main().catch((err) => {
  console.error("Snapshot failed:", err);
  process.exit(1);
});
