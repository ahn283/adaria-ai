import { describe, it, expect } from "vitest";
import {
  AdariaError,
  AuthError,
  ToolError,
  ConfigError,
  ExternalApiError,
  TimeoutError,
  getUserMessage,
} from "../../src/utils/errors.js";

describe("AdariaError", () => {
  it("has default code and userMessage", () => {
    const err = new AdariaError("something broke");
    expect(err.code).toBe("ADARIA_ERROR");
    expect(err.userMessage).toBe("something broke");
    expect(err.message).toBe("something broke");
    expect(err.name).toBe("AdariaError");
  });

  it("accepts custom code and userMessage", () => {
    const err = new AdariaError("internal details", {
      code: "CUSTOM",
      userMessage: "Something went wrong",
    });
    expect(err.code).toBe("CUSTOM");
    expect(err.userMessage).toBe("Something went wrong");
  });

  it("preserves cause", () => {
    const cause = new Error("original");
    const err = new AdariaError("wrapper", { cause });
    expect(err.cause).toBe(cause);
  });

  it("omits cause cleanly when not provided", () => {
    const err = new AdariaError("no cause");
    expect(err.cause).toBeUndefined();
  });
});

describe("AuthError", () => {
  it("has auth-specific defaults", () => {
    const err = new AuthError("token expired");
    expect(err.code).toBe("AUTH_ERROR");
    expect(err.userMessage).toContain("Authentication");
    expect(err.name).toBe("AuthError");
    expect(err).toBeInstanceOf(AdariaError);
  });
});

describe("ToolError", () => {
  it("has tool-specific defaults", () => {
    const err = new ToolError("something crashed");
    expect(err.code).toBe("TOOL_ERROR");
    expect(err.name).toBe("ToolError");
    expect(err).toBeInstanceOf(AdariaError);
  });
});

describe("ConfigError", () => {
  it("has config-specific defaults and references adaria-ai init", () => {
    const err = new ConfigError("missing field");
    expect(err.code).toBe("CONFIG_ERROR");
    expect(err.userMessage).toContain("adaria-ai init");
    expect(err).toBeInstanceOf(AdariaError);
  });
});

describe("ExternalApiError", () => {
  it("includes statusCode when provided", () => {
    const err = new ExternalApiError("API 429", { statusCode: 429 });
    expect(err.code).toBe("EXTERNAL_API_ERROR");
    expect(err.statusCode).toBe(429);
    expect(err).toBeInstanceOf(AdariaError);
  });

  it("allows statusCode to be undefined", () => {
    const err = new ExternalApiError("no status");
    expect(err.statusCode).toBeUndefined();
  });
});

describe("TimeoutError", () => {
  it("has timeout-specific defaults", () => {
    const err = new TimeoutError("15 min exceeded");
    expect(err.code).toBe("TIMEOUT_ERROR");
    expect(err.userMessage).toContain("timed out");
    expect(err).toBeInstanceOf(AdariaError);
  });
});

describe("getUserMessage", () => {
  it("returns userMessage for AdariaError", () => {
    const err = new AuthError("internal", { userMessage: "Please re-login" });
    expect(getUserMessage(err)).toBe("Please re-login");
  });

  it("returns message for regular Error", () => {
    expect(getUserMessage(new Error("oops"))).toBe("oops");
  });

  it("converts non-Error to string", () => {
    expect(getUserMessage("string error")).toBe("string error");
    expect(getUserMessage(42)).toBe("42");
  });
});
