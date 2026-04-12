/**
 * SDK Request Skill — formats and deduplicates SDK event tracking
 * requests from other agents.
 *
 * Ported from growth-agent `src/agents/sdk-request-agent.js`.
 * Pure logic — no external API calls.
 */

import type { Skill } from "./index.js";
import { parseAppNameFromCommand } from "./index.js";
import type {
  SkillContext,
  SkillResult,
  ApprovalItem,
} from "../types/skill.js";
import type { AppConfig } from "../config/apps-schema.js";

interface SdkRequest {
  event_name: string;
  params?: string;
  purpose?: string;
  priority?: string;
  source?: string;
}

export class SdkRequestSkill implements Skill {
  readonly name = "sdk-request";
  readonly commands = ["sdkrequest", "sdk-request"] as const;

  dispatch(ctx: SkillContext, text: string): Promise<SkillResult> {
    const appName = parseAppNameFromCommand(text);
    const app = appName
      ? ctx.apps.find((a) => a.id.toLowerCase() === appName)
      : ctx.apps[0];

    if (!app) {
      return Promise.resolve({
        summary: appName ? `❌ App "${appName}" not found.` : "❌ No apps configured.",
        alerts: [],
        approvals: [],
      });
    }

    return Promise.resolve({
      summary: `*📌 SDK requests — ${app.name}*\n• No pending requests (SDK requests are generated during weekly analysis)`,
      alerts: [],
      approvals: [],
    });
  }

  /**
   * Process SDK event requests from other skills.
   * Called by the weekly orchestrator with requests collected from
   * onboarding, review, and other skill results.
   */
  analyze(
    app: AppConfig,
    requests: SdkRequest[],
  ): SkillResult {
    if (!requests.length) {
      return { summary: "", alerts: [], approvals: [] };
    }

    const formatted = requests.map((req, i) => ({
      id: `sdk-${app.id}-${String(i + 1)}`,
      event_name: req.event_name,
      params: req.params ?? "",
      purpose: req.purpose ?? "",
      priority: req.priority ?? "medium",
      source: req.source ?? "unknown",
    }));

    // Deduplicate by event_name
    const unique: typeof formatted = [];
    const seen = new Set<string>();
    for (const req of formatted) {
      if (!seen.has(req.event_name)) {
        seen.add(req.event_name);
        unique.push(req);
      }
    }

    const approvals: ApprovalItem[] = unique.map((req) => ({
      id: req.id,
      description: `Add \`${req.event_name}\` event (${req.purpose})`,
      agent: "sdk-request",
      payload: req,
    }));

    const lines = [`*📌 SDK requests — ${app.name}*`];
    for (const req of unique.slice(0, 3)) {
      lines.push(`• Add \`${req.event_name}\` event (${req.purpose})`);
    }
    if (unique.length > 3) {
      lines.push(`• +${String(unique.length - 3)} more`);
    }

    return { summary: lines.join("\n"), alerts: [], approvals };
  }
}
