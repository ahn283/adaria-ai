/**
 * `adaria-ai daemon` — foreground reactive daemon.
 *
 * This is the command launchd invokes. It is NOT meant for humans to run
 * directly outside of local debugging; `adaria-ai start` is the usual
 * entry point. The process stays alive forever (KeepAlive=true in the
 * plist), handling SIGTERM/SIGINT for clean shutdown.
 *
 * M7: wires db, apps, and the production skill registry into AgentCore
 * so that Mode A commands dispatch to real skills and approval callbacks
 * can route to the correct skill handler.
 */
import { loadConfig } from "../config/store.js";
import { loadApps } from "../config/load-apps.js";
import type { AppConfig } from "../config/apps-schema.js";
import { initDatabase } from "../db/schema.js";
import { createMessengerAdapter } from "../messenger/factory.js";
import { AgentCore } from "../agent/core.js";
import { createProductionRegistry } from "../skills/registry.js";
import { AdariaError } from "../utils/errors.js";
import {
  error as logError,
  info as logInfo,
} from "../utils/logger.js";

export async function runDaemon(): Promise<void> {
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    // The plist uses `SuccessfulExit=false, Crashed=true` so a clean
    // exit(0) tells launchd "don't respawn me". Without that combination
    // of exit code + KeepAlive dict, any config typo would put the
    // daemon into a 30s respawn loop that floods daemon.err.log.
    const userMsg =
      err instanceof AdariaError
        ? err.userMessage
        : err instanceof Error
          ? err.message
          : String(err);
    logError(`adaria-ai daemon refusing to start: ${userMsg}`);
    console.error(`adaria-ai daemon refusing to start: ${userMsg}`);
    process.exit(0);
  }

  // Load apps.yaml — optional for daemon startup. If missing, Mode A
  // skill dispatch will work but skills that iterate apps will have
  // an empty list.
  let apps: AppConfig[] = [];
  try {
    ({ apps } = await loadApps());
  } catch (err) {
    logError(
      `Failed to load apps.yaml: ${err instanceof Error ? err.message : String(err)}. Skills will have no app context.`,
    );
  }

  // Initialize DB — required for Mode A skills and Mode B MCP tools.
  let db;
  try {
    db = initDatabase();
  } catch (err) {
    logError(
      `DB initialization failed: ${err instanceof Error ? err.message : String(err)}. Exiting cleanly to prevent launchd respawn loop.`,
    );
    console.error(
      `adaria-ai daemon refusing to start: DB init failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(0);
  }

  // Build the production skill registry with all 8 skills.
  const skillRegistry = createProductionRegistry(config);

  const messenger = createMessengerAdapter(config);
  const agent = new AgentCore(messenger, config, {
    db,
    apps,
    skillRegistry,
  });

  await agent.start();
  logInfo(
    `adaria-ai daemon started (${String(skillRegistry.getSkillCount())} skills, ${String(apps.length)} apps)`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo(`adaria-ai daemon received ${signal}, stopping...`);
    agent
      .stop()
      .then(() => {
        db.close();
        process.exit(0);
      })
      .catch((err: unknown) => {
        logError(
          `Shutdown error: ${err instanceof Error ? err.message : String(err)}`,
        );
        db.close();
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
