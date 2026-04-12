/**
 * skill-result MCP tool — read last-N weekly briefing blobs from
 * agent_metrics per app.
 */

import type Database from "better-sqlite3";
import type { McpToolImplementation } from "../agent/mcp-manager.js";
import { getAgentMetrics } from "../db/queries.js";

const ALLOWED_SKILLS = ["aso", "review", "onboarding", "seo-blog", "short-form", "sdk-request", "content"] as const;

const MAX_OUTPUT_BYTES = 10_240;

function truncateArray(data: unknown[]): unknown[] {
  let result = data;
  while (result.length > 0) {
    if (JSON.stringify(result).length <= MAX_OUTPUT_BYTES) return result;
    result = result.slice(0, Math.max(1, result.length - 1));
  }
  return result;
}

export function createSkillResultTool(db: Database.Database): McpToolImplementation {
  return {
    id: "skill-result",
    name: "Skill Result",
    description:
      "Read the last N weekly skill run results (agent_metrics) for an app. " +
      "Available skills: " + ALLOWED_SKILLS.join(", ") + ". " +
      "Use this to check how skills performed in recent weeks.",
    inputSchema: {
      type: "object",
      required: ["skill", "app"],
      properties: {
        skill: {
          type: "string",
          enum: [...ALLOWED_SKILLS],
          description: "Which skill's results to fetch.",
        },
        app: {
          type: "string",
          description: "App ID from apps.yaml.",
        },
        limit: {
          type: "number",
          description: "Number of recent results to return (default 5, max 20).",
        },
      },
    },
    handler: (input: unknown): Promise<unknown> => {
      if (!input || typeof input !== "object") {
        return Promise.resolve({ error: "Input must be an object with `skill` and `app` fields." });
      }
      const obj = input as Record<string, unknown>;
      if (typeof obj["skill"] !== "string" || typeof obj["app"] !== "string") {
        return Promise.resolve({ error: "Missing required fields: `skill` (string) and `app` (string)." });
      }
      const skill = obj["skill"];
      const appId = obj["app"];
      const limit = Math.min(typeof obj["limit"] === "number" ? obj["limit"] : 5, 20);

      if (!ALLOWED_SKILLS.includes(skill as typeof ALLOWED_SKILLS[number])) {
        return Promise.resolve({ error: `Unknown skill: "${skill}". Allowed: ${ALLOWED_SKILLS.join(", ")}` });
      }

      const rows = getAgentMetrics(db, appId, skill, limit * 7);
      const limited = rows.slice(0, limit);
      return Promise.resolve(truncateArray(limited));
    },
  };
}
