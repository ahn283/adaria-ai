# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state: pre-M0 (planning only)

This repository contains **only planning documents** right now. There is no `package.json`, no `src/`, no tests, and no git history yet. The codebase described below is the target shape that M0–M9 will produce. When you start working here, the first task is almost always M0 bootstrap per `docs/growth-agent/checklist.md`.

Before doing anything substantive, read the planning docs in this order:

1. `docs/growth-agent/README.md` — why this project exists and the decisions ledger
2. `docs/growth-agent/prd.md` — product-level requirements and success criteria
3. `docs/growth-agent/folder-structure.md` — target file tree and invocation modes
4. `docs/growth-agent/porting-matrix.md` — file-by-file provenance (pilot-ai / growth-agent / new / dropped)
5. `docs/growth-agent/milestones.md` — M0–M9 execution plan with exit criteria and risk register
6. `docs/growth-agent/checklist.md` — actionable tick items per milestone
7. `docs/growth-agent/open-questions.md` — resolved decisions log (all P0/P1 closed)

These documents are **load-bearing**. They encode decisions the code must comply with. Treat contradictions between docs and user instructions as a reason to pause and ask, not drift.

## What this project is

adaria-ai is a single-user, local-first marketing operations agent running as a macOS launchd daemon. It is the successor to `eodin-growth-agent`, rebuilt on top of `pilot-ai`'s runtime bones (Claude CLI runner, session store, messenger, security, utils, MCP framework) plus growth-agent's domain logic (8 collectors, 7 skill agents, 11 prompt templates, approval gates, weekly/daily orchestrators).

Sources:
- `/Users/ahnwoojin/Github/pilot-ai` — runtime bones, copied at M1
- `/Users/ahnwoojin/growth-agent` — domain logic, ported at M2–M6

Target: single npm package `adaria-ai` (unscoped, public) installable via `npm install -g adaria-ai` on any macOS box.

## Big-picture architecture

### Two invocation modes

Every Slack event routes through `src/agent/core.ts` which dispatches to one of two modes. Understanding this split is essential for any change to `core.ts`, `src/skills/`, or `src/tools/`:

**Mode A — explicit command**
```
@adaria-ai aso fridgify  →  core.handleMessage  →  skills/index.ts registry
                                                  →  AsoSkill.dispatch(ctx, app)
                                                  →  collectors + claude.ts + Block Kit
```

**Mode B — conversational mention**
```
@adaria-ai 이번 주 리뷰 어때?  →  core.handleMessage (no command match)
                                  →  claude.ts with MCP tools registered
                                  →  Claude calls db-query / collector-fetch / skill-result / app-info
                                  →  Claude composes answer
```

**Critical invariant:** skills are never exposed as MCP tools. They are heavy and have approval-gated write paths. Only the 4 read-only tools in `src/tools/` are MCP-exposed. A PR that registers a skill as an MCP tool, or adds a write path to a tool, is a blocking issue.

### The three-process deployment

Cron is **not** in-process. `adaria-ai start` installs three separate launchd user agents:

| Label | Schedule | Command | Purpose |
|-------|----------|---------|---------|
| `com.adaria-ai.daemon` | Always-on, `KeepAlive` | `adaria-ai daemon` | Reactive Slack event handler |
| `com.adaria-ai.weekly` | Sun 23:00 UTC | `adaria-ai analyze` | Full weekly analysis → briefing |
| `com.adaria-ai.monitor` | Daily 23:00 UTC | `adaria-ai monitor` | Threshold alerts |

The `analyze` and `monitor` commands are **one-shot**: load config → init DB → init collectors → run orchestrator → exit cleanly. They must not leak event listeners or run an infinite loop.

### Write paths go through ApprovalManager

`src/agent/safety.ts` merges pilot-ai's ApprovalManager base with growth-agent's domain gates:
- `blog_publish` (before `EodinBlogPublisher.publish`)
- `metadata_change` (App Store / Play Store metadata)
- `review_reply` (posting to user reviews)
- `sdk_request`
- `social_publish` (before posting to any social media platform — Twitter, Facebook, Threads, TikTok, YouTube, LinkedIn)

Every skill write path produces a Block Kit approval message, waits for an allowlisted approver click, writes audit entry, then fires the action. No auto-apply.

### Social publishing (M6.5)

`SocialPublishSkill` generates platform-optimised marketing content via Claude and posts to 6 platforms. Platform clients live in `src/social/` (TypeScript, ported from `~/Github/linkgo/ai-service/src/social/` Python patterns). Each client implements a shared `SocialClient` interface from `src/social/base.ts`. All `post()` methods check `ADARIA_DRY_RUN`. Social credentials are stored in macOS Keychain under the `social:` config namespace.

### Fork relationship with pilot-ai

One-time copy at M1, then **no upstream-sync routine**. Post-fork improvements are made in adaria-ai directly, not backported. The README non-goal explicitly rejects this. A PR that claims "sync with pilot-ai upstream" should be pushed back on.

## Commands (once M0 lands)

Until M0 is done, none of these exist. After M0:

```bash
npm run build         # tsc
npm run lint          # eslint src/
npm test              # vitest
npm test -- <pattern> # run a single test file or matching tests
npm run dev           # tsc --watch (if added)
npm pack              # produce tarball for M9 smoke test; inspect with `tar -tzf`
```

Local CLI (after `npm run build`):

```bash
node dist/index.js --version
node dist/index.js doctor     # health checks (single source of truth for "is it working")
node dist/index.js daemon     # foreground daemon (launchd invokes this, not humans)
node dist/index.js analyze    # one-shot weekly orchestrator
node dist/index.js monitor    # one-shot daily monitor
```

After `npm install -g adaria-ai` (post-M9):

```bash
adaria-ai init        # interactive setup wizard — writes ~/.adaria/config.yaml
adaria-ai start       # load daemon + weekly + monitor launchd plists
adaria-ai stop        # unload all three
adaria-ai status      # state of all three launchd jobs
adaria-ai logs        # tail ~/.adaria/logs/
adaria-ai doctor      # health snapshot
```

To reproduce a failing cron run without waiting for the schedule:

```bash
launchctl kickstart -k gui/$UID/com.adaria-ai.weekly
launchctl kickstart -k gui/$UID/com.adaria-ai.monitor
```

## Runtime state lives outside the repo

All runtime state is written to `~/.adaria/` (override with `ADARIA_HOME` env var), not the install dir:

```
~/.adaria/
├── config.yaml          # written by `adaria-ai init`
├── apps.yaml            # user-edited — which apps to analyse + feature flags
├── sessions.json        # Slack thread ↔ Claude session map
├── audit.jsonl          # every Claude invocation, skill dispatch, approval
├── data/adaria.db       # SQLite
└── logs/                # daemon.{out,err}.log, weekly.*.log, monitor.*.log
```

**Never hardcode `~/.adaria/`** — always resolve through `src/utils/paths.ts`. The same module resolves bundled assets (prompts, launchd templates) via `import.meta.url`, which is essential for the npm global install to work on a fresh Mac. Any `process.cwd()` or relative path for bundled assets will break M9's second-Mac smoke test.

## Milestone-driven workflow

Work proceeds M0 → M9 in order. Each milestone in `docs/growth-agent/milestones.md` has explicit exit criteria that must pass before starting the next one. `checklist.md` has tick items per milestone.

When picking up work:
1. Identify which milestone the current state is on (read `checklist.md` progress tracker)
2. Read that milestone's section in `milestones.md` for exit criteria
3. Read the relevant `porting-matrix.md` rows to understand file provenance
4. Do the work following the per-change development loop below
5. Verify exit criteria before claiming the milestone is done

**Milestone fit matters during code review.** A M1 runtime import PR should not contain skill logic. A M5 skill PR should not touch `claude.ts`. The `senior-code-reviewer` agent checks this explicitly.

## Per-change development loop (mandatory order)

Every meaningful code change must pass through these six stages in order. Do not skip stages and do not reorder them. Each stage must pass (or be consciously waived with a note) before the next begins.

1. **Develop** — Write the code. Consult planning docs for the relevant milestone. Keep the change scoped to one milestone concern.
2. **Build** — Run `npm run build` and `npm run lint`. TypeScript must compile cleanly with `strict: true`. Lint must pass. Fix all errors before moving on; do not proceed with a dirty typecheck.
3. **Code review** — Invoke the `senior-code-reviewer` agent (Task tool with `subagent_type: senior-code-reviewer`, or the agent's slash command) on the change. Address every CRITICAL and HIGH finding before continuing. MEDIUM findings should be addressed or explicitly deferred with a note in the PR description.
4. **Unit test** — Run `npm test`. Add or update unit tests so that the new code path is covered. A change without a test is a change that can silently regress. For skills, mock collectors + runner; for MCP tools, cover whitelist rejection cases; for write paths, cover the approval gate.
5. **Checklist update** — Open `docs/growth-agent/checklist.md` and tick off the items you just completed. Update the progress tracker table at the bottom if the milestone advanced. If you discovered new work that belongs in a milestone, add it as a tick item rather than leaving it as tribal knowledge.
6. **Commit** — Conventional commits, English, one logical change per commit. Commit message should reference the milestone (`feat(m4): port AsoSkill from growth-agent`). Do not amend commits that have already been pushed or reviewed.

**Stopping rules inside the loop:**
- Build fails → stop, fix, retry. Never commit a broken build.
- Code review surfaces a CRITICAL or HIGH → fix it before tests; the fix may invalidate test coverage you just wrote.
- Tests fail → stop, fix the code (not the test), retry from stage 2 (build).
- Checklist can't be ticked because exit criteria aren't met → the change is incomplete; keep going, don't commit a half-done milestone item.

**When the loop legitimately compresses:**
- Doc-only changes (`docs/**`, `CLAUDE.md`, `.claude/**`): skip build + test, still do review + checklist update + commit.
- Config-only changes (`tsconfig.json`, `eslint.config.js`): build + review + commit; no tests needed.
- Emergency rollback (M8 failure): commit first to unblock, review and checklist post-hoc.

## Conventions

- **TypeScript strict, ESM, NodeNext.** Extensions in relative imports (`./foo.js` even when the source is `./foo.ts`).
- **Multi-app via `apps.yaml`.** All skills iterate over active apps. No app-specific hardcoded logic in `.ts` files. The Fridgify recipe branch in `src/skills/seo-blog.ts` is the only documented exception, guarded by `features.fridgify_recipes`.
- **Config-driven thresholds.** Numbers and strings that tune behaviour belong in `~/.adaria/config.yaml`, not in code.
- **SQLite via `better-sqlite3` prepared statements only.** No string interpolation in queries. Multi-table writes go through `db.transaction()`.
- **Approval-gated writes.** Any skill that wants to publish, update metadata, or reply to a user must route through `safety.ts`.
- **`ADARIA_DRY_RUN=1` must be respected by every write path.** This flag is set during M7 parallel run; write paths short-circuit and log what they would have done.
- **Commit messages:** conventional commits, English.

## M7 parallel run runbook (critical to remember)

During M7 (one week), adaria-ai and growth-agent run side-by-side. Two operational rules:

1. **Do not run `claude /login` during this week.** Both daemons share `~/.claude` auth state. Re-auth invalidates both.
2. **Do not commit to growth-agent during this week** except critical Slack-down fixes. Any improvement should go into adaria-ai directly.

Cutover at M8 has a 1-minute launchctl rollback path (unload adaria-ai plists, reload growth-agent plist). Keep it documented.

## The senior-code-reviewer agent

`.claude/agents/senior-code-reviewer.md` is adaria-ai-aware and knows about all of the above. Use it (or Task tool with `subagent_type: senior-code-reviewer`) for substantive code reviews. It produces reviews in `docs/code-reviews/review-YYYY-MM-DD-<topic>.md`.
