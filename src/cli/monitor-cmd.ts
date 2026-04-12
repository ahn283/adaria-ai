/**
 * `adaria-ai monitor` — one-shot daily monitor CLI entry.
 *
 * Loads config, initializes DB, runs threshold checks, exits cleanly.
 * Invoked by launchd cron (daily 23:00 UTC) or manually.
 *
 * Named `monitor-cmd.ts` to avoid shadowing `src/orchestrator/monitor.ts`
 * in import paths.
 */

import { loadConfig } from "../config/store.js";
import { loadApps } from "../config/load-apps.js";
import { initDatabase } from "../db/schema.js";
import { createMessengerAdapter } from "../messenger/factory.js";
import { runDailyMonitor } from "../orchestrator/monitor.js";
import * as logger from "../utils/logger.js";

export async function runMonitorCmd(): Promise<void> {
  logger.info("Loading configuration");

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error(
      `Failed to load config: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  let apps;
  try {
    ({ apps } = await loadApps());
  } catch (err) {
    console.error(
      `Failed to load apps.yaml: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }
  const db = initDatabase();

  let messenger;
  try {
    messenger = createMessengerAdapter(config);

    await runDailyMonitor({
      db,
      config,
      apps,
      messenger,
    });

    logger.info("Daily monitor finished successfully");
  } catch (err) {
    logger.error(
      `Daily monitor failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  } finally {
    db.close();
    if (messenger) {
      await messenger.stop();
    }
  }
}
