import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

const TEST_HOME = path.join(
  os.tmpdir(),
  `adaria-test-doctor-${String(process.pid)}-${Math.random().toString(36).slice(2, 8)}`,
);
process.env["ADARIA_HOME"] = TEST_HOME;

// Mock claude CLI probes so tests don't shell out.
vi.mock("../../src/agent/claude.js", () => {
  return {
    checkClaudeCli: vi.fn(),
    checkClaudeCliAuth: vi.fn(),
    // The real module defines these but doctor.ts doesn't use them at
    // import time — leave them off the mock to keep it minimal.
  };
});

const { runDoctor } = await import("../../src/cli/doctor.js");
const { CONFIG_PATH } = await import("../../src/utils/paths.js");
const { checkClaudeCli, checkClaudeCliAuth } = await import(
  "../../src/agent/claude.js"
);

const checkClaudeCliMock = vi.mocked(checkClaudeCli);
const checkClaudeCliAuthMock = vi.mocked(checkClaudeCliAuth);

function writeConfig(partial: Record<string, unknown>): void {
  fs.mkdirSync(TEST_HOME, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, yaml.dump(partial), { mode: 0o600 });
}

function baseConfig(): Record<string, unknown> {
  return {
    slack: {
      botToken: "xoxb-fake-123",
      appToken: "xapp-fake-123",
      signingSecret: "secret",
    },
    claude: {
      mode: "cli",
      cliBinary: "claude",
      apiKey: null,
      timeoutMs: 120_000,
    },
    security: {
      allowedUsers: ["U_ALLOW"],
      dmOnly: false,
      auditLog: { enabled: true, maskSecrets: true },
    },
    safety: {
      dangerousActionsRequireApproval: true,
      approvalTimeoutMinutes: 30,
    },
    agent: { showThinking: true, weeklyTimeoutMs: 900_000 },
    thresholds: {},
    social: {},
    collectors: {},
  };
}

describe("runDoctor", () => {
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
    try {
      fs.rmSync(CONFIG_PATH, { force: true });
    } catch {
      // ignore
    }
    checkClaudeCliMock.mockReset();
    checkClaudeCliAuthMock.mockReset();
    process.exitCode = undefined;
  });

  it("passes with green output when config + claude are ready", async () => {
    writeConfig(baseConfig());
    checkClaudeCliMock.mockResolvedValue(true);
    checkClaudeCliAuthMock.mockResolvedValue(true);

    const captured: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        captured.push(args.map((a) => String(a)).join(" "));
      });
    await runDoctor();
    spy.mockRestore();

    const output = captured.join("\n");
    expect(output).toContain("checks passed");
    expect(output).not.toContain("❌");
    expect(process.exitCode).toBeUndefined();
  });

  it("fails when config is missing", async () => {
    checkClaudeCliMock.mockResolvedValue(true);
    checkClaudeCliAuthMock.mockResolvedValue(true);

    const captured: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        captured.push(args.map((a) => String(a)).join(" "));
      });
    await runDoctor();
    spy.mockRestore();

    const output = captured.join("\n");
    expect(output).toContain("❌");
    expect(output).toContain("config.yaml");
    expect(process.exitCode).toBe(1);
  });

  it("fails when the Claude CLI binary is missing", async () => {
    writeConfig(baseConfig());
    checkClaudeCliMock.mockResolvedValue(false);

    const captured: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        captured.push(args.map((a) => String(a)).join(" "));
      });
    await runDoctor();
    spy.mockRestore();

    const output = captured.join("\n");
    expect(output).toContain("claude CLI installed");
    expect(output).toContain("❌");
    expect(process.exitCode).toBe(1);
  });

  it("fails when the Claude CLI is installed but not authed", async () => {
    writeConfig(baseConfig());
    checkClaudeCliMock.mockResolvedValue(true);
    checkClaudeCliAuthMock.mockResolvedValue(false);

    const captured: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        captured.push(args.map((a) => String(a)).join(" "));
      });
    await runDoctor();
    spy.mockRestore();

    const output = captured.join("\n");
    expect(output).toContain("authenticated");
    expect(output).toContain("/login");
    expect(process.exitCode).toBe(1);
  });

  it("fails when the allowlist is empty", async () => {
    const cfg = baseConfig();
    (cfg["security"] as { allowedUsers: string[] }).allowedUsers = [];
    writeConfig(cfg);
    checkClaudeCliMock.mockResolvedValue(true);
    checkClaudeCliAuthMock.mockResolvedValue(true);

    const captured: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        captured.push(args.map((a) => String(a)).join(" "));
      });
    await runDoctor();
    spy.mockRestore();

    const output = captured.join("\n");
    expect(output).toContain("allowedUsers");
    expect(output).toContain("❌");
    expect(process.exitCode).toBe(1);
  });
});
