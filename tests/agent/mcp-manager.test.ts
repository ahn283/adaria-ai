import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_HOME = path.join(
  os.tmpdir(),
  `adaria-test-mcp-${String(process.pid)}-${Math.random().toString(36).slice(2, 8)}`,
);
process.env["ADARIA_HOME"] = TEST_HOME;

const { McpManager } = await import("../../src/agent/mcp-manager.js");
const { ADARIA_HOME } = await import("../../src/utils/paths.js");

describe("McpManager", () => {
  let mgr: InstanceType<typeof McpManager>;

  beforeAll(() => {
    fs.mkdirSync(TEST_HOME, { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(TEST_HOME, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  beforeEach(() => {
    mgr = new McpManager();
  });

  it("starts with zero registered tools", () => {
    expect(mgr.getToolCount()).toBe(0);
    expect(mgr.getRegisteredTools()).toEqual([]);
  });

  describe("registerTool", () => {
    it("registers a descriptor and exposes it by id", () => {
      mgr.registerTool({
        id: "db-query",
        name: "DB Query",
        description: "Run a whitelisted SELECT",
        inputSchema: { type: "object" },
      });
      expect(mgr.getToolCount()).toBe(1);
      expect(mgr.getTool("db-query")?.name).toBe("DB Query");
    });

    it("throws on duplicate id", () => {
      mgr.registerTool({
        id: "db-query",
        name: "DB Query",
        description: "x",
        inputSchema: {},
      });
      expect(() =>
        mgr.registerTool({
          id: "db-query",
          name: "Dup",
          description: "y",
          inputSchema: {},
        }),
      ).toThrow(/already registered/);
    });
  });

  describe("unregisterTool", () => {
    it("removes a previously registered tool", () => {
      mgr.registerTool({
        id: "app-info",
        name: "App Info",
        description: "Read apps.yaml",
        inputSchema: {},
      });
      expect(mgr.unregisterTool("app-info")).toBe(true);
      expect(mgr.getToolCount()).toBe(0);
    });

    it("returns false for an unknown id", () => {
      expect(mgr.unregisterTool("ghost")).toBe(false);
    });
  });

  describe("buildMcpContext", () => {
    it("returns empty string with no tools registered", () => {
      expect(mgr.buildMcpContext()).toBe("");
    });

    it("lists registered tools with the mcp__adaria__ prefix", () => {
      mgr.registerTool({
        id: "db-query",
        name: "DB Query",
        description: "Run a whitelisted SELECT against the adaria DB",
        inputSchema: {},
      });
      mgr.registerTool({
        id: "app-info",
        name: "App Info",
        description: "Read apps.yaml metadata",
        inputSchema: {},
      });
      const ctx = mgr.buildMcpContext();
      expect(ctx).toContain("MCP TOOLS AVAILABLE:");
      expect(ctx).toContain(
        "mcp__adaria__db-query — Run a whitelisted SELECT against the adaria DB",
      );
      expect(ctx).toContain("mcp__adaria__app-info — Read apps.yaml metadata");
    });

    it("warns that tools are read-only", () => {
      mgr.registerTool({
        id: "db-query",
        name: "DB Query",
        description: "x",
        inputSchema: {},
      });
      expect(mgr.buildMcpContext()).toContain("read-only");
    });
  });

  describe("buildMcpConfig", () => {
    it("returns null when no tools are registered (skip --mcp-config flag)", () => {
      expect(mgr.buildMcpConfig()).toBeNull();
    });

    it("returns an mcpServers object when tools are registered", () => {
      mgr.registerTool({
        id: "db-query",
        name: "DB Query",
        description: "x",
        inputSchema: {},
      });
      const cfg = mgr.buildMcpConfig();
      expect(cfg).not.toBeNull();
      expect(cfg).toHaveProperty("mcpServers");
    });
  });

  describe("writeMcpConfig", () => {
    it("returns null and writes no file when no tools are registered", async () => {
      const target = path.join(TEST_HOME, "mcp-config-empty.json");
      const result = await mgr.writeMcpConfig(target);
      expect(result).toBeNull();
      expect(fs.existsSync(target)).toBe(false);
    });

    it("writes a file at the given path when tools are registered", async () => {
      mgr.registerTool({
        id: "db-query",
        name: "DB Query",
        description: "x",
        inputSchema: {},
      });
      const target = path.join(TEST_HOME, "mcp-config-populated.json");
      const result = await mgr.writeMcpConfig(target);
      expect(result).toBe(target);
      expect(fs.existsSync(target)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(target, "utf-8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(parsed).toHaveProperty("mcpServers");
    });

    it("defaults to $ADARIA_HOME/mcp-config.json when no path is passed", async () => {
      mgr.registerTool({
        id: "db-query",
        name: "DB Query",
        description: "x",
        inputSchema: {},
      });
      const result = await mgr.writeMcpConfig();
      expect(result).toBe(path.join(ADARIA_HOME, "mcp-config.json"));
      expect(result).not.toBeNull();
      if (result) {
        expect(fs.existsSync(result)).toBe(true);
      }
    });
  });

  describe("checkMcpServerHealth", () => {
    it("returns an empty array in M1", async () => {
      expect(await mgr.checkMcpServerHealth()).toEqual([]);
    });
  });
});
