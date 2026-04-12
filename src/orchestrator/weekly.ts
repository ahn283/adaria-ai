/**
 * Weekly orchestrator.
 *
 * Ported from growth-agent `src/orchestrator.js`. Dispatches all skills
 * for each active app, assembles a WeeklyReport, sends a Slack Block Kit
 * briefing, and aggregates approval items.
 *
 * Invoked as a one-shot process by `adaria-ai analyze` (launchd cron
 * Sun 23:00 UTC). Must not leak event listeners or run an infinite loop.
 */

import type Database from "better-sqlite3";
import type { AppConfig } from "../config/apps-schema.js";
import type { AdariaConfig } from "../config/schema.js";
import type { SkillResult } from "../types/skill.js";
import type { MessengerAdapter } from "../messenger/adapter.js";
import {
  type AgentRunResult,
  type TimedResult,
  type WeeklyReport,
  SkippedAgentError,
} from "./types.js";
import { Dashboard } from "./dashboard.js";
import { insertAgentMetric, insertApproval } from "../db/queries.js";
import { writeAuditLog } from "../agent/audit.js";
import * as logger from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function timedRun<T>(fn: () => Promise<T>): Promise<TimedResult<T>> {
  const start = Date.now();
  try {
    const value = await fn();
    return { status: "fulfilled", value, durationMs: Date.now() - start };
  } catch (err) {
    return {
      status: "rejected",
      reason: err instanceof Error ? err : new Error(String(err)),
      durationMs: Date.now() - start,
    };
  }
}

function isSkipped(result: TimedResult): boolean {
  return (
    result.status === "rejected" &&
    result.reason instanceof SkippedAgentError
  );
}

function agentResult(prefix: string, result: TimedResult): AgentRunResult {
  if (result.status === "fulfilled" && result.value != null) {
    return result.value;
  }
  const reason = result.reason;
  if (reason instanceof SkippedAgentError) {
    return { summary: `\u23ed\ufe0f ${prefix} skipped: ${reason.message}` };
  }
  return {
    summary: `\ud83d\udd34 ${prefix} failed: ${reason?.message ?? "unknown error"}`,
  };
}

function formatAlert(appName: string, alert: Record<string, unknown>): string {
  const head = `*[${appName}]*`;
  const type = alert["type"] as string | undefined;

  switch (type) {
    case "high_dropoff": {
      const rate = `${(((alert["dropoff"] as number) ?? 0) * 100).toFixed(1)}%`;
      return `${head} Onboarding dropoff alert\n\u2022 Stage: \`${(alert["stage"] as string) ?? "unknown"}\`\n\u2022 Drop rate: \`${rate}\``;
    }
    case "rank_drop": {
      const prevRank = alert["previousRank"] as number | undefined;
      const currRank = alert["currentRank"] as number | undefined;
      return `${head} Keyword rank drop\n\u2022 "${alert["keyword"] as string}" ${prevRank != null ? String(prevRank) : "?"} \u2192 ${currRank != null ? String(currRank) : "?"}`;
    }
    case "negative_review_spike":
      return `${head} Negative review spike\n\u2022 Ratio: ${alert["ratio"] != null ? `${(((alert["ratio"] as number) ?? 0) * 100).toFixed(1)}%` : "N/A"}`;
    default:
      return `${head} ${type ?? "alert"}\n${Object.entries(alert)
        .filter(([k]) => k !== "type")
        .map(([k, v]) => `\u2022 ${k}: ${JSON.stringify(v)}`)
        .join("\n")}`;
  }
}

// ---------------------------------------------------------------------------
// Skill dispatch interface
// ---------------------------------------------------------------------------

/**
 * Dispatch interface injected into the weekly orchestrator. Each dispatch
 * function wraps a skill's `dispatch()` method with the right context.
 * This decouples the orchestrator from concrete skill constructors.
 */
export interface WeeklySkillDispatchers {
  aso: (app: AppConfig) => Promise<SkillResult>;
  review: (app: AppConfig) => Promise<SkillResult>;
  onboarding: (
    app: AppConfig,
    startDate: string,
    endDate: string,
  ) => Promise<SkillResult>;
  seoBlog: (app: AppConfig) => Promise<SkillResult>;
  shortForm: (app: AppConfig) => Promise<SkillResult>;
  sdkRequest: (app: AppConfig) => Promise<SkillResult>;
  content: (app: AppConfig) => Promise<SkillResult>;
  socialPublish: (app: AppConfig) => Promise<SkillResult>;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export interface WeeklyOrchestratorDeps {
  db: Database.Database;
  config: AdariaConfig;
  apps: AppConfig[];
  messenger: MessengerAdapter;
  dispatchers: WeeklySkillDispatchers;
}

export async function runWeeklyAnalysis(
  deps: WeeklyOrchestratorDeps,
): Promise<void> {
  const { db, config, apps, messenger, dispatchers } = deps;
  const channel = config.agent.briefingChannel;

  logger.info("Starting weekly growth analysis");
  await writeAuditLog({
    type: "execution",
    userId: "orchestrator",
    platform: "internal",
    content: "Weekly analysis started",
    metadata: { appCount: apps.length },
  });

  if (!channel) {
    logger.warn("No briefingChannel configured — briefing will not be posted");
  }

  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const nextDate = new Date(Date.now() + 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const dashboard = new Dashboard(db);

  for (const app of apps) {
    if (!app.active) continue;

    logger.info(`Analyzing ${app.name}`);

    const report: WeeklyReport = {
      appName: app.name,
      date: endDate,
      nextDate,
      aso: null,
      onboarding: null,
      reviews: null,
      sdkRequests: null,
      seoBlog: null,
      shortForm: null,
      content: null,
      socialPublish: null,
      webMetrics: null,
    };

    // Wave 1: ASO, Onboarding, Reviews (parallel).
    // timedRun never rejects, so Promise.all behaves like allSettled.
    const [asoResult, onboardingResult, reviewResult] = await Promise.all([
      timedRun(() => dispatchers.aso(app)),
      timedRun(() => dispatchers.onboarding(app, startDate, endDate)),
      timedRun(() => dispatchers.review(app)),
    ]);

    report.aso = agentResult("ASO analysis", asoResult);
    report.onboarding = agentResult("Onboarding analysis", onboardingResult);
    report.reviews = agentResult("Review analysis", reviewResult);

    // Record metrics for wave 1
    const wave1 = [
      { name: "aso", result: asoResult },
      { name: "onboarding", result: onboardingResult },
      { name: "review", result: reviewResult },
    ];
    for (const { name, result } of wave1) {
      if (isSkipped(result)) continue;
      recordMetric(db, app.id, name, result);
    }

    logAgentResults(app.name, wave1);

    // Wave 2: SEO Blog, Short-form, Content (parallel, may use wave 1 results)
    const [seoResult, shortFormResult, contentResult] = await Promise.all([
      timedRun(() => dispatchers.seoBlog(app)),
      timedRun(() => dispatchers.shortForm(app)),
      timedRun(() => dispatchers.content(app)),
    ]);

    report.seoBlog = agentResult("SEO blog", seoResult);
    report.shortForm = agentResult("Short-form", shortFormResult);
    report.content = agentResult("Content", contentResult);

    const wave2 = [
      { name: "seo-blog", result: seoResult },
      { name: "short-form", result: shortFormResult },
      { name: "content", result: contentResult },
    ];
    for (const { name, result } of wave2) {
      if (isSkipped(result)) continue;
      recordMetric(db, app.id, name, result);
    }

    logAgentResults(app.name, wave2);

    // SDK Requests — aggregated from onboarding
    const sdkRequestResult = await timedRun(() =>
      dispatchers.sdkRequest(app),
    );
    if (!isSkipped(sdkRequestResult)) {
      report.sdkRequests = agentResult("SDK requests", sdkRequestResult);
      recordMetric(db, app.id, "sdk-request", sdkRequestResult);
    }

    // Social publish — generate content for enabled platforms
    const socialResult = await timedRun(() =>
      dispatchers.socialPublish(app),
    );
    if (!isSkipped(socialResult)) {
      report.socialPublish = agentResult("Social publish", socialResult);
      recordMetric(db, app.id, "social-publish", socialResult);
    }

    // Send briefing
    if (channel) {
      try {
        logger.info(`Sending briefing for ${app.name}`);

        // Send combined briefing — Block Kit when available, plain text fallback
        const briefingText = formatBriefingText(report);
        if (messenger.sendBlocks) {
          const blocks = formatBriefingBlocks(report);
          await messenger.sendBlocks(channel, briefingText, blocks);
        } else {
          await messenger.sendText(channel, briefingText);
        }

        // Send alerts
        const allAlerts = [
          ...(report.aso?.alerts ?? []),
          ...(report.onboarding?.alerts ?? []),
          ...(report.reviews?.alerts ?? []),
        ];
        for (const alert of allAlerts) {
          const msg = formatAlert(app.name, alert as unknown as Record<string, unknown>);
          await messenger.sendText(channel, msg);
        }

        // Collect and send approval items.
        // NOTE(H1): Approval button clicks are handled by the daemon
        // process via messenger.onApproval(), not by the one-shot
        // analyze CLI. This is wired in daemon.ts (M7 prerequisite).
        const approvalItems = collectApprovalItems(report, app.id);
        for (const item of approvalItems) {
          await messenger.sendApproval(
            channel,
            `*[${item.agent}]* ${item.description}`,
            item.id,
          );
          insertApproval(db, {
            app_id: app.id,
            agent: item.agent,
            action: item.description,
            status: "pending",
            payload: item.payload ?? null,
          });
        }

        logger.info(`Briefing sent for ${app.name}`);
      } catch (err) {
        logger.error(
          `Notification failed for ${app.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Cross-app dashboard (if multiple apps)
  const activeApps = apps.filter((a) => a.active);
  if (activeApps.length > 1 && channel) {
    try {
      const dashResult = dashboard.generate(activeApps, startDate, endDate);
      if (dashResult.summary) {
        await messenger.sendText(channel, dashResult.summary);
      }
    } catch (err) {
      logger.error(
        `Dashboard generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  logger.info("Weekly analysis complete");
  await writeAuditLog({
    type: "result",
    userId: "orchestrator",
    platform: "internal",
    content: "Weekly analysis completed",
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function recordMetric(
  db: Database.Database,
  appId: string,
  agent: string,
  result: TimedResult,
): void {
  try {
    insertAgentMetric(db, {
      app_id: appId,
      agent,
      run_date: new Date().toISOString().slice(0, 10),
      duration_ms: result.durationMs,
      status: result.status === "fulfilled" ? "success" : "failure",
      alerts_count:
        result.status === "fulfilled"
          ? ((result.value as AgentRunResult)?.alerts?.length ?? 0)
          : 0,
      actions_count:
        result.status === "fulfilled"
          ? ((result.value as AgentRunResult)?.approvals?.length ?? 0)
          : 0,
    });
  } catch (err) {
    logger.error(
      `Metrics recording failed for ${agent}@${appId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function logAgentResults(
  appName: string,
  results: Array<{ name: string; result: TimedResult }>,
): void {
  for (const { name, result } of results) {
    if (result.status === "rejected" && !isSkipped(result)) {
      logger.error(
        `${name} failed for ${appName}: ${result.reason?.message ?? "unknown"}`,
      );
    } else if (isSkipped(result)) {
      logger.info(`${name} skipped for ${appName}: ${result.reason?.message ?? ""}`);
    } else {
      logger.info(`${name} completed for ${appName} (${String(result.durationMs)}ms)`);
    }
  }
}

function formatBriefingText(report: WeeklyReport): string {
  const sections: string[] = [
    `*\ud83d\udcca ${report.appName} Weekly Growth Report \u2014 ${report.date}*`,
    "",
  ];

  const parts: Array<{ label: string; data: AgentRunResult | null }> = [
    { label: "ASO", data: report.aso },
    { label: "Onboarding", data: report.onboarding },
    { label: "Reviews", data: report.reviews },
    { label: "SEO Blog", data: report.seoBlog },
    { label: "Short-form", data: report.shortForm },
    { label: "Content", data: report.content },
    { label: "Social", data: report.socialPublish },
  ];

  for (const p of parts) {
    if (!p.data) continue;
    sections.push(`*${p.label}*`);
    sections.push(p.data.summary);
    sections.push("");
  }

  sections.push(`_Next analysis: ${report.nextDate}_`);
  return sections.join("\n");
}

/** Slack Block Kit representation of the weekly briefing. */
function formatBriefingBlocks(
  report: WeeklyReport,
): Record<string, unknown>[] {
  const BLOCK_TEXT_LIMIT = 3000;
  const blocks: Record<string, unknown>[] = [];

  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: `\ud83d\udcca ${report.appName} Weekly Growth Report \u2014 ${report.date}`,
    },
  });

  const parts: Array<{ label: string; data: AgentRunResult | null }> = [
    { label: "ASO", data: report.aso },
    { label: "Onboarding", data: report.onboarding },
    { label: "Reviews", data: report.reviews },
    { label: "SEO Blog", data: report.seoBlog },
    { label: "Short-form", data: report.shortForm },
    { label: "Content", data: report.content },
    { label: "Social", data: report.socialPublish },
  ];

  for (const p of parts) {
    if (!p.data) continue;
    blocks.push({ type: "divider" });
    const text = `*${p.label}*\n${p.data.summary}`;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: text.length > BLOCK_TEXT_LIMIT
          ? text.slice(0, BLOCK_TEXT_LIMIT - 3) + "..."
          : text,
      },
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `_Next analysis: ${report.nextDate}_`,
      },
    ],
  });

  return blocks;
}

interface CollectedApproval {
  id: string;
  description: string;
  agent: string;
  payload?: unknown;
}

function collectApprovalItems(
  report: WeeklyReport,
  appId: string,
): CollectedApproval[] {
  const items: CollectedApproval[] = [];

  // Gather approvals from all skill results
  const skillResults: Array<{ agent: string; result: AgentRunResult | null }> =
    [
      { agent: "aso", result: report.aso },
      { agent: "review", result: report.reviews },
      { agent: "onboarding", result: report.onboarding },
      { agent: "seo-blog", result: report.seoBlog },
      { agent: "short-form", result: report.shortForm },
      { agent: "content", result: report.content },
      { agent: "sdk-request", result: report.sdkRequests },
      { agent: "social-publish", result: report.socialPublish },
    ];

  for (const { result } of skillResults) {
    if (!result?.approvals) continue;
    for (const approval of result.approvals) {
      items.push({
        id: `${approval.id}-${appId}`,
        description: approval.description,
        agent: approval.agent,
        payload: approval.payload,
      });
    }
  }

  return items;
}

// Exported for testing
export const _test = {
  timedRun,
  isSkipped,
  agentResult,
  formatAlert,
  formatBriefingText,
  formatBriefingBlocks,
  collectApprovalItems,
  recordMetric,
} as const;
