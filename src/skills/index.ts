/**
 * Skill registry.
 *
 * A "skill" is a code-defined, domain-specific handler that reacts to
 * explicit Slack commands (Mode A). Skills are heavy, may gate write paths
 * through `ApprovalManager`, and are NOT exposed as MCP tools.
 *
 * M1 ships this registry with a set of placeholder skills so that
 * `core.handleMessage` can plumb Mode A dispatch end-to-end and return a
 * `(skill not implemented)` message for each known command word. M4 begins
 * replacing placeholders with real skill classes (`AsoSkill`, `ReviewSkill`,
 * etc.) in `src/skills/<name>.ts`; M5 finishes that transition and the
 * `createM1PlaceholderRegistry()` helper goes away.
 */

export interface Skill {
  /** Human-readable name (used in logs and placeholder responses). */
  readonly name: string;
  /**
   * Command words that trigger this skill when they appear as the first
   * whitespace-separated token of a Slack message (case-insensitive).
   */
  readonly commands: readonly string[];
  /**
   * Executes the skill. M4/M5 will thread a richer `SkillContext` through
   * here; for M1 placeholders the raw message text is enough.
   */
  dispatch(text: string): Promise<string>;
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

  getSkills(): readonly Skill[] {
    return this.skills;
  }

  getSkillCount(): number {
    return this.skills.length;
  }
}

class PlaceholderSkill implements Skill {
  constructor(
    readonly name: string,
    readonly commands: readonly string[],
  ) {}

  dispatch(_text: string): Promise<string> {
    return Promise.resolve(`(skill not implemented: ${this.name})`);
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
