/**
 * Onboarding Skill — analyzes SDK funnel data, cohort retention,
 * generates hypotheses, and suggests review request timing.
 *
 * Ported from growth-agent `src/agents/onboarding-agent.js`.
 */

import type { Skill } from "./index.js";
import { parseAppNameFromCommand } from "./index.js";
import type {
  SkillContext,
  SkillResult,
  SkillAlert,
} from "../types/skill.js";
import type { AppConfig } from "../config/apps-schema.js";
import { upsertSdkEvent } from "../db/queries.js";
import { preparePrompt } from "../prompts/loader.js";
import { warn as logWarn } from "../utils/logger.js";

const DEFAULT_DROPOFF_THRESHOLD = 0.5;

const RETENTION_PERIODS = [
  { period: 7, index: 1 },
  { period: 14, index: 2 },
  { period: 28, index: 4 },
] as const;

interface FunnelStep {
  step: string;
  count: number;
  rate?: number;
  drop_rate?: number;
}

interface CohortEntry {
  cohort_size?: number;
  retention?: number[];
}

export interface OnboardingSkillDeps {
  sdkCollector: {
    getSummary: (appId: string, startDate: string, endDate: string) => Promise<Array<{ date: string; installs?: number; core_actions?: number; subscriptions?: number }>>;
    getFunnel: (appId: string, startDate: string, endDate: string) => Promise<{ funnel: FunnelStep[]; overall_conversion: number }>;
    getCohort: (appId: string, startDate: string, endDate: string, opts: { granularity: string }) => Promise<CohortEntry[]>;
  };
}

export class OnboardingSkill implements Skill {
  readonly name = "onboarding";
  readonly commands = ["onboarding"] as const;

  private readonly deps: OnboardingSkillDeps;

  constructor(deps: OnboardingSkillDeps) {
    this.deps = deps;
  }

  async dispatch(ctx: SkillContext, text: string): Promise<SkillResult> {
    const appName = parseAppNameFromCommand(text);
    const app = appName
      ? ctx.apps.find((a) => a.id.toLowerCase() === appName)
      : ctx.apps[0];

    if (!app) {
      return {
        summary: appName ? `❌ App "${appName}" not found.` : "❌ No apps configured.",
        alerts: [],
        approvals: [],
      };
    }

    const now = new Date();
    const endDate = now.toISOString().slice(0, 10);
    const startDate = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
    return this.analyzeOnboarding(ctx, app, startDate, endDate);
  }

  async analyzeOnboarding(
    ctx: SkillContext,
    app: AppConfig,
    startDate: string,
    endDate: string,
  ): Promise<SkillResult> {
    const alerts: SkillAlert[] = [];

    // 1. Collect summary → persist to DB
    await this.collectSummary(ctx, app, startDate, endDate);

    // 2. Funnel analysis
    const funnelData = await this.fetchFunnel(app, startDate, endDate);
    const funnel = this.simplifyFunnel(funnelData.funnel);
    const conversionRates = this.deriveConversionRates(funnelData.funnel);

    // 3. Dropoff alert
    const worst = this.findWorstDropoff(funnelData.funnel);
    if (worst && (worst.drop_rate ?? 0) > DEFAULT_DROPOFF_THRESHOLD) {
      alerts.push({
        severity: "high",
        message: `High dropoff at "${worst.step}": ${((worst.drop_rate ?? 0) * 100).toFixed(1)}%`,
      });
    }

    // 4. Cohort retention
    const cohortRetention = await this.analyzeCohortRetention(app, startDate, endDate);

    // 5. Hypotheses + SDK requests via Claude
    let hypotheses: Array<{ cause: string; suggestion: string }> = [];
    let sdkRequests: Array<{ event_name: string; purpose?: string; priority?: string; source?: string }> = [];
    if (funnelData.funnel.length > 0) {
      const analysis = await this.generateHypotheses(ctx, app, funnelData, conversionRates, cohortRetention);
      hypotheses = analysis.hypotheses;
      sdkRequests = analysis.sdkRequests;
    }

    // 6. Review request timing
    const reviewTiming = await this.suggestReviewRequestTiming(ctx, app, conversionRates, cohortRetention);

    // 7. SDK request approvals for the orchestrator pipeline
    const approvals: Array<{ id: string; description: string; agent: string; payload?: unknown }> = [];
    for (const req of sdkRequests) {
      approvals.push({
        id: `sdk-${app.id}-${req.event_name}`,
        description: `Add \`${req.event_name}\` event (${req.purpose ?? ""})`,
        agent: "sdk-request",
        payload: req,
      });
    }

    // 8. Summary
    const summary = this.buildSummary(
      app, alerts, funnel, conversionRates,
      funnelData.overall_conversion, cohortRetention, hypotheses, reviewTiming,
    );

    return { summary, alerts, approvals };
  }

  private async collectSummary(
    ctx: SkillContext,
    app: AppConfig,
    startDate: string,
    endDate: string,
  ): Promise<void> {
    try {
      const appId = app.eodinSdkAppId ?? app.id;
      const rows = await this.deps.sdkCollector.getSummary(appId, startDate, endDate);
      for (const row of rows) {
        if (!row.date) continue;
        if (typeof row.installs === "number") {
          upsertSdkEvent(ctx.db, { app_id: app.id, event_name: "install", count: row.installs, date: row.date });
        }
        if (typeof row.core_actions === "number") {
          upsertSdkEvent(ctx.db, { app_id: app.id, event_name: "signup", count: row.core_actions, date: row.date });
        }
        if (typeof row.subscriptions === "number") {
          upsertSdkEvent(ctx.db, { app_id: app.id, event_name: "subscription", count: row.subscriptions, date: row.date });
        }
      }
    } catch (err) {
      logWarn(`[onboarding] Summary fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async fetchFunnel(
    app: AppConfig,
    startDate: string,
    endDate: string,
  ): Promise<{ funnel: FunnelStep[]; overall_conversion: number }> {
    try {
      const appId = app.eodinSdkAppId ?? app.id;
      return await this.deps.sdkCollector.getFunnel(appId, startDate, endDate);
    } catch (err) {
      logWarn(`[onboarding] Funnel fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      return { funnel: [], overall_conversion: 0 };
    }
  }

  private simplifyFunnel(steps: FunnelStep[]) {
    if (!steps.length) return { install: 0, signup: 0, subscription: 0 };
    const stepCount = (...names: string[]) => {
      for (const name of names) {
        const match = steps.find((s) => s.step === name);
        if (match) return match.count;
      }
      return 0;
    };
    return {
      install: stepCount("app_install", "install"),
      signup: stepCount("core_action", "app_open"),
      subscription: stepCount("subscribe_start", "subscription"),
    };
  }

  private deriveConversionRates(steps: FunnelStep[]) {
    if (!steps.length) return { installToSignup: null as number | null, signupToSubscription: null as number | null };
    const stepCount = (...names: string[]) => {
      for (const name of names) {
        const match = steps.find((s) => s.step === name);
        if (match) return match.count;
      }
      return 0;
    };
    const install = stepCount("app_install", "install");
    const activation = stepCount("core_action", "app_open");
    const subscription = stepCount("subscribe_start", "subscription");
    return {
      installToSignup: install > 0 ? activation / install : null,
      signupToSubscription: activation > 0 ? subscription / activation : null,
    };
  }

  private findWorstDropoff(steps: FunnelStep[]): FunnelStep | null {
    if (steps.length <= 1) return null;
    return steps.slice(1).reduce<FunnelStep | null>(
      (worst, s) => (!worst || (s.drop_rate ?? 0) > (worst.drop_rate ?? 0) ? s : worst),
      null,
    );
  }

  private async analyzeCohortRetention(
    app: AppConfig,
    startDate: string,
    endDate: string,
  ): Promise<Array<{ period: number; cohortSize: number; retained: number; rate: number }> | null> {
    try {
      const appId = app.eodinSdkAppId ?? app.id;
      const cohorts = await this.deps.sdkCollector.getCohort(appId, startDate, endDate, { granularity: "weekly" });
      if (!cohorts?.length) return null;

      return RETENTION_PERIODS
        .map(({ period, index }) => {
          const valid = cohorts.filter(
            (c) => Array.isArray(c.retention) && c.retention[index] != null,
          );
          if (!valid.length) return null;

          const totalSize = valid.reduce((sum, c) => sum + (c.cohort_size ?? 0), 0);
          if (totalSize <= 0) return null;

          const weightedRetained = valid.reduce(
            (sum, c) => sum + (c.cohort_size ?? 0) * (c.retention![index]!),
            0,
          );

          return { period, cohortSize: totalSize, retained: Math.round(weightedRetained), rate: weightedRetained / totalSize };
        })
        .filter((c): c is NonNullable<typeof c> => c !== null);
    } catch (err) {
      logWarn(`[onboarding] Cohort analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private formatRate(rate: number | null): string {
    return rate != null ? (rate * 100).toFixed(1) + "%" : "N/A";
  }

  private formatCohortRetention(cohort: Array<{ period: number; rate: number; retained: number; cohortSize: number }> | null): string {
    if (!cohort?.length) return "No data";
    return cohort
      .map((c) => `- D${String(c.period)}: ${(c.rate * 100).toFixed(1)}% (${String(c.retained)}/${String(c.cohortSize)})`)
      .join("\n");
  }

  private formatFunnelTable(steps: FunnelStep[]): string {
    if (!steps.length) return "No data";
    return steps
      .map((s) => `- ${s.step}: ${String(s.count)} (rate ${((s.rate ?? 0) * 100).toFixed(1)}%, drop ${((s.drop_rate ?? 0) * 100).toFixed(1)}%)`)
      .join("\n");
  }

  private async generateHypotheses(
    ctx: SkillContext,
    app: AppConfig,
    funnelData: { funnel: FunnelStep[]; overall_conversion: number },
    conversionRates: { installToSignup: number | null; signupToSubscription: number | null },
    cohortRetention: Array<{ period: number; cohortSize: number; retained: number; rate: number }> | null,
  ): Promise<{ hypotheses: Array<{ cause: string; suggestion: string }>; sdkRequests: Array<{ event_name: string; purpose?: string; priority?: string; source?: string }> }> {
    const prompt = preparePrompt("onboarding-hypotheses", {
      appName: app.name,
      funnelTable: this.formatFunnelTable(funnelData.funnel),
      overallConversion: this.formatRate(funnelData.overall_conversion),
      installToSignup: this.formatRate(conversionRates.installToSignup),
      signupToSubscription: this.formatRate(conversionRates.signupToSubscription),
      cohortRetention: this.formatCohortRetention(cohortRetention),
    });

    try {
      const raw = await ctx.runClaude(prompt);
      const result = JSON.parse(raw) as {
        hypotheses?: Array<{ cause: string; suggestion: string }>;
        sdkRequests?: Array<{ event_name: string; purpose?: string; priority?: string; source?: string }>;
      };
      return {
        hypotheses: result.hypotheses ?? [],
        sdkRequests: (result.sdkRequests ?? []).map((r) => ({ ...r, source: "onboarding" })),
      };
    } catch {
      return { hypotheses: [], sdkRequests: [] };
    }
  }

  private async suggestReviewRequestTiming(
    ctx: SkillContext,
    app: AppConfig,
    conversionRates: { installToSignup: number | null; signupToSubscription: number | null },
    cohortRetention: Array<{ period: number; cohortSize: number; retained: number; rate: number }> | null,
  ): Promise<{ optimalTrigger?: string } | null> {
    const prompt = preparePrompt("onboarding-review-timing", {
      appName: app.name,
      installToSignup: this.formatRate(conversionRates.installToSignup),
      signupToSubscription: this.formatRate(conversionRates.signupToSubscription),
      cohortRetention: this.formatCohortRetention(cohortRetention),
    });

    try {
      const raw = await ctx.runClaude(prompt);
      return JSON.parse(raw) as { optimalTrigger?: string };
    } catch {
      return null;
    }
  }

  private buildSummary(
    app: AppConfig,
    alerts: SkillAlert[],
    funnel: { install: number; signup: number; subscription: number },
    conversionRates: { installToSignup: number | null; signupToSubscription: number | null },
    overallConversion: number,
    cohortRetention: Array<{ period: number; rate: number }> | null,
    hypotheses: Array<{ cause: string; suggestion: string }>,
    reviewTiming: { optimalTrigger?: string } | null,
  ): string {
    const header = alerts.length > 0
      ? `*🟡 [Action] Onboarding — ${app.name}*`
      : `*🟢 Onboarding — ${app.name}*`;

    const cr = conversionRates;
    const metricLines: string[] = [];

    if (cr.installToSignup !== null) {
      if (cr.installToSignup > 1) {
        metricLines.push(`• install ${String(funnel.install)} → activation ${String(funnel.signup)} (includes returning users)`);
      } else {
        metricLines.push(`• install → activation: \`${this.formatRate(cr.installToSignup)}\``);
      }
    }

    if (cr.signupToSubscription !== null) {
      if (cr.signupToSubscription > 1) {
        metricLines.push(`• activation ${String(funnel.signup)} → subscription ${String(funnel.subscription)}`);
      } else {
        metricLines.push(`• activation → subscription: \`${this.formatRate(cr.signupToSubscription)}\``);
      }
    }

    metricLines.push(`• overall conversion: \`${this.formatRate(overallConversion)}\``);

    if (cohortRetention?.length) {
      const d7 = cohortRetention.find((c) => c.period === 7);
      if (d7) metricLines.push(`• D7 retention: \`${(d7.rate * 100).toFixed(1)}%\``);
    }

    const blocks = [header];
    if (metricLines.length > 0) blocks.push(metricLines.join("\n"));

    if (hypotheses.length > 0) {
      const h = hypotheses[0]!;
      blocks.push(`*Likely cause:* ${h.cause}\n*→ Suggestion:* ${h.suggestion}`);
    }

    if (reviewTiming?.optimalTrigger) {
      blocks.push(`*Best review-request moment:* ${reviewTiming.optimalTrigger}`);
    }

    return blocks.join("\n\n");
  }
}
