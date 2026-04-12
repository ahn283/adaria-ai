/**
 * collector-fetch MCP tool — cache-aware collector data retrieval.
 *
 * Returns the latest data from a named collector for a given app.
 * In M5.5, this queries the DB for cached data. Fresh API calls
 * are deferred to the orchestrator (M6).
 */

import type Database from "better-sqlite3";
import type { McpToolImplementation } from "../agent/mcp-manager.js";
import {
  getRecentKeywordRankings,
  getRecentReviews,
  getSentimentSummary,
  getRecentShortFormPerformance,
  getSeoMetricsByRange,
  getWebTrafficByRange,
  getRecentBlogPosts,
  type ReviewRow,
} from "../db/queries.js";

const ALLOWED_COLLECTORS = [
  "keyword-rankings",
  "reviews",
  "sentiment",
  "short-form",
  "seo-metrics",
  "web-traffic",
  "blog-posts",
] as const;

type CollectorName = typeof ALLOWED_COLLECTORS[number];

const MAX_OUTPUT_BYTES = 10_240;

function truncateArray(data: unknown[]): unknown[] {
  let result = data;
  while (result.length > 0) {
    if (JSON.stringify(result).length <= MAX_OUTPUT_BYTES) return result;
    result = result.slice(0, Math.max(1, result.length - 1));
  }
  return result;
}

/** Strip review body text to prevent PII leaks to Slack. */
function redactReviews(rows: ReviewRow[]): Array<Omit<ReviewRow, "body" | "reply_draft"> & { body: string; reply_draft: string }> {
  return rows.map((r) => ({ ...r, body: "[redacted]", reply_draft: "[redacted]" }));
}

function fetchCollectorData(
  db: Database.Database,
  collector: CollectorName,
  appId: string,
  days: number,
): unknown {
  const now = new Date();
  const startDate = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  switch (collector) {
    case "keyword-rankings":
      return getRecentKeywordRankings(db, appId, days);
    case "reviews":
      return redactReviews(getRecentReviews(db, appId, days));
    case "sentiment":
      return getSentimentSummary(db, appId, days);
    case "short-form":
      return getRecentShortFormPerformance(db, appId, days);
    case "seo-metrics":
      return getSeoMetricsByRange(db, startDate, endDate);
    case "web-traffic":
      return getWebTrafficByRange(db, startDate, endDate);
    case "blog-posts":
      return getRecentBlogPosts(db, appId, days);
  }
}

export function createCollectorFetchTool(db: Database.Database): McpToolImplementation {
  return {
    id: "collector-fetch",
    name: "Collector Fetch",
    description:
      "Fetch cached marketing data from the database for a specific app. " +
      "Available collectors: " + ALLOWED_COLLECTORS.join(", ") + ". " +
      "Review body text is redacted for privacy. " +
      "seo-metrics and web-traffic are site-wide (no app_id filter). " +
      "Use `days` to control the time window (default 7).",
    inputSchema: {
      type: "object",
      required: ["collector", "app"],
      properties: {
        collector: {
          type: "string",
          enum: [...ALLOWED_COLLECTORS],
          description: "Which collector data to fetch.",
        },
        app: {
          type: "string",
          description: "App ID from apps.yaml (e.g. 'fridgify').",
        },
        days: {
          type: "number",
          description: "Number of days to look back (default 7, max 90).",
        },
      },
    },
    handler: (input: unknown): Promise<unknown> => {
      if (!input || typeof input !== "object") {
        return Promise.resolve({ error: "Input must be an object with `collector` and `app` fields." });
      }
      const obj = input as Record<string, unknown>;
      if (typeof obj["collector"] !== "string" || typeof obj["app"] !== "string") {
        return Promise.resolve({ error: "Missing required fields: `collector` (string) and `app` (string)." });
      }
      const collector = obj["collector"];
      const appId = obj["app"];
      const days = Math.min(typeof obj["days"] === "number" ? obj["days"] : 7, 90);

      if (!ALLOWED_COLLECTORS.includes(collector as CollectorName)) {
        return Promise.resolve({ error: `Unknown collector: "${collector}". Allowed: ${ALLOWED_COLLECTORS.join(", ")}` });
      }

      const data = fetchCollectorData(db, collector as CollectorName, appId, days);
      const result = Array.isArray(data) ? truncateArray(data) : data;
      return Promise.resolve(result);
    },
  };
}
