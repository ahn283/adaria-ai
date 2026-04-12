/**
 * `adaria-ai analyze` — one-shot weekly orchestrator CLI entry.
 *
 * Loads config, initializes DB + collectors, runs the weekly orchestrator,
 * and exits cleanly. Invoked by launchd cron (Sun 23:00 UTC) or manually.
 */

import { loadConfig } from "../config/store.js";
import { loadApps } from "../config/load-apps.js";
import { initDatabase } from "../db/schema.js";
import { createMessengerAdapter } from "../messenger/factory.js";
import { runWeeklyAnalysis } from "../orchestrator/weekly.js";
import type { WeeklySkillDispatchers } from "../orchestrator/weekly.js";
import { ReviewSkill } from "../skills/review.js";
import { SocialPublishSkill } from "../skills/social-publish.js";
import { SeoBlogSkill } from "../skills/seo-blog.js";
import { ShortFormSkill } from "../skills/short-form.js";
import { SdkRequestSkill } from "../skills/sdk-request.js";
import { ContentSkill } from "../skills/content.js";
import { invokeClaudeCli } from "../agent/claude.js";
import { writeAuditLog } from "../agent/audit.js";
import * as logger from "../utils/logger.js";

export async function runAnalyze(): Promise<void> {
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

    // Build skill dispatchers with the weekly timeout
    const timeoutMs = config.agent.weeklyTimeoutMs;
    const cliBinary = config.claude.cliBinary;

    const runClaude = async (prompt: string): Promise<string> => {
      await writeAuditLog({
        type: "command",
        userId: "orchestrator",
        platform: "internal",
        content: `Claude CLI invocation (weekly, timeout=${String(timeoutMs)}ms)`,
      });
      const result = await invokeClaudeCli({
        prompt,
        cliBinary,
        timeoutMs,
      });
      return result.result;
    };

    const ctx = { db, apps, config, runClaude };

    // TODO(M7): Wire real collector instances from config.collectors
    // credentials. Currently skills run with empty deps — ASO/Onboarding
    // always reject, others skip collector-dependent paths. Required
    // before M7 parity validation.
    const reviewSkill = new ReviewSkill({});
    const seoBlogSkill = new SeoBlogSkill({});
    const shortFormSkill = new ShortFormSkill({});
    const sdkRequestSkill = new SdkRequestSkill();
    const contentSkill = new ContentSkill();
    const socialPublishSkill = new SocialPublishSkill({
      socialConfigs: {
        twitter: config.social.twitter,
        facebook: config.social.facebook,
        threads: config.social.threads,
        tiktok: config.social.tiktok,
        youtube: config.social.youtube,
        linkedin: config.social.linkedin,
      },
    });

    // Skills that require deps will throw if collectors are missing.
    // The orchestrator's timedRun catches these as SkippedAgentError.
    const dispatchers: WeeklySkillDispatchers = {
      aso: (_app) => Promise.reject(new Error("ASO collectors not wired in analyze CLI — use daemon for full analysis")),
      review: (app) => reviewSkill.dispatch(ctx, `review ${app.name}`),
      onboarding: (_app) => Promise.reject(new Error("Onboarding collector not wired in analyze CLI — use daemon for full analysis")),
      seoBlog: (app) => seoBlogSkill.dispatch(ctx, `blog ${app.name}`),
      shortForm: (app) => shortFormSkill.dispatch(ctx, `shortform ${app.name}`),
      sdkRequest: (app) => sdkRequestSkill.dispatch(ctx, `sdkrequest ${app.name}`),
      content: (app) => contentSkill.dispatch(ctx, `content ${app.name}`),
      socialPublish: (app) => socialPublishSkill.dispatch(ctx, `social ${app.name}`),
    };

    await runWeeklyAnalysis({
      db,
      config,
      apps,
      messenger,
      dispatchers,
    });

    logger.info("Weekly analysis finished successfully");
  } catch (err) {
    logger.error(
      `Weekly analysis failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  } finally {
    db.close();
    if (messenger) {
      await messenger.stop();
    }
  }
}
