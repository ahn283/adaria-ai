/**
 * Daily monitor — threshold checks and alerts.
 *
 * Ported from growth-agent `src/monitor.js`. Runs 6 checks per active app
 * and fires alerts when thresholds are breached. One-shot: exits after
 * all checks are complete.
 *
 * Invoked by `adaria-ai monitor` (launchd cron daily 23:00 UTC).
 */

import type Database from "better-sqlite3";
import type { AppConfig } from "../config/apps-schema.js";
import type { AdariaConfig, ThresholdsConfig } from "../config/schema.js";
import type { MessengerAdapter } from "../messenger/adapter.js";
import type { MonitorAlert } from "./types.js";
import {
  getRecentKeywordRankings,
  getKeywordRankChange,
  getSentimentSummary,
  getRecentOneStarCount,
  getFunnelConversion,
  getSeoTotals,
  getWebTrafficTotals,
} from "../db/queries.js";
import { writeAuditLog } from "../agent/audit.js";
import * as logger from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface MonitorDeps {
  db: Database.Database;
  config: AdariaConfig;
  apps: AppConfig[];
  messenger: MessengerAdapter;
}

export async function runDailyMonitor(deps: MonitorDeps): Promise<void> {
  const { db, config, apps, messenger } = deps;
  const channel = config.agent.briefingChannel;
  const thresholds = config.thresholds;

  logger.info("Starting daily growth monitor");
  await writeAuditLog({
    type: "execution",
    userId: "monitor",
    platform: "internal",
    content: "Daily monitor started",
  });

  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const prevStart = new Date(Date.now() - 14 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const prevEnd = new Date(Date.now() - 8 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  for (const app of apps) {
    if (!app.active) continue;

    logger.info(`Checking ${app.name}`);
    const alerts: MonitorAlert[] = [];

    checkKeywordRanks(db, app, thresholds, alerts);
    checkNegativeReviewRatio(db, app, thresholds, alerts);
    checkOneStarReviews(db, app, thresholds, alerts);
    checkFunnelConversion(db, app, thresholds, alerts, startDate, endDate, prevStart, prevEnd);
    checkSeoMetrics(db, app, thresholds, alerts, startDate, endDate, prevStart, prevEnd);
    checkWebTraffic(db, app, thresholds, alerts, startDate, endDate, prevStart, prevEnd);

    // Send alerts
    if (channel) {
      for (const alert of alerts) {
        try {
          await messenger.sendText(channel, alert.message);
          logger.info(`Alert sent: ${alert.severity}`);
        } catch (err) {
          logger.error(
            `Alert send failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    if (alerts.length === 0) {
      logger.info(`${app.name}: All clear, no alerts`);
    } else {
      logger.info(`${app.name}: ${String(alerts.length)} alert(s) sent`);
    }
  }

  logger.info("Daily monitor complete");
  await writeAuditLog({
    type: "result",
    userId: "monitor",
    platform: "internal",
    content: "Daily monitor completed",
  });
}

// ---------------------------------------------------------------------------
// Threshold checks
// ---------------------------------------------------------------------------

function checkKeywordRanks(
  db: Database.Database,
  app: AppConfig,
  thresholds: ThresholdsConfig,
  alerts: MonitorAlert[],
): void {
  try {
    const rankings = getRecentKeywordRankings(db, app.id, 1);
    for (const ranking of rankings) {
      const change = getKeywordRankChange(
        db,
        app.id,
        ranking.keyword,
        ranking.platform,
      );
      if (change?.current_rank != null && change?.previous_rank != null) {
        const drop = change.current_rank - change.previous_rank;
        if (drop >= thresholds.keywordRankAlert) {
          alerts.push({
            severity: "critical",
            message: `\ud83d\udd34 [${app.name}] Keyword rank drop\n"${ranking.keyword}" (${ranking.platform}): ${String(change.previous_rank)} \u2192 ${String(change.current_rank)} (-${String(drop)})`,
          });
        }
      }
    }
  } catch (err) {
    logger.error(
      `Keyword check failed for ${app.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function checkNegativeReviewRatio(
  db: Database.Database,
  app: AppConfig,
  thresholds: ThresholdsConfig,
  alerts: MonitorAlert[],
): void {
  try {
    const sentiment = getSentimentSummary(db, app.id, 7);
    const total = sentiment.reduce((sum, s) => sum + s.count, 0);
    const negative =
      sentiment.find((s) => s.sentiment === "negative")?.count ?? 0;
    const ratio = total > 0 ? negative / total : 0;

    if (ratio > thresholds.reviewSentimentAlert) {
      alerts.push({
        severity: "critical",
        message: `\ud83d\udd34 [${app.name}] Negative review ratio ${(ratio * 100).toFixed(0)}% (threshold: ${(thresholds.reviewSentimentAlert * 100).toFixed(0)}%)`,
      });
    }
  } catch (err) {
    logger.error(
      `Review check failed for ${app.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function checkOneStarReviews(
  db: Database.Database,
  app: AppConfig,
  thresholds: ThresholdsConfig,
  alerts: MonitorAlert[],
): void {
  try {
    const oneStarCount = getRecentOneStarCount(db, app.id, 1);
    if (oneStarCount >= thresholds.oneStarReviewAlert) {
      alerts.push({
        severity: "warning",
        message: `\ud83d\udfe1 [${app.name}] ${String(oneStarCount)} new 1-star reviews in the last 24h (threshold: ${String(thresholds.oneStarReviewAlert)})`,
      });
    }
  } catch (err) {
    logger.error(
      `1-star review check failed for ${app.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function checkFunnelConversion(
  db: Database.Database,
  app: AppConfig,
  thresholds: ThresholdsConfig,
  alerts: MonitorAlert[],
  startDate: string,
  endDate: string,
  prevStart: string,
  prevEnd: string,
): void {
  try {
    const currentFunnel = getFunnelConversion(db, app.id, startDate, endDate);
    const currentMap: Record<string, number> = {};
    for (const row of currentFunnel) {
      currentMap[row.event_name] = row.total;
    }

    const prevFunnel = getFunnelConversion(db, app.id, prevStart, prevEnd);
    const prevMap: Record<string, number> = {};
    for (const row of prevFunnel) {
      prevMap[row.event_name] = row.total;
    }

    // Install → Signup conversion drop
    const currInstall = currentMap["install"] ?? 0;
    const currSignup = currentMap["signup"] ?? 0;
    const prevInstall = prevMap["install"] ?? 0;
    const prevSignup = prevMap["signup"] ?? 0;

    const currRate = currInstall > 0 ? currSignup / currInstall : 0;
    const prevRate = prevInstall > 0 ? prevSignup / prevInstall : 0;

    if (prevRate > 0 && currRate > 0) {
      const dropPct = (prevRate - currRate) / prevRate;
      if (dropPct > thresholds.installSignupDropAlert) {
        alerts.push({
          severity: "warning",
          message: `\ud83d\udfe1 [${app.name}] install\u2192activation conversion drop\n${(prevRate * 100).toFixed(1)}% \u2192 ${(currRate * 100).toFixed(1)}% (${(dropPct * 100).toFixed(0)}% decrease)`,
        });
      }
    }

    // Signup → Subscription conversion drop
    const currSub = currentMap["subscription"] ?? 0;
    const prevSub = prevMap["subscription"] ?? 0;
    const currSubRate = currSignup > 0 ? currSub / currSignup : 0;
    const prevSubRate = prevSignup > 0 ? prevSub / prevSignup : 0;

    if (prevSubRate > 0 && currSubRate > 0) {
      const dropPct = (prevSubRate - currSubRate) / prevSubRate;
      if (dropPct > thresholds.subscriptionDropAlert) {
        alerts.push({
          severity: "warning",
          message: `\ud83d\udfe1 [${app.name}] activation\u2192subscription conversion drop\n${(prevSubRate * 100).toFixed(1)}% \u2192 ${(currSubRate * 100).toFixed(1)}% (${(dropPct * 100).toFixed(0)}% decrease)`,
        });
      }
    }
  } catch (err) {
    logger.error(
      `Funnel check failed for ${app.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function checkSeoMetrics(
  db: Database.Database,
  app: AppConfig,
  thresholds: ThresholdsConfig,
  alerts: MonitorAlert[],
  startDate: string,
  endDate: string,
  prevStart: string,
  prevEnd: string,
): void {
  try {
    const currentSeo = getSeoTotals(db, startDate, endDate);
    const prevSeo = getSeoTotals(db, prevStart, prevEnd);

    if (
      prevSeo?.total_clicks != null &&
      prevSeo.total_clicks > 0 &&
      currentSeo?.total_clicks != null
    ) {
      const dropPct =
        (prevSeo.total_clicks - currentSeo.total_clicks) /
        prevSeo.total_clicks;
      if (dropPct > thresholds.seoClicksDropAlert) {
        alerts.push({
          severity: "warning",
          message: `\ud83d\udfe1 [${app.name}] SEO clicks drop\n${String(prevSeo.total_clicks)} \u2192 ${String(currentSeo.total_clicks)} (${(dropPct * 100).toFixed(0)}% decrease)`,
        });
      }
    }

    if (
      prevSeo?.total_impressions != null &&
      prevSeo.total_impressions > 0 &&
      currentSeo?.total_impressions != null
    ) {
      const dropPct =
        (prevSeo.total_impressions - currentSeo.total_impressions) /
        prevSeo.total_impressions;
      if (dropPct > thresholds.seoImpressionsDropAlert) {
        alerts.push({
          severity: "warning",
          message: `\ud83d\udfe1 [${app.name}] SEO impressions drop\n${String(prevSeo.total_impressions)} \u2192 ${String(currentSeo.total_impressions)} (${(dropPct * 100).toFixed(0)}% decrease)`,
        });
      }
    }
  } catch (err) {
    logger.error(
      `SEO check failed for ${app.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function checkWebTraffic(
  db: Database.Database,
  app: AppConfig,
  thresholds: ThresholdsConfig,
  alerts: MonitorAlert[],
  startDate: string,
  endDate: string,
  prevStart: string,
  prevEnd: string,
): void {
  try {
    const currentTraffic = getWebTrafficTotals(db, startDate, endDate);
    const prevTraffic = getWebTrafficTotals(db, prevStart, prevEnd);

    if (
      prevTraffic?.total_sessions != null &&
      prevTraffic.total_sessions > 0 &&
      currentTraffic?.total_sessions != null
    ) {
      const dropPct =
        (prevTraffic.total_sessions - currentTraffic.total_sessions) /
        prevTraffic.total_sessions;
      if (dropPct > thresholds.webTrafficDropAlert) {
        alerts.push({
          severity: "warning",
          message: `\ud83d\udfe1 [${app.name}] Web traffic drop\nSessions ${String(prevTraffic.total_sessions)} \u2192 ${String(currentTraffic.total_sessions)} (${(dropPct * 100).toFixed(0)}% decrease)`,
        });
      }
    }
  } catch (err) {
    logger.error(
      `Traffic check failed for ${app.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Exported for testing
export const _test = {
  checkKeywordRanks,
  checkNegativeReviewRatio,
  checkOneStarReviews,
  checkFunnelConversion,
  checkSeoMetrics,
  checkWebTraffic,
} as const;
