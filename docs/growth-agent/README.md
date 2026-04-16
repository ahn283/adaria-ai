# adaria-ai — v2 Porting Plan

**Target path:** `/Users/ahnwoojin/Github/adaria-ai` (empty git-ignored dir exists)
**Source 1 (runtime bones):** `/Users/ahnwoojin/Github/pilot-ai`
**Source 2 (marketing domain):** `/Users/ahnwoojin/growth-agent` (this repo)
**Current status:** Planning — no filesystem changes in `adaria-ai/` yet

## Why a new repo

`eodin-growth-agent` was built before we knew pilot-ai existed. Every recent
reliability improvement — spawn-based runner, session continuity, emoji
reactions, audit logs, circuit breaker, doctor command — has been a "why are
we reinventing pilot-ai" moment. The Phase 1 alignment work (2026-04-11) made
this explicit: the gap between growth-agent and pilot-ai's runtime is wide
enough that continued in-place fixes are more expensive than starting fresh
on pilot-ai's bones.

The new project:
- **Fork pilot-ai's runtime** — the `claude.ts` runner, `core.ts` message
  handler, `session.ts` store, `messenger/slack.ts`, the security and utils
  modules, the CLI commands (start/stop/status/logs/doctor/init)
- **Drop pilot-ai's personal-agent surface** — browser/figma/obsidian/notion/
  filesystem/vscode/calendar/google-auth **tool implementations**, project
  resolvers, multi-agent orchestration. None of that applies to growth
  marketing. **Keep the MCP framework itself** (`agent/mcp-manager.ts`,
  `agent/mcp-launcher.ts`, core.ts's tool-descriptions injection) so that
  conversational Slack mentions ("이번 주 리뷰 분위기 어때?") can route
  through Claude's tool use against marketing-domain read-only tools
- **Port growth-agent's domain logic as "skills"** — the 8 collectors, 11
  prompt templates, 7 analysis agents, approval manager, dashboard, daily
  monitor, weekly orchestrator
- **Keep the scheduler outside the daemon** — pilot-ai is reactive-only. We
  run the weekly analysis and daily monitor as separate launchd jobs that
  invoke `adaria-ai analyze` / `adaria-ai monitor` one-shot, instead of
  grafting a cron primitive onto the daemon

## Decisions taken

| # | Decision | Status |
|---|----------|--------|
| 1 | New repo at `/Users/ahnwoojin/Github/adaria-ai` | ✅ confirmed |
| 2 | Name: `adaria-ai` (aligns with Adaria.ai brand) | ✅ confirmed |
| 3 | TypeScript (pilot-ai is TS; the bones stay typed) | ✅ confirmed 2026-04-12 |
| 4 | Cron scheme: separate launchd jobs (daemon + weekly + monitor), not in-process scheduler | ✅ confirmed 2026-04-12 |
| 5 | `growth-agent` Phase 1: not in active use — adaria-ai goes live directly, no parallel run, no archive ceremony required (revised 2026-04-16) | ✅ revised 2026-04-16 |
| 6 | Migration strategy: M7 is a pre-launch smoke (doctor + brand E2E + one approval loop in DM); M8 flips `briefingChannel` to production. No `ADARIA_DRY_RUN` flag — approval gate is the only write barrier (revised 2026-04-16) | ✅ revised 2026-04-16 |
| 7 | Distribution: npm package — unscoped `adaria-ai`, public registry (name availability verified 2026-04-12) | ✅ confirmed |
| 8 | MCP framework: keep from pilot-ai, drop only personal-agent tool implementations, add marketing read-only tools in M5.5 | ✅ confirmed |
| 9 | Fork relationship: one-time copy from pilot-ai, then independent evolution — no upstream backport routine | ✅ confirmed |

All decisions above confirmed as of 2026-04-12. M0 is unblocked.

## Read order

1. `folder-structure.md` — what the new repo looks like on day 1
2. `porting-matrix.md` — file-by-file: what comes from pilot-ai, what comes
   from growth-agent, what's new, what gets dropped
3. `milestones.md` — week-by-week execution plan, exit criteria per milestone
4. `open-questions.md` — things I flagged as uncertain, grouped by priority

## Non-goals

- **Not a refactor of pilot-ai, and no upstream-sync routine.** adaria-ai
  copies files out once at M1 and then evolves independently. Bugs
  discovered after the fork are fixed in adaria-ai directly; pilot-ai is not
  monitored for backport-worthy changes.
- **Not a SaaS**. adaria-ai is a single-user launchd daemon, same shape as
  growth-agent today. The Adaria.ai SaaS product (`~/Github/adaria-new`) is
  a separate concern.
- **Not multi-user**. Slack allowlist stays. No tenancy.
- **No UI beyond Slack**. Dashboards stay as Slack-posted reports for now.
