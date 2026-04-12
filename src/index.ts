#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { PACKAGE_JSON_PATH } from "./utils/paths.js";

interface PackageJson {
  version: string;
  description?: string;
}

const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")) as PackageJson;

const program = new Command();

program
  .name("adaria-ai")
  .description(
    pkg.description ??
      "Marketing operations agent for the Adaria.ai app portfolio",
  )
  .version(pkg.version);

program
  .command("init")
  .description("Interactive setup wizard")
  .action(async () => {
    const { runInit } = await import("./cli/init.js");
    await runInit();
    // Inquirer leaves readline handles open; force exit so launchd users
    // don't see a dangling process after init finishes.
    process.exit(0);
  });

program
  .command("daemon")
  .description("Run the reactive Slack daemon in foreground (launchd entry)")
  .action(async () => {
    const { runDaemon } = await import("./cli/daemon.js");
    await runDaemon();
  });

program
  .command("start")
  .description("Load the adaria-ai daemon into launchd")
  .action(async () => {
    const { runStart } = await import("./cli/start.js");
    await runStart();
  });

program
  .command("stop")
  .description("Unload the adaria-ai daemon from launchd")
  .action(async () => {
    const { runStop } = await import("./cli/stop.js");
    await runStop();
  });

program
  .command("status")
  .description("Show launchd status for the adaria-ai daemon")
  .action(async () => {
    const { runStatus } = await import("./cli/status.js");
    await runStatus();
  });

program
  .command("logs")
  .description("Print (or follow) ~/.adaria/logs/adaria-YYYY-MM-DD.log")
  .option("-f, --follow", "Follow log output")
  .action(async (opts: { follow?: boolean }) => {
    const { runLogs } = await import("./cli/logs.js");
    await runLogs(opts);
  });

program
  .command("analyze")
  .description("Run the weekly orchestrator (one-shot, launchd cron entry)")
  .action(async () => {
    const { runAnalyze } = await import("./cli/analyze.js");
    await runAnalyze();
  });

program
  .command("monitor")
  .description("Run the daily monitor (one-shot, launchd cron entry)")
  .action(async () => {
    const { runMonitorCmd } = await import("./cli/monitor-cmd.js");
    await runMonitorCmd();
  });

program
  .command("doctor")
  .description("Run health checks against config, Claude CLI, and allowlist")
  .action(async () => {
    const { runDoctor } = await import("./cli/doctor.js");
    await runDoctor();
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
