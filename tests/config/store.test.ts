import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TEST_HOME = path.join(
  os.tmpdir(),
  `adaria-store-test-${String(process.pid)}-${Math.random().toString(36).slice(2, 8)}`
);
process.env["ADARIA_HOME"] = TEST_HOME;

const { loadConfig, saveConfig, configExists, ensureAdariaDir } = await import(
  "../../src/config/store.js"
);
const { CONFIG_PATH } = await import("../../src/utils/paths.js");

const VALID_CONFIG = {
  slack: {
    botToken: "xoxb-fake",
    appToken: "xapp-fake",
    signingSecret: "secret",
  },
  claude: {
    mode: "cli",
    cliBinary: "claude",
    apiKey: null,
  },
  security: {
    allowedUsers: ["U123"],
  },
};

describe("config store", () => {
  beforeAll(async () => {
    await fs.rm(TEST_HOME, { recursive: true, force: true });
  });

  afterAll(async () => {
    await fs.rm(TEST_HOME, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await fs.rm(TEST_HOME, { recursive: true, force: true });
  });

  it("ensureAdariaDir creates $ADARIA_HOME and subdirs with 0700", async () => {
    await ensureAdariaDir();
    const stat = await fs.stat(TEST_HOME);
    expect(stat.isDirectory()).toBe(true);
    // mode includes file type bits; mask to permission bits
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("configExists returns false when no config is written", async () => {
    await ensureAdariaDir();
    expect(await configExists()).toBe(false);
  });

  it("saveConfig writes YAML and configExists reports true", async () => {
    await saveConfig(VALID_CONFIG);
    expect(await configExists()).toBe(true);
    const content = await fs.readFile(CONFIG_PATH, "utf-8");
    expect(content).toContain("botToken: xoxb-fake");
    expect(content).toContain("allowedUsers:");
  });

  it("saved config file has 0600 permissions", async () => {
    await saveConfig(VALID_CONFIG);
    const stat = await fs.stat(CONFIG_PATH);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("saveConfig tightens pre-existing loose file perms (0644 → 0600)", async () => {
    // Simulate a config file that was created with a loose umask prior to
    // adaria-ai enforcing 0600 — `fs.writeFile({ mode })` alone would not
    // fix this on some platforms.
    await ensureAdariaDir();
    await fs.writeFile(CONFIG_PATH, "stale: true\n", { mode: 0o644 });
    await fs.chmod(CONFIG_PATH, 0o644);
    expect((await fs.stat(CONFIG_PATH)).mode & 0o777).toBe(0o644);

    await saveConfig(VALID_CONFIG);
    expect((await fs.stat(CONFIG_PATH)).mode & 0o777).toBe(0o600);
  });

  it("ensureAdariaDir tightens pre-existing loose dir perms (0755 → 0700)", async () => {
    await fs.mkdir(TEST_HOME, { recursive: true, mode: 0o755 });
    await fs.chmod(TEST_HOME, 0o755);
    expect((await fs.stat(TEST_HOME)).mode & 0o777).toBe(0o755);

    await ensureAdariaDir();
    expect((await fs.stat(TEST_HOME)).mode & 0o777).toBe(0o700);
  });

  it("loadConfig round-trips a saved config with defaults filled in", async () => {
    await saveConfig(VALID_CONFIG);
    const loaded = await loadConfig();
    expect(loaded.slack.botToken).toBe("xoxb-fake");
    expect(loaded.claude.mode).toBe("cli");
    expect(loaded.claude.timeoutMs).toBe(120_000);
    expect(loaded.security.allowedUsers).toEqual(["U123"]);
    expect(loaded.safety.dangerousActionsRequireApproval).toBe(true);
  });

  it("loadConfig throws ConfigError when file is missing", async () => {
    await ensureAdariaDir();
    await expect(loadConfig()).rejects.toThrow(/Configuration file not found/);
  });

  it("loadConfig throws ConfigError on schema violation and names the offending field", async () => {
    await saveConfig({ slack: { botToken: "" } } as Record<string, unknown>);
    // Zod should complain about the missing appToken and signingSecret, plus
    // the empty botToken — at least one of these must surface in the message
    // so the user knows which field to fix.
    await expect(loadConfig()).rejects.toThrow(/signingSecret|appToken|botToken/);
  });

  it("loadConfig defaults collectors to {} when the key is omitted", async () => {
    await saveConfig(VALID_CONFIG);
    const loaded = await loadConfig();
    expect(loaded.collectors).toEqual({});
  });

  it("loadConfig preserves plaintext collector credentials", async () => {
    await saveConfig({
      ...VALID_CONFIG,
      collectors: {
        eodinSdk: { apiKey: "plaintext-key" },
        ardenTts: { endpoint: "https://arden.example.com" },
      },
    });
    const loaded = await loadConfig();
    expect(loaded.collectors.eodinSdk?.apiKey).toBe("plaintext-key");
    expect(loaded.collectors.ardenTts?.endpoint).toBe(
      "https://arden.example.com"
    );
  });
});
