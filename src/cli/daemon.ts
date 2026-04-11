/**
 * `adaria-ai daemon` — foreground reactive daemon.
 *
 * This is the command launchd invokes. It is NOT meant for humans to run
 * directly outside of local debugging; `adaria-ai start` is the usual
 * entry point. The process stays alive forever (KeepAlive=true in the
 * plist), handling SIGTERM/SIGINT for clean shutdown.
 */
import { loadConfig } from "../config/store.js";
import { createMessengerAdapter } from "../messenger/factory.js";
import { AgentCore } from "../agent/core.js";
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
    // daemon into a 30s respawn loop that floods daemon.err.log (M1
    // CLI review HIGH #1).
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

  const messenger = createMessengerAdapter(config);
  const agent = new AgentCore(messenger, config);

  await agent.start();
  logInfo("adaria-ai daemon started");

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo(`adaria-ai daemon received ${signal}, stopping...`);
    agent
      .stop()
      .then(() => {
        process.exit(0);
      })
      .catch((err: unknown) => {
        logError(
          `Shutdown error: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
