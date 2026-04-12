/**
 * db-query MCP tool — read-only access to whitelisted SQLite tables.
 *
 * Strictly read-only: SELECT only, no write paths. Table whitelist is
 * enforced at the tool level, not trust-based.
 */

import type Database from "better-sqlite3";
import type { McpToolImplementation } from "../agent/mcp-manager.js";

const MAX_ROWS = 50;
const MAX_OUTPUT_BYTES = 10_240; // 10 KB

/** Tables Claude is allowed to query. Anything not in this set is rejected. */
const ALLOWED_TABLES = new Set([
  "keyword_rankings",
  "sdk_events",
  "reviews",
  "approvals",
  "competitor_metadata",
  "agent_metrics",
  "blog_posts",
  "short_form_performance",
  "seo_metrics",
  "web_traffic",
  "blog_performance",
  "social_posts",
]);

/** Columns that must never be returned — contains raw user-authored text
 *  that could carry prompt injection or PII. */
const REDACTED_COLUMNS: Record<string, Set<string>> = {
  reviews: new Set(["body", "reply_draft"]),
  competitor_metadata: new Set(["description"]),
};

interface DbQueryInput {
  table: string;
  where?: Record<string, unknown> | undefined;
  orderBy?: string | undefined;
  limit?: number | undefined;
}

function validateInput(input: unknown): DbQueryInput {
  if (!input || typeof input !== "object") {
    throw new Error("Input must be an object with a `table` field.");
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj["table"] !== "string") {
    throw new Error("Missing required field: `table`.");
  }
  return {
    table: obj["table"],
    where: typeof obj["where"] === "object" && obj["where"] !== null
      ? obj["where"] as Record<string, unknown>
      : undefined,
    orderBy: typeof obj["orderBy"] === "string" ? obj["orderBy"] : undefined,
    limit: typeof obj["limit"] === "number" ? obj["limit"] : undefined,
  };
}

function buildQuery(params: DbQueryInput): { sql: string; bindings: unknown[] } {
  if (!ALLOWED_TABLES.has(params.table)) {
    throw new Error(
      `Table "${params.table}" is not in the whitelist. Allowed: ${[...ALLOWED_TABLES].join(", ")}`,
    );
  }

  // Determine which columns to select (exclude redacted ones)
  const redacted = REDACTED_COLUMNS[params.table];
  let selectClause = "*";
  if (redacted) {
    // We need to know actual columns — use a safe approach: SELECT all
    // then strip in post-processing. But for safety, we document that
    // the redaction happens at the result level.
    selectClause = "*";
  }

  const parts: string[] = [`SELECT ${selectClause} FROM ${params.table}`];
  const bindings: unknown[] = [];

  if (params.where && Object.keys(params.where).length > 0) {
    const conditions: string[] = [];
    for (const [key, value] of Object.entries(params.where)) {
      // Validate column name: letters, digits, underscores only
      if (!/^[a-zA-Z_]\w*$/.test(key)) {
        throw new Error(`Invalid column name in where clause: "${key}"`);
      }
      conditions.push(`${key} = ?`);
      bindings.push(value);
    }
    parts.push("WHERE " + conditions.join(" AND "));
  }

  if (params.orderBy) {
    // Validate: column name optionally followed by ASC/DESC
    if (!/^[a-zA-Z_]\w*(?:\s+(?:ASC|DESC))?$/i.test(params.orderBy)) {
      throw new Error(`Invalid orderBy: "${params.orderBy}". Use "column_name" or "column_name DESC".`);
    }
    parts.push(`ORDER BY ${params.orderBy}`);
  }

  const limit = Math.min(params.limit ?? MAX_ROWS, MAX_ROWS);
  parts.push(`LIMIT ${String(limit)}`);

  return { sql: parts.join(" "), bindings };
}

function redactRows(table: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const redacted = REDACTED_COLUMNS[table];
  if (!redacted) return rows;

  return rows.map((row) => {
    const clean = { ...row };
    for (const col of redacted) {
      if (col in clean) {
        clean[col] = "[redacted]";
      }
    }
    return clean;
  });
}

/** Truncate rows to stay under output byte limit. Removes rows from
 *  the end until the JSON representation fits. */
function truncateRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  let result = rows;
  while (result.length > 0) {
    const json = JSON.stringify(result);
    if (json.length <= MAX_OUTPUT_BYTES) return result;
    result = result.slice(0, Math.max(1, result.length - 1));
  }
  return result;
}

export function createDbQueryTool(db: Database.Database): McpToolImplementation {
  return {
    id: "db-query",
    name: "Database Query",
    description:
      "Query the adaria-ai marketing database. Read-only SELECT on whitelisted tables: " +
      [...ALLOWED_TABLES].join(", ") +
      ". Review body text and competitor descriptions are redacted. " +
      "Use this to answer questions about keyword rankings, reviews (counts/ratings only), " +
      "SDK events, blog posts, and performance metrics. Max 50 rows / 10KB output.",
    inputSchema: {
      type: "object",
      required: ["table"],
      properties: {
        table: {
          type: "string",
          enum: [...ALLOWED_TABLES],
          description: "The table to query.",
        },
        where: {
          type: "object",
          description: "Column equality filters, e.g. { app_id: 'fridgify', platform: 'ios' }",
        },
        orderBy: {
          type: "string",
          description: 'Column to sort by, optionally with ASC/DESC, e.g. "recorded_at DESC"',
        },
        limit: {
          type: "number",
          description: "Maximum rows to return (capped at 50).",
        },
      },
    },
    handler: (input: unknown): Promise<unknown> => {
      try {
        const params = validateInput(input);
        const { sql, bindings } = buildQuery(params);
        const rows = db.prepare(sql).all(...bindings) as Record<string, unknown>[];
        const redactedRows = redactRows(params.table, rows);
        return Promise.resolve({ rowCount: redactedRows.length, rows: truncateRows(redactedRows) });
      } catch (err) {
        return Promise.resolve({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

/** Exported for testing. */
export const _test = { ALLOWED_TABLES, REDACTED_COLUMNS, validateInput, buildQuery };
