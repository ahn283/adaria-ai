import { describe, it, expect } from "vitest";
import { buildToolHostServerConfig } from "../../src/agent/mcp-launcher.js";

describe("buildToolHostServerConfig", () => {
  it("uses process.execPath as the command", () => {
    const cfg = buildToolHostServerConfig({
      entryPoint: "/opt/adaria/dist/tools/host.js",
    });
    expect(cfg.command).toBe(process.execPath);
  });

  it("places the entry point as the first arg", () => {
    const cfg = buildToolHostServerConfig({
      entryPoint: "/opt/adaria/dist/tools/host.js",
    });
    expect(cfg.args).toEqual(["/opt/adaria/dist/tools/host.js"]);
  });

  it("appends extraArgs after the entry point", () => {
    const cfg = buildToolHostServerConfig({
      entryPoint: "/opt/adaria/dist/tools/host.js",
      extraArgs: ["--debug", "--verbose"],
    });
    expect(cfg.args).toEqual([
      "/opt/adaria/dist/tools/host.js",
      "--debug",
      "--verbose",
    ]);
  });

  it("omits env when the env map is empty", () => {
    const cfg = buildToolHostServerConfig({
      entryPoint: "/opt/adaria/dist/tools/host.js",
      env: {},
    });
    expect(cfg.env).toBeUndefined();
  });

  it("copies env when non-empty", () => {
    const cfg = buildToolHostServerConfig({
      entryPoint: "/opt/adaria/dist/tools/host.js",
      env: { ADARIA_HOME: "/tmp/adaria", NODE_ENV: "production" },
    });
    expect(cfg.env).toEqual({
      ADARIA_HOME: "/tmp/adaria",
      NODE_ENV: "production",
    });
  });

  it("returns a fresh env object (does not alias caller's map)", () => {
    const source = { ADARIA_HOME: "/tmp/adaria" };
    const cfg = buildToolHostServerConfig({
      entryPoint: "/opt/adaria/dist/tools/host.js",
      env: source,
    });
    source.ADARIA_HOME = "/mutated";
    expect(cfg.env?.["ADARIA_HOME"]).toBe("/tmp/adaria");
  });
});
