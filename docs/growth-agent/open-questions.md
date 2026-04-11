# Open questions

Grouped by priority. Each question blocks at least one milestone.

## P0 — blocks M0

### OQ-1. TypeScript or JavaScript?

**Default: TypeScript.** Pilot-ai is TS; using JS would require translating
every copied file on the way in, which is pointless churn. Growth-agent's JS
collectors port to TS with ~10 min of annotations each. Vitest and ESLint
both work identically on `.ts`.

**Override cost:** roughly doubles M1 (need to strip TS from every pilot-ai
copy) with no tangible benefit.

Status: ✅ confirmed 2026-04-12.

### OQ-2. Scheduler: in-daemon or launchd?

**Default: launchd.** Two reasons:

1. **Separation of concerns.** The reactive Slack daemon only needs to
   handle `message` / `app_mention` events. Weekly analysis is long-running
   (~3-5 min per app × 3 apps) — running it inside the daemon blocks event
   handling and can starve Slack pings.
2. **Easier to debug.** A failed weekly run is a single `launchctl kickstart`
   away from reproduction; you see stdout/stderr directly in `adaria-ai
   analyze`, no daemon log filtering.

**Cost of default:** three plists to install instead of one. `init` wizard
has to write all three. Not hard.

**Override:** if the answer is "in-daemon," we port growth-agent's
`scheduler.js` to TS and add it to `core`. Adds ~0.5 day.

Status: ✅ confirmed 2026-04-12.

### OQ-3. Current growth-agent Phase 1: commit + freeze, or abandon?

**Default: commit + freeze.** The Phase 1 fix closed the silent-failure bug
in the currently-running daemon. If we abandon, the growth-agent daemon
either stays broken for the ~10 days it takes to reach M4 (dogfood cutover),
or we revert and live without the fix.

**Recommended sequence:**
1. Commit Phase 1 work to `growth-agent` today, push
2. Leave growth-agent daemon running as dogfood
3. Build adaria-ai in parallel
4. Cut over at M8

**Override:** if we abandon, I'd un-stage the Phase 1 diff, leaving
growth-agent in its broken state. Not recommended — no upside.

Status: ✅ confirmed 2026-04-12.

## P1 — blocks M3

### OQ-4. DB data migration?

Keep the existing growth-agent `.db` data (~1 week of keyword rankings,
reviews, SDK events, blog performance) or start fresh?

**Default: start fresh.** One week of data isn't load-bearing; the cost of
carrying potentially-drifted schema + data is higher than re-collecting.

**Override:** a one-shot migration script `scripts/migrate-from-growth-agent.ts`
that reads the old DB and writes the new one. Adds ~2 hours.

## P2 — blocks M5

### OQ-5. Skill interface shape

I sketched:

```ts
interface Skill {
  readonly name: string;
  readonly commands: string[];
  readonly schedule?: 'weekly' | 'daily';
  dispatch(ctx: SkillContext, app: AppConfig): Promise<SkillResult>;
}
```

Open sub-questions:

- Do skills receive previous skills' results via `ctx.prevResults`? SEO blog
  needs ASO + review outputs. Options:
  - (a) Inject via `ctx.prevResults` — skills declare dependencies
  - (b) Let the orchestrator call skills sequentially and pass whatever it
    wants — simpler but less reusable
- Are skills stateless, or can they hold instances (e.g. a `SdkRequestAgent`
  class with aggregation state)? The sketch assumes stateless + pure
  dispatch. Works for 6 of the 7 skills; `sdk-request` needs thought.

**Not urgent** — resolve during M4 (ASO skill port) based on what falls out.

## P3 — future

### OQ-6. Telegram messenger?

growth-agent has a Telegram notifier as a legacy path, disabled in prod.
adaria-ai could either:
- Port the Telegram adapter now (~0.5 day)
- Drop Telegram entirely
- Add back in Phase 2 if anyone asks

**Default: drop.** Nobody uses it. MessengerAdapter interface stays generic
so Telegram can be added later without refactor.

### OQ-7. Audit log format

Pilot-ai writes JSONL to `~/.pilot/audit.jsonl`. Growth-agent has no audit
log. adaria-ai should write JSONL — same format, easier to grep, no DB
table.

**Default: JSONL at `~/.adaria/audit.jsonl`, no rotation.** Add rotation
in Phase 2 if file grows unbounded.

### OQ-8. MCP servers — ✅ DECIDED (2026-04-12)

**Decision: keep pilot-ai's MCP framework (`mcp-manager.ts`, `mcp-launcher.ts`,
`tool-descriptions.ts`, core.ts injection path), drop only the personal-agent
tool implementations. Ship adaria-ai's own small set of read-only marketing
tools in M5.5.**

Rationale: Slack users don't always issue explicit commands. When someone
mentions `@adaria-ai` with a free-form question ("이번 주 프리지파이 리뷰
분위기 어때?"), there's no command prefix to match — core.ts needs to fall
through to Claude with tool access so it can fetch relevant data and compose
an answer. Re-implementing tool use via prompt-based routing is strictly
inferior to using the MCP framework that already exists in pilot-ai.

**Tool surface in v1 (four read-only tools, all in `src/tools/`):**

| Tool | Purpose |
|------|---------|
| `db-query` | Whitelisted SELECT against SQLite tables (reviews, keyword_rankings, sdk_events, blog_performance, short_form_performance, agent_metrics) |
| `collector-fetch` | Cache-aware fresh data fetch from a named collector |
| `skill-result` | Read last-N weekly briefing results per app |
| `app-info` | Read `apps.yaml` metadata — active apps, feature flags |

**Explicitly not exposed as MCP tools:**
- Skills themselves (heavy, have approval-gated write paths)
- Any write operation (blog publish, review reply, metadata change)
- Raw file system, shell, arbitrary HTTP

**Deferred to Phase 2:** third-party MCP servers (Google Ads, Search Console,
Apple Search Ads). Add when a skill genuinely needs autonomous Claude-driven
exploration of those APIs.

### OQ-9. Memory store

Pilot-ai has `~/.pilot/memory/` for Markdown-based long-term memory. Does
adaria-ai need it? Possible uses:

- Remember past briefing decisions ("we tried keyword X last month, didn't
  work — avoid suggesting it again")
- Remember user preferences ("Woojin wants review replies in a casual tone")

**Default: skip for v1.** If a use case emerges, port pilot-ai's memory
module — it's standalone.

## P1 — blocks M9

### OQ-10. npm package name + visibility

adaria-ai ships the same way pilot-ai does — `npm install -g adaria-ai` +
`adaria-ai init`. Four sub-decisions needed before M9:

**10a. Package name.** ✅ DECIDED (2026-04-12): **unscoped `adaria-ai`**.
Name availability confirmed via `npm view adaria-ai` → 404 Not Found.
Mirrors `pilot-ai` (currently at v0.5.28). Scoped fallback
`@adaria/adaria-ai` is also free if a company npm org is created later —
migration path is deprecate + republish under scope.

**10b. Public or private.** ✅ DECIDED (2026-04-12): **public.**
The code contains no secrets (all tokens live in `~/.adaria/config.yaml`
on the user's machine, never bundled). Private would add ongoing friction
(paid plan, auth) for marginal benefit.

**10c. Versioning + release cadence.**

- M0 ships `0.0.1` (not published, just a local `npm pack` verification)
- M9 publishes `0.1.0` (first real release, post-cutover)
- Semver thereafter. Conventional commits drive changelogs.

**10d. CI / publish automation.**

- M9 publishes manually from the dev box (with 2FA)
- Post-M9, wire GitHub Actions: on `v*` tag push, run `npm ci && npm run
  build && npm test && npm publish`. Requires `NPM_TOKEN` secret.
- Not blocking for M9 — first publish is manual. Automation is Phase 2.

Status: ✅ all four sub-decisions resolved. 10a/10b confirmed 2026-04-12,
10c/10d default. No blockers for M9.

---

## Assumptions I'm making unless told otherwise

1. Slack App: reuse the existing `Growth Agent` app, just point to the new
   bot in `init`. Same Bot Token + App Token.
2. Allowlist: same two users (U0A0UB94XRT, U0A15HYJBV2).
3. Channel: `#growth` — same as growth-agent.
4. Claude auth: existing `~/.claude` state via `/login`. No token work.
5. Repo visibility: private GitHub under `ahnwoojin`. No public open-source yet.
6. Node version: 20+ (same as growth-agent).
7. No TypeScript project references / monorepo. Single root `package.json`.
8. No Docker. launchd user agent only.
9. Tests: vitest, same config style as growth-agent.
10. Commit style: conventional commits, same as growth-agent.
11. Distribution: same as pilot-ai — `npm install -g adaria-ai` + `adaria-ai
    init`. No brew, no installer script, no Docker.
12. Runtime root: `~/.adaria/` (config, sessions, audit, SQLite, logs).
    Override via `ADARIA_HOME` env var — used by M7 parallel run to keep
    growth-agent and adaria-ai state fully isolated.
