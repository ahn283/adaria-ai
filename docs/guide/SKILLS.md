# adaria-ai Skills Guide

## What is a skill?

A skill is a code-defined, domain-specific handler for explicit Slack commands (Mode A). Skills are heavy: they run collectors, call Claude, write to the database, and may produce approval-gated write actions.

**Skills are never exposed as MCP tools.** This is a load-bearing invariant.

## Skill interface

```typescript
interface Skill {
  readonly name: string;
  readonly commands: readonly string[];
  dispatch(ctx: SkillContext, text: string): Promise<SkillResult>;
}
```

### SkillContext

```typescript
interface SkillContext {
  db: Database.Database;       // SQLite handle
  apps: AppConfig[];           // From apps.yaml
  config: AdariaConfig;        // Full config
  runClaude: (prompt: string) => Promise<string>;  // Circuit-breaker-wrapped
}
```

### SkillResult

```typescript
interface SkillResult {
  summary: string;             // Slack mrkdwn
  alerts: SkillAlert[];        // Surfaced in weekly briefing
  approvals: ApprovalItem[];   // Block Kit approve/reject buttons
}
```

## Built-in skills (8)

| Skill | Commands | Reads from | Writes via (approval-gated) |
|-------|----------|------------|-----------------------------|
| AsoSkill | `aso` | ASOMobile, App Store Connect | `metadata_change` |
| ReviewSkill | `review`, `reviews` | App Store + Play Store reviews | `review_reply` |
| OnboardingSkill | `onboarding` | Eodin SDK (funnel, cohort) | - |
| SeoBlogSkill | `blog` | Eodin Blog + Search Console + GA4 | `blog_publish` |
| ShortFormSkill | `shortform`, `short-form` | YouTube Data API | - |
| SdkRequestSkill | `sdkrequest`, `sdk-request` | Eodin SDK requests | `sdk_request` |
| ContentSkill | `content` | - | - |
| SocialPublishSkill | `social`, `소셜`, `sns` | Past briefings, app metadata | `social_publish` |

## Adding a new skill

1. Create `src/skills/your-skill.ts` implementing the `Skill` interface
2. Register in `src/skills/registry.ts` inside `createProductionRegistry()`
3. If the skill has write paths:
   - Add a gate type to `ApprovalGate` in `src/agent/safety.ts`
   - Return `ApprovalItem[]` from `dispatch()`
   - Add an `executePost()` method for approval callbacks
4. Add prompts to `prompts/your-skill.md`
5. Write tests in `tests/skills/your-skill.test.ts`
6. Update the weekly orchestrator if the skill runs weekly

## Approval flow for write paths

1. `dispatch()` returns `ApprovalItem[]` with payload
2. `core.ts` sends Block Kit buttons and registers with `ApprovalManager`
3. User clicks Approve/Reject in Slack
4. If approved, `core.ts` calls the skill's `executePost(ctx, payload)`
5. Audit log records every step

## Prompts

Prompts live in `prompts/*.md` and are loaded by `src/prompts/loader.ts`:

```typescript
const prompt = preparePrompt("aso-metadata", {
  appName: app.name,
  keywords: rankings.join(", "),
});
const analysis = await ctx.runClaude(prompt);
```

Template variables use `{{varName}}` syntax.

## Testing

Every skill must have at least one unit test. Mock collectors and the `runClaude` function:

```typescript
const ctx: SkillContext = {
  db: initDatabase(":memory:"),
  apps: [testApp],
  config: testConfig,
  runClaude: vi.fn().mockResolvedValue("Claude response"),
};
const result = await skill.dispatch(ctx, "aso fridgify");
expect(result.summary).toContain("expected text");
```
