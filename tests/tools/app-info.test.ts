import { describe, it, expect } from "vitest";
import { createAppInfoTool } from "../../src/tools/app-info.js";
import type { AppConfig } from "../../src/config/apps-schema.js";

const testApps: AppConfig[] = [
  {
    id: "fridgify", name: "Fridgify", platform: ["ios", "android"],
    appStoreId: "123", playStorePackage: "com.eodin.fridgify",
    primaryKeywords: ["recipe"], competitors: ["comp1"], locale: ["en"],
    features: { fridgifyRecipes: true }, active: true,
  },
  {
    id: "arden", name: "Arden TTS", platform: ["ios"],
    primaryKeywords: ["tts"], competitors: [], locale: ["en"],
    features: { fridgifyRecipes: false }, active: true,
  },
];

describe("app-info tool", () => {
  it("lists all apps when no app ID provided", async () => {
    const tool = createAppInfoTool(testApps);
    const result = await tool.handler({}) as { appCount: number; apps: unknown[] };

    expect(result.appCount).toBe(2);
    expect(result.apps).toHaveLength(2);
  });

  it("returns detailed config for a specific app", async () => {
    const tool = createAppInfoTool(testApps);
    const result = await tool.handler({ app: "fridgify" }) as { id: string; primaryKeywords: string[] };

    expect(result.id).toBe("fridgify");
    expect(result.primaryKeywords).toEqual(["recipe"]);
  });

  it("returns error for unknown app", async () => {
    const tool = createAppInfoTool(testApps);
    const result = await tool.handler({ app: "nonexistent" }) as { error: string };

    expect(result.error).toContain("not found");
  });

  it("is case-insensitive for app ID", async () => {
    const tool = createAppInfoTool(testApps);
    const result = await tool.handler({ app: "FRIDGIFY" }) as { id: string };

    expect(result.id).toBe("fridgify");
  });
});
