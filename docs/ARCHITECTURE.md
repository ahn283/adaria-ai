# adaria-ai Architecture

## System overview

adaria-ai is a single-user, local-first marketing operations agent.
It runs as three macOS launchd processes and communicates exclusively via Slack.

```
Slack user  ──app_mention──▶  daemon (always-on)
                                 │
                       ┌─────────┴──────────┐
                   Mode A               Mode B
                (skill dispatch)    (Claude + MCP tools)
                       │                    │
                  skills/*.ts          tools/*.ts (read-only)
                       │                    │
               collectors/*.ts         SQLite DB
                       │
                  safety.ts (approval gates)
                       │
              Slack Block Kit buttons
```

Separately, two one-shot launchd jobs run on a schedule:

| Job | Schedule | Entry point |
|-----|----------|-------------|
| `com.adaria-ai.weekly` | Sun 23:00 UTC | `orchestrator/weekly.ts` |
| `com.adaria-ai.monitor` | Daily 23:00 UTC | `orchestrator/monitor.ts` |

## Two invocation modes

### Mode A — explicit command

```
@adaria-ai aso fridgify
```

1. `core.ts` receives the Slack event
2. `SkillRegistry.findSkill()` matches the first token
3. Skill dispatches: runs collectors, calls `ctx.runClaude()`, queries DB
4. Returns `SkillResult { summary, alerts, approvals }`
5. Approval items become Block Kit Approve/Reject buttons

### Mode B — conversational mention

```
@adaria-ai 이번 주 프리지파이 리뷰 어때?
```

1. No skill matches the first token
2. `core.ts` invokes Claude CLI with 4 read-only MCP tools registered
3. Claude decides which tool(s) to call (db-query, collector-fetch, etc.)
4. Claude composes the answer

**Critical invariant:** Skills are never exposed as MCP tools.
Mode B is strictly read-only.

## Module layout

```
src/
├── agent/          Core dispatch (core.ts), Claude runner, safety, sessions
├── cli/            Commander.js commands (init, daemon, start, stop, etc.)
├── collectors/     8 data source clients
├── config/         Zod schemas, YAML loader, keychain resolution
├── db/             SQLite schema (12 tables), prepared statement queries
├── messenger/      Slack adapter (Socket Mode + Bolt)
├── orchestrator/   Weekly briefing, daily monitor, dashboard
├── prompts/        Template loader for .md prompt files
├── security/       Auth allowlist, prompt injection defense (XML wrapping)
├── skills/         8 Mode A skills + registry
├── social/         6 platform clients (Twitter, Facebook, Threads, TikTok, YouTube, LinkedIn)
├── tools/          4 read-only MCP tools for Mode B
├── types/          Skill, collector type definitions
└── utils/          Logger, errors, retry, circuit breaker, rate limiter, paths
```

## Data flow

1. **Inbound:** Slack event → `SlackAdapter` → `AgentCore.handleMessage()`
2. **Auth:** `security/auth.ts` checks Slack user ID against allowlist
3. **Dispatch:** Mode A (skill registry) or Mode B (Claude CLI)
4. **Outbound:** `messenger.updateText()` or `messenger.sendBlocks()`
5. **Audit:** Every invocation logged to `~/.adaria/audit.jsonl`
6. **Sessions:** Thread ↔ Claude session map in `~/.adaria/sessions.json`

## Approval flow

Write actions (blog publish, metadata change, review reply, social publish)
route through `ApprovalManager` in `safety.ts`:

1. Skill produces `ApprovalItem[]` with payload
2. `core.ts` sends Block Kit buttons and registers with `ApprovalManager`
3. Approver clicks Approve → `handleResponse()` resolves
4. `core.ts.onApprovalResolved()` calls the skill's `executePost()` method
5. Audit log records the action

## Three-process deployment

```bash
adaria-ai start   # installs 3 launchd plists
adaria-ai stop    # unloads all 3
adaria-ai status  # checks all 3 labels
```

All runtime state lives in `~/.adaria/` (configurable via `ADARIA_HOME`).

## Key design decisions

- **No in-process cron.** Weekly and monitor are separate launchd jobs.
- **One-time fork from pilot-ai.** No upstream sync routine.
- **SQLite via better-sqlite3.** Prepared statements only, no string interpolation.
- **Config-driven thresholds.** Numbers live in `config.yaml`, not code.
- **`ADARIA_DRY_RUN=1`** disables all write paths (M7 parallel run safety).
