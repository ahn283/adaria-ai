/**
 * Skill registry.
 *
 * A "skill" is a code-defined, domain-specific handler that reacts to
 * explicit Slack commands (Mode A). Skills are heavy, may gate write paths
 * through `ApprovalManager`, and are NOT exposed as MCP tools.
 *
 * M4 upgraded the Skill interface from `dispatch(text)` → `dispatch(ctx, text)`
 * with a `SkillResult` return type. PlaceholderSkill still exists for
 * skills not yet ported (M5 will remove it).
 */

import type {
  ContinuationMessage,
  SkillContext,
  SkillResult,
} from "../types/skill.js";

export interface Skill {
  /** Human-readable name (used in logs and Slack messages). */
  readonly name: string;
  /**
   * Command words that trigger this skill when they appear as the first
   * whitespace-separated token of a Slack message (case-insensitive).
   */
  readonly commands: readonly string[];
  /**
   * Executes the skill with the shared context and the raw message text.
   * The skill is responsible for parsing the app name from `text` and
   * looking it up in `ctx.apps`.
   */
  dispatch(ctx: SkillContext, text: string): Promise<SkillResult>;
  /**
   * Optional entry point for multi-turn skills. `core.ts` calls this
   * when an active `brand_flows` row matches the (userId, threadKey)
   * of the incoming message. Only BrandSkill implements it today.
   */
  continueFlow?(
    ctx: SkillContext,
    flowId: string,
    msg: ContinuationMessage,
  ): Promise<SkillResult>;
}

export class SkillRegistry {
  private skills: Skill[] = [];

  register(skill: Skill): void {
    for (const cmd of skill.commands) {
      if (this.findSkillByCommand(cmd)) {
        throw new Error(
          `SkillRegistry: command "${cmd}" is already registered to another skill`,
        );
      }
    }
    this.skills.push(skill);
  }

  /**
   * Returns the skill whose `commands` match the first token of `text`,
   * or `null` if no skill matches. Matching is case-insensitive.
   */
  findSkill(text: string): Skill | null {
    const firstToken = text.trim().toLowerCase().split(/\s+/)[0];
    if (!firstToken) return null;
    return this.findSkillByCommand(firstToken);
  }

  private findSkillByCommand(cmd: string): Skill | null {
    const lower = cmd.toLowerCase();
    return (
      this.skills.find((s) =>
        s.commands.some((c) => c.toLowerCase() === lower),
      ) ?? null
    );
  }

  /** Look up a registered skill by its `.name` field. */
  findSkillByName(name: string): Skill | null {
    return this.skills.find((s) => s.name === name) ?? null;
  }

  getSkills(): readonly Skill[] {
    return this.skills;
  }

  getSkillCount(): number {
    return this.skills.length;
  }
}

/**
 * Placeholder skill for commands not yet ported. Returns a clear
 * "not implemented" message so the operator can verify Mode A plumbing.
 * M5 removes this once all skills are real.
 */
export class PlaceholderSkill implements Skill {
  constructor(
    readonly name: string,
    readonly commands: readonly string[],
  ) {}

  dispatch(_ctx: SkillContext, _text: string): Promise<SkillResult> {
    return Promise.resolve({
      summary: `(skill not implemented: ${this.name})`,
      alerts: [],
      approvals: [],
    });
  }
}

/**
 * Builds an M1 placeholder registry. Every command word that M4–M6 will
 * eventually recognize is mapped to a no-op skill that returns a clear
 * "not implemented" message, so the operator can verify Mode A plumbing
 * (reactions, status evolution, audit log) before any real skill lands.
 */
export function createM1PlaceholderRegistry(): SkillRegistry {
  const registry = new SkillRegistry();
  registry.register(new PlaceholderSkill("aso", ["aso"]));
  registry.register(new PlaceholderSkill("review", ["review", "reviews"]));
  registry.register(new PlaceholderSkill("onboarding", ["onboarding"]));
  registry.register(new PlaceholderSkill("seo-blog", ["blog"]));
  registry.register(
    new PlaceholderSkill("short-form", ["shortform", "short-form"]),
  );
  registry.register(
    new PlaceholderSkill("sdk-request", ["sdkrequest", "sdk-request"]),
  );
  registry.register(new PlaceholderSkill("content", ["content"]));
  return registry;
}

/**
 * Parse the app name from the second token of a command string.
 * Returns `undefined` if no second token is present.
 *
 * Example: `"aso fridgify"` → `"fridgify"`
 */
export function parseAppNameFromCommand(text: string): string | undefined {
  const tokens = text.trim().split(/\s+/);
  return tokens[1]?.toLowerCase();
}
