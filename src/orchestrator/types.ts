/**
 * Orchestrator types — shared across weekly.ts, monitor.ts, dashboard.ts.
 */

import type { SkillAlert, ApprovalItem } from "../types/skill.js";

/** Result of a single skill run within the orchestrator. */
export interface AgentRunResult {
  summary: string;
  alerts?: SkillAlert[];
  approvals?: ApprovalItem[];
}

/** Timing wrapper returned by `timedRun`. */
export interface TimedResult<T = AgentRunResult> {
  status: "fulfilled" | "rejected";
  value?: T;
  reason?: SkippedAgentError | Error;
  durationMs: number;
}

/** Sentinel error for cleanly skipping an agent with missing dependencies. */
export class SkippedAgentError extends Error {
  readonly skipped = true;
  constructor(reason: string) {
    super(reason);
    this.name = "SkippedAgentError";
  }
}

/** Web metrics collected from Eodin SEO + Analytics APIs. */
export interface WebMetrics {
  seoKeywords: SeoKeyword[];
  seoTotals: SeoTotals | null;
  blogPerformance: BlogPerfEntry[];
  trafficTotals: TrafficTotals | null;
  trafficSources: TrafficSource[];
}

export interface SeoKeyword {
  keyword: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SeoTotals {
  total_clicks: number | null;
  total_impressions: number | null;
  avg_ctr: number | null;
  avg_position: number | null;
}

export interface BlogPerfEntry {
  slug: string;
  total_pv: number;
  total_clicks: number;
  avg_duration: number;
  avg_bounce: number;
}

export interface TrafficTotals {
  total_pv: number | null;
  total_users: number | null;
  total_sessions: number | null;
  avg_bounce_rate: number | null;
}

export interface TrafficSource {
  channel: string;
  sessions: number;
  users: number;
}

/** Full weekly report for a single app. */
export interface WeeklyReport {
  appName: string;
  date: string;
  nextDate: string;
  aso: AgentRunResult | null;
  onboarding: AgentRunResult | null;
  reviews: AgentRunResult | null;
  sdkRequests: AgentRunResult | null;
  seoBlog: AgentRunResult | null;
  shortForm: AgentRunResult | null;
  content: AgentRunResult | null;
  webMetrics: WebMetrics | null;
}

/** Monitor alert produced by threshold checks. */
export interface MonitorAlert {
  severity: "critical" | "warning";
  message: string;
}
