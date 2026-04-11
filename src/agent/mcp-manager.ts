/**
 * MCP framework — minimal M1 skeleton.
 *
 * Pilot-ai's mcp-manager is scaffolded around installing third-party npm MCP
 * servers (Gmail, Slack, Figma) with Keychain-backed launcher scripts. None
 * of that applies to adaria-ai: our Mode B tools (`db-query`,
 * `collector-fetch`, `skill-result`, `app-info`) are in-process code that
 * ships with adaria-ai itself, not external packages the user installs.
 *
 * This file therefore carries only the shape M5.5 will need.
 *
 * ## Process-boundary note (M1 review H1)
 *
 * Claude CLI spawns the MCP server as a **separate subprocess** and talks
 * to it over stdio JSON-RPC. That means the daemon's `McpManager` and the
 * tool-host's registry live in different processes — a handler function
 * registered on the daemon's Map would never be callable by Claude.
 *
 * To keep this honest in the type system:
 *   - `McpToolDescriptor` is metadata only (id, name, description, schema).
 *     The daemon holds descriptors and uses them to build the system-prompt
 *     context and the `mcp-config.json` Claude consumes.
 *   - `McpToolImplementation extends McpToolDescriptor` and carries the
 *     `handler` function. It lives inside the tool-host subprocess (M5.5).
 *     The daemon never sees `handler` and therefore cannot mistakenly
 *     invoke it in-process.
 *
 * M1 exit criterion: the daemon boots with zero tools registered,
 * `buildMcpContext()` returns '', and `writeMcpConfig()` returns `null` so
 * `core.ts` can skip the `--mcp-config` flag entirely (mirrors pilot-ai's
 * `getMcpConfigPathIfExists` / `claude.ts` guard pattern).
 */
import fs from "node:fs/promises";
import path from "node:path";
// ADARIA_HOME is an eager const from paths.ts. Tests that need a custom
// $ADARIA_HOME set `process.env["ADARIA_HOME"]` before `await import()`-ing
// this module — same convention as session/audit/memory/logger.
import { ADARIA_HOME } from "../utils/paths.js";
import type { McpServerConfig } from "./mcp-launcher.js";

/** JSON Schema fragment describing an MCP tool's input object. */
export type McpInputSchema = Record<string, unknown>;

/**
 * Daemon-visible metadata for a single MCP tool. Handlers live in the
 * tool-host subprocess (see `McpToolImplementation`) and are dispatched
 * by `id`.
 */
export interface McpToolDescriptor {
  /** Stable identifier used in `mcp__adaria__<id>`. */
  id: string;
  /** Short human-readable name for the tool. */
  name: string;
  /** Description injected into Claude's system prompt. */
  description: string;
  /** JSON Schema describing the `input` object. */
  inputSchema: McpInputSchema;
}

/**
 * Tool-host-side type: metadata plus the in-process handler. M5.5's MCP
 * tool-host module will maintain its own registry of these and dispatch
 * JSON-RPC `tools/call` requests to the matching `handler`. The daemon's
 * `McpManager` never touches this type.
 */
export interface McpToolImplementation extends McpToolDescriptor {
  handler: (input: unknown) => Promise<unknown>;
}

/** Shape of the JSON config consumed by `claude --mcp-config <path>`. */
export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

export type McpServerStatus = "ready" | "error" | "not_registered";

export interface McpServerStatusResult {
  serverId: string;
  status: McpServerStatus;
  message?: string;
}

/**
 * Daemon-side registry of tool metadata. adaria-ai only ever spawns one
 * MCP server (the bundled marketing tool host), so tools are flat rather
 * than grouped per server.
 */
export class McpManager {
  private tools = new Map<string, McpToolDescriptor>();

  /** Register a tool descriptor. Throws on duplicate id. */
  registerTool(descriptor: McpToolDescriptor): void {
    if (this.tools.has(descriptor.id)) {
      throw new Error(`MCP tool already registered: ${descriptor.id}`);
    }
    this.tools.set(descriptor.id, descriptor);
  }

  unregisterTool(id: string): boolean {
    return this.tools.delete(id);
  }

  getTool(id: string): McpToolDescriptor | undefined {
    return this.tools.get(id);
  }

  getRegisteredTools(): McpToolDescriptor[] {
    return Array.from(this.tools.values());
  }

  getToolCount(): number {
    return this.tools.size;
  }

  /**
   * Builds the system-prompt text describing registered tools. Returns ''
   * when no tools are registered so callers can unconditionally concat
   * this into a larger system prompt.
   */
  buildMcpContext(): string {
    if (this.tools.size === 0) return "";

    const lines: string[] = [];
    lines.push("MCP TOOLS AVAILABLE:");
    lines.push(
      "These are read-only marketing tools. Use them to answer questions about apps, rankings, reviews, and prior analyses. They CANNOT write to the database or trigger skill write paths.",
    );
    lines.push("");
    for (const tool of this.getRegisteredTools()) {
      lines.push(`- mcp__adaria__${tool.id} — ${tool.description}`);
    }
    return lines.join("\n");
  }

  /**
   * Produces the `mcp-config.json` shape Claude CLI expects, or `null`
   * when there are no tools to expose. Mirrors pilot-ai's
   * `getMcpConfigPathIfExists` convention so `core.ts` can `if (path)`-
   * guard the `--mcp-config` flag and skip it entirely in M1.
   *
   * M5.5 will extend this to emit a single `adaria` server whose command
   * points at the bundled tool-host entry via `mcp-launcher`.
   */
  buildMcpConfig(): McpConfigFile | null {
    if (this.tools.size === 0) return null;
    // M5.5: populate mcpServers.adaria here once the tool-host entry
    // point is wired through mcp-launcher.buildToolHostServerConfig.
    return { mcpServers: {} };
  }

  /**
   * Writes the MCP config to disk at 0600 and returns the absolute path.
   * Returns `null` (without touching disk) when no tools are registered,
   * so core.ts can skip the `--mcp-config` flag.
   */
  async writeMcpConfig(outputPath?: string): Promise<string | null> {
    const config = this.buildMcpConfig();
    if (config === null) return null;
    const target = outputPath ?? path.join(ADARIA_HOME, "mcp-config.json");
    await fs.writeFile(target, JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
    return target;
  }

  /**
   * Health-check stub. In M1 this returns an empty array — there are no
   * servers to probe. M5.5 replaces this with a real stdio JSON-RPC ping
   * against the bundled adaria tool-host and wires it into
   * `adaria-ai doctor`.
   */
  // M5.5 will turn this into a real stdio JSON-RPC ping against the tool
  // host, which is genuinely I/O-bound; keeping the signature async now
  // avoids churning every caller when that lands.
  // eslint-disable-next-line @typescript-eslint/require-await
  async checkMcpServerHealth(): Promise<McpServerStatusResult[]> {
    return [];
  }
}
