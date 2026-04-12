/**
 * MCP tool host — stdio JSON-RPC server for Mode B tools.
 *
 * Claude CLI spawns this as a subprocess via `mcp-config.json`.
 * It speaks the MCP protocol: reads JSON-RPC requests from stdin,
 * dispatches to registered tool handlers, writes responses to stdout.
 *
 * This process opens its own SQLite connection and loads apps.yaml
 * because it runs in a separate process from the daemon.
 */

import { createInterface } from "node:readline";
import { initDatabase } from "../db/schema.js";
import { loadApps } from "../config/load-apps.js";
import { createDbQueryTool } from "./db-query.js";
import { createCollectorFetchTool } from "./collector-fetch.js";
import { createSkillResultTool } from "./skill-result.js";
import { createAppInfoTool } from "./app-info.js";
import type { McpToolImplementation } from "../agent/mcp-manager.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function respond(res: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(res) + "\n");
}

async function main(): Promise<void> {
  // Initialize DB + apps
  const db = initDatabase();
  const { apps } = await loadApps();

  // Register tools
  const tools = new Map<string, McpToolImplementation>();
  const toolList: McpToolImplementation[] = [
    createDbQueryTool(db),
    createCollectorFetchTool(db),
    createSkillResultTool(db),
    createAppInfoTool(apps),
  ];
  for (const tool of toolList) {
    tools.set(tool.id, tool);
  }

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line: string) => {
    void (async () => {
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        respond({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }

      const id = request.id ?? null;

      if (request.method === "initialize") {
        respond({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "adaria-tools", version: "0.1.0" },
          },
        });
        return;
      }

      if (request.method === "notifications/initialized") {
        // Client ack — no response needed for notifications
        return;
      }

      if (request.method === "tools/list") {
        respond({
          jsonrpc: "2.0",
          id,
          result: {
            tools: toolList.map((t) => ({
              name: t.id,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        });
        return;
      }

      if (request.method === "tools/call") {
        const toolName = request.params?.["name"] as string | undefined;
        const toolInput = request.params?.["arguments"] ?? {};

        if (!toolName) {
          respond({ jsonrpc: "2.0", id, error: { code: -32602, message: "Missing tool name" } });
          return;
        }

        const tool = tools.get(toolName);
        if (!tool) {
          respond({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${toolName}` } });
          return;
        }

        try {
          const result = await tool.handler(toolInput);
          respond({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
            },
          });
        } catch (err) {
          respond({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            },
          });
        }
        return;
      }

      respond({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${request.method}` } });
    })();
  });

  rl.on("close", () => {
    db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`[tool-host] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
