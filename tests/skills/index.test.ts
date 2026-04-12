import { describe, it, expect } from "vitest";
import {
  SkillRegistry,
  createM1PlaceholderRegistry,
  parseAppNameFromCommand,
  type Skill,
} from "../../src/skills/index.js";
import type { SkillContext } from "../../src/types/skill.js";

const dummyCtx = {} as SkillContext;

function fakeSkill(name: string, commands: string[]): Skill {
  return {
    name,
    commands,
    dispatch: (_ctx, text) =>
      Promise.resolve({ summary: `ran ${name} on ${text}`, alerts: [], approvals: [] }),
  };
}

describe("SkillRegistry", () => {
  it("starts empty", () => {
    const reg = new SkillRegistry();
    expect(reg.getSkillCount()).toBe(0);
    expect(reg.findSkill("aso fridgify")).toBeNull();
  });

  it("matches by first token, case-insensitive", () => {
    const reg = new SkillRegistry();
    reg.register(fakeSkill("aso", ["aso"]));
    expect(reg.findSkill("aso fridgify")?.name).toBe("aso");
    expect(reg.findSkill("ASO Fridgify")?.name).toBe("aso");
    expect(reg.findSkill("  aso  extra  ")?.name).toBe("aso");
  });

  it("returns null for messages whose first token matches no skill", () => {
    const reg = new SkillRegistry();
    reg.register(fakeSkill("aso", ["aso"]));
    expect(reg.findSkill("안녕")).toBeNull();
    expect(reg.findSkill("how's the weather?")).toBeNull();
    expect(reg.findSkill("")).toBeNull();
  });

  it("throws when the same command is registered twice", () => {
    const reg = new SkillRegistry();
    reg.register(fakeSkill("aso", ["aso"]));
    expect(() =>
      reg.register(fakeSkill("aso-v2", ["aso"])),
    ).toThrow(/already registered/);
  });

  it("allows registering a skill with multiple command aliases", () => {
    const reg = new SkillRegistry();
    reg.register(fakeSkill("review", ["review", "reviews"]));
    expect(reg.findSkill("review fridgify")?.name).toBe("review");
    expect(reg.findSkill("reviews fridgify")?.name).toBe("review");
  });
});

describe("createM1PlaceholderRegistry", () => {
  it("registers all seven placeholder skill command words", () => {
    const reg = createM1PlaceholderRegistry();
    const commands = [
      "aso", "review", "reviews", "onboarding", "blog",
      "shortform", "short-form", "sdkrequest", "sdk-request", "content",
    ];
    for (const cmd of commands) {
      const skill = reg.findSkill(cmd);
      expect(skill, `expected "${cmd}" to match`).not.toBeNull();
    }
  });

  it("every placeholder dispatch returns a (skill not implemented) message", async () => {
    const reg = createM1PlaceholderRegistry();
    for (const skill of reg.getSkills()) {
      const out = await skill.dispatch(dummyCtx, "test input");
      expect(out.summary).toMatch(/skill not implemented/);
      expect(out.summary).toContain(skill.name);
    }
  });

  it("registers exactly seven placeholder skills", () => {
    const reg = createM1PlaceholderRegistry();
    expect(reg.getSkillCount()).toBe(7);
  });
});

describe("parseAppNameFromCommand", () => {
  it("extracts second token as app name", () => {
    expect(parseAppNameFromCommand("aso fridgify")).toBe("fridgify");
    expect(parseAppNameFromCommand("ASO Arden")).toBe("arden");
  });

  it("returns undefined when no second token", () => {
    expect(parseAppNameFromCommand("aso")).toBeUndefined();
    expect(parseAppNameFromCommand("aso  ")).toBeUndefined();
  });
});
