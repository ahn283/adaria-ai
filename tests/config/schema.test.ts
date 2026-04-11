import { describe, it, expect } from "vitest";
import { configSchema } from "../../src/config/schema.js";

const BASE = {
  slack: {
    botToken: "xoxb-fake",
    appToken: "xapp-fake",
    signingSecret: "secret",
  },
  claude: {},
  security: {
    allowedUsers: ["U123"],
  },
};

describe("configSchema", () => {
  it("accepts a minimal valid config and fills defaults", () => {
    const parsed = configSchema.parse(BASE);
    expect(parsed.slack.botToken).toBe("xoxb-fake");
    expect(parsed.claude.mode).toBe("cli");
    expect(parsed.claude.cliBinary).toBe("claude");
    expect(parsed.claude.apiKey).toBeNull();
    expect(parsed.claude.timeoutMs).toBe(120_000);
    expect(parsed.security.dmOnly).toBe(false);
    expect(parsed.security.auditLog.enabled).toBe(true);
    expect(parsed.security.auditLog.maskSecrets).toBe(true);
    expect(parsed.safety.dangerousActionsRequireApproval).toBe(true);
    expect(parsed.safety.approvalTimeoutMinutes).toBe(30);
    expect(parsed.agent.showThinking).toBe(true);
    expect(parsed.agent.briefingChannel).toBeUndefined();
  });

  it("rejects config missing slack tokens", () => {
    const result = configSchema.safeParse({
      ...BASE,
      slack: { botToken: "", appToken: "", signingSecret: "" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects config missing slack section entirely", () => {
    const { slack: _slack, ...rest } = BASE;
    void _slack;
    const result = configSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects `claude.mode: 'api'` in M1 (only `cli` is implemented)", () => {
    // M1 claude review HIGH #1: the schema used to accept `mode: 'api'`
    // but the runner silently fell through to CLI, so any user who set
    // it in config.yaml got baffling behavior. The schema now refuses
    // 'api' at load time; a later milestone will reintroduce it when
    // the Anthropic SDK fallback runner lands.
    const result = configSchema.safeParse({
      ...BASE,
      claude: { mode: "api", apiKey: "sk-ant-xxx" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts briefingChannel when provided", () => {
    const parsed = configSchema.parse({
      ...BASE,
      agent: { briefingChannel: "#growth" },
    });
    expect(parsed.agent.briefingChannel).toBe("#growth");
  });

  it("rejects negative approval timeout", () => {
    const result = configSchema.safeParse({
      ...BASE,
      safety: { approvalTimeoutMinutes: -1 },
    });
    expect(result.success).toBe(false);
  });
});
