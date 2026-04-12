import { describe, it, expect } from "vitest";
import { SdkRequestSkill } from "../../src/skills/sdk-request.js";
import type { SkillContext } from "../../src/types/skill.js";
import type { AppConfig } from "../../src/config/apps-schema.js";

const testApp: AppConfig = {
  id: "fridgify", name: "Fridgify", platform: ["ios"],
  primaryKeywords: [], competitors: [], locale: ["en"],
  features: { fridgifyRecipes: false },
  social: { twitter: false, facebook: false, threads: false, tiktok: false, youtube: false, linkedin: false },
  active: true,
};

const dummyCtx = { apps: [testApp] } as unknown as SkillContext;

describe("SdkRequestSkill", () => {
  it("returns no-pending message in interactive mode", async () => {
    const skill = new SdkRequestSkill();
    const result = await skill.dispatch(dummyCtx, "sdkrequest fridgify");

    expect(result.summary).toContain("No pending requests");
  });

  it("formats and deduplicates SDK requests", () => {
    const skill = new SdkRequestSkill();
    const result = skill.analyze(testApp, [
      { event_name: "add_to_cart", purpose: "Track cart additions" },
      { event_name: "add_to_cart", purpose: "Duplicate" },
      { event_name: "checkout", purpose: "Track checkout" },
    ]);

    expect(result.approvals).toHaveLength(2); // deduplicated
    expect(result.summary).toContain("add_to_cart");
    expect(result.summary).toContain("checkout");
  });

  it("returns empty result for no requests", () => {
    const skill = new SdkRequestSkill();
    const result = skill.analyze(testApp, []);

    expect(result.summary).toBe("");
    expect(result.approvals).toHaveLength(0);
  });

  it("truncates summary at 3 requests", () => {
    const skill = new SdkRequestSkill();
    const result = skill.analyze(testApp, [
      { event_name: "e1", purpose: "p1" },
      { event_name: "e2", purpose: "p2" },
      { event_name: "e3", purpose: "p3" },
      { event_name: "e4", purpose: "p4" },
      { event_name: "e5", purpose: "p5" },
    ]);

    expect(result.summary).toContain("+2 more");
  });
});
