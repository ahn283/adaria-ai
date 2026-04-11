# adaria-ai — milestones

Target: working dogfood daemon at M4, feature parity at M7, cutover at M8,
npm publish at M9. Estimate is "focused solo developer days" — real calendar
days depend on how much of each day is actually coding.

## M0 — Bootstrap (~0.5 day)

**Goal:** empty → compilable TypeScript project at `/Users/ahnwoojin/Github/adaria-ai`, npm-publishable shape from day 1.

- `git init`; `.gitignore` (node_modules, dist, .env, logs, *.db, .adaria/)
- `npm init -y` → edit `package.json`:
  - `name: "adaria-ai"` (or `@adaria/adaria-ai` once OQ-10 resolves)
  - `version: "0.0.1"`
  - `type: "module"`
  - `bin: { "adaria-ai": "./dist/index.js" }`
  - `files: ["dist/", "prompts/", "launchd/"]`
  - `engines: { "node": ">=20" }`
  - `scripts.build: "tsc"`, `scripts.test: "vitest"`, `scripts.lint: "eslint src/"`
  - `scripts.prepublishOnly: "npm run build && npm test"`
- `.npmignore` — excludes tests/, docs/, scripts/, .env*, apps.yaml, config.yaml
- Install deps: `typescript`, `@types/node`, `vitest`, `eslint`, `@slack/bolt`, `better-sqlite3`, `commander`, `js-yaml`, `inquirer`
- `tsconfig.json` (strict, module: NodeNext, target ES2022, outDir: dist)
- `eslint.config.js` (flat config, match growth-agent's)
- `src/index.ts` stub that prints version via `commander` and exits 0
- `src/utils/paths.ts` stub — resolves `ADARIA_HOME` (default `~/.adaria`), bundled prompts dir (`__dirname`-relative), launchd templates dir
- Smoke test locally: `npm pack` creates a tarball; inspect with `tar -tzf` — verify only `dist/`, `prompts/`, `launchd/`, package.json, README, LICENSE are inside
- `npm run build` compiles; `npm run lint` passes; `npm test` runs zero tests
- Commit: `chore: bootstrap adaria-ai TypeScript project`

**Exit criteria:** `npm pack` produces a valid tarball; `node dist/index.js --version` prints the version.

## M1 — Pilot-ai runtime import (~1.5 days)

**Goal:** the Slack daemon boots and replies to `@adaria-ai ping` via Claude CLI.

- Copy pilot-ai files per `porting-matrix.md`:
  - `src/agent/claude.ts` (adapted — 120s default timeout)
  - `src/agent/core.ts` (**major trim** — drop project resolver, pilot-ai's
    md-based skills loader, memory context, Google/GitHub checks, token
    refresher, permission watcher. **Keep** MCP context builder, tool
    descriptions injection, MCP server health checks — these power Mode B
    conversational routing. Keep auth, audit, reactions, session, error diff)
  - `src/agent/session.ts`, `memory.ts`, `conversation-summary.ts`, `safety.ts` (base)
  - `src/agent/mcp-manager.ts`, `mcp-launcher.ts` (framework only — no tool implementations yet)
  - `src/messenger/adapter.ts`, `slack.ts`, `split.ts`, `factory.ts`
  - `src/security/auth.ts`, `prompt-guard.ts`
  - `src/utils/*` (circuit-breaker, rate-limiter, logger, retry, escape, errors)
  - `src/cli/daemon.ts`, `start.ts`, `stop.ts`, `status.ts`, `logs.ts`, `init.ts`, `doctor.ts`
- Adapt `src/config/store.ts` to adaria-ai's config shape (Slack + Claude; no Google/GitHub/tools)
- Write `launchd/com.adaria-ai.daemon.plist.template` based on growth-agent's
- Rewire `core.handleMessage`:
  - **Mode A (command prefix matches):** dispatch into a **placeholder skill
    registry** that returns `"(skill not implemented)"` for every command
  - **Mode B (no command match):** fall through to Claude CLI with an **empty
    MCP tool list** in M1 (tools land in M5.5). The plumbing is verified here
    even though no tools exist yet — we want to catch issues with the MCP
    framework port early.
- `adaria-ai init` wizard: bot token, signing secret, app token, allowlist user ID
- `adaria-ai start` → launchctl load → daemon visible in `launchctl list`
- Slack workspace: reuse `Growth Agent` app or new workspace install
- Mention the bot → daemon routes to handleMessage → audit logged → claude runner called → response posted back

**Exit criteria:** Slack `@adaria-ai 안녕` returns a real Claude response with
🤔 → ✅ reactions and the status message evolves in place.

## M2 — Collector port (~1 day)

**Goal:** all 8 collectors callable from TypeScript with existing test coverage.

- Port `src/collectors/*.js` → `.ts`. Mostly type annotations on existing logic.
- Port matching `tests/collectors/*.test.js` → `.test.ts`. Vitest picks them up.
- For each collector: add return-type interfaces in `src/types/`
- Verify against real APIs with a smoke-test script (`scripts/smoke-collectors.ts`)
  — NOT part of CI, but run once manually

**Exit criteria:** `npm test` passes with all collector tests; a smoke test
hits each API and prints sample output.

## M3 — DB + config port (~0.5 day)

**Goal:** SQLite initialized, apps.yaml loaded, typed queries.

- Port `src/db/schema.ts` + `queries.ts`
- Port `src/config/load-apps.ts` + `load-config.ts`
- Decide DB path: `~/.adaria/data/adaria.db`
- Create tests/migration-smoke that spins up a fresh DB, runs v1-v5 migrations,
  reads out each table
- `apps.yaml` copied from growth-agent, verified with loader

**Exit criteria:** `adaria-ai doctor` reports "DB OK, 3 apps loaded (Fridgify,
Arden, Tempy)".

## M4 — First skill: ASO (~1.5 days)

**Goal:** end-to-end proof of the skill pattern.

- Write `src/skills/index.ts` skill registry + dispatch logic
- Port `src/skills/aso.ts` from `src/agents/aso-agent.js`:
  - Uses `AsoMobileCollector`, `AppStoreCollector`
  - Calls `runner.runClaude()` with the four ASO prompts
  - Returns `SkillResult { summary, alerts, approvals }`
- Hook into `core.handleMessage`: `@adaria-ai aso fridgify` → dispatch `AsoSkill`
- Tests: mock collectors, mock runner, verify dispatch builds the expected prompt inputs
- Format Slack response using Block Kit

**Exit criteria:** `@adaria-ai aso fridgify` returns the same analysis
growth-agent currently produces, formatted as a Slack message.

## M5 — Remaining skills (~2 days)

**Goal:** all 6 remaining skills running.

- Port `review.ts`, `onboarding.ts`, `seo-blog.ts`, `short-form.ts`,
  `sdk-request.ts`, `content.ts` (or fold content into short-form)
- Each gets a targeted test file
- For `seo-blog.ts`: port the Fridgify recipe branch + prompt sanitization
  (review C1 from Phase 1) — this is the highest-risk skill
- Approval gates hooked into `safety.ts`: blog_publish, metadata_change, review_reply

**Exit criteria:** `@adaria-ai blog fridgify` generates + stages blog posts
with approval buttons. Buttons approve → `EodinBlogPublisher.publish`.

## M5.5 — Conversational tools / Mode B (~0.5 day)

**Goal:** `@adaria-ai 이번 주 프리지파이 리뷰 분위기 어때?` gets a real
answer, composed by Claude calling read-only MCP tools against the DB and
collectors — without any explicit command.

- Implement `src/tools/db-query.ts`:
  - Input schema: `{ table: enum, where?: object, orderBy?: string, limit?: number }`
  - Whitelist tables explicitly; reject any other. No raw SQL pass-through.
  - Return JSON rows; truncate if >50 rows or >10KB.
- Implement `src/tools/collector-fetch.ts`:
  - Input schema: `{ collector: enum, app: string, fresh?: boolean }`
  - Cache-aware: if DB has a row newer than N minutes, return it; otherwise hit the API.
- Implement `src/tools/skill-result.ts`:
  - Read last-N weekly briefing JSON blobs from DB per app.
- Implement `src/tools/app-info.ts`:
  - Read parsed `apps.yaml` — active apps, features, metadata.
- Register these four tools with `mcp-manager.ts`; generate descriptions in `tool-descriptions.ts`.
- `core.ts` Mode B path: when no command matches, Claude CLI runs with the
  four tools available + a system prompt ("You are adaria-ai, a marketing
  analytics assistant for Fridgify / Arden / Tempy. Use tools to answer
  read questions. Never attempt writes; never guess data you can fetch.").
- Tests:
  - Unit: each tool rejects non-whitelisted inputs
  - Unit: `prompt-guard.ts` rejects attempts to bypass whitelist via description injection
  - Integration: a scripted mention produces a tool call + synthesised answer, verified against a fixture
- Update `doctor.ts` to list registered MCP tools and verify they start.

**Exit criteria:** Mention `@adaria-ai 이번 주 프리지파이 별점 1점 리뷰
몇 개야?` → Claude calls `db-query` on `reviews` table with the right
filter → posts the answer in Slack. No skill run involved.

## M6 — Orchestrators (~1 day)

**Goal:** weekly + daily analyses runnable end-to-end.

- Port `src/orchestrator/weekly.ts` from `src/orchestrator.js`:
  iterate active apps → dispatch weekly skills in parallel → assemble
  `WeeklyReport` → send Slack briefing → aggregate approvals
- Port `src/orchestrator/monitor.ts` from `src/monitor.js`: threshold checks → alerts
- Add `src/cli/analyze.ts` and `src/cli/monitor.ts` — one-shot CLI entries
  that load config, initialize DB + collectors, call the orchestrator, exit
- Write `launchd/com.adaria-ai.weekly.plist.template` (Sun 23:00 UTC)
- Write `launchd/com.adaria-ai.monitor.plist.template` (Daily 23:00 UTC)
- `adaria-ai start` installs all three plists

**Exit criteria:** `npx adaria-ai analyze` runs the full weekly analysis
against real data, sends the briefing to Slack. Manual trigger of the cron
plist via `launchctl kickstart` produces the same briefing.

## M7 — Parity + cutover prep (~1 day)

**Goal:** adaria-ai matches growth-agent's current capability. Cut over is safe.

- Run adaria-ai + growth-agent side-by-side for a week (adaria on a different
  Slack channel or with a DM-only allowlist, so briefings don't collide)
- Compare the Sunday briefings — every section should match within tolerance
- Verify approval buttons work end-to-end (blog publish, review reply)
- Port `doctor.ts` to cover the growth-marketing checks (App Store creds,
  Google Play, ASOMobile, SDK, Eodin Blog token, GA4, Search Console)
- Document `SETUP.md` + `ARCHITECTURE.md`
- Fix any regression delta discovered in the parallel run

**Exit criteria:** a full Sunday weekly run on adaria-ai produces a briefing
indistinguishable from growth-agent's — or we know exactly what's different
and why.

## M8 — Cutover (~0.5 day)

**Goal:** adaria-ai is the only live daemon.

- Stop growth-agent daemon via `./bin/daemon-ctl.sh stop`
- Unload its launchd plist
- Archive growth-agent repo (tag `v1-final`, README pointer to adaria-ai)
- Announce cutover in Slack
- Monitor first live weekly run on adaria-ai
- On success: commit the cutover to growth-agent as a `chore: archive repo` commit

**Exit criteria:** Monday morning Slack briefing comes from adaria-ai. No
more activity on growth-agent.

## M9 — npm publish (~0.5 day)

**Goal:** `npm install -g adaria-ai` works on a fresh Mac and reproduces the
local setup in ~5 minutes.

- Resolve OQ-10: public `adaria-ai` vs scoped `@adaria/adaria-ai`, npm org
  ownership, 2FA
- Verify `files` field in `package.json` ships exactly `dist/`, `prompts/`,
  `launchd/`, `README.md`, `LICENSE` — nothing else
- Verify runtime path resolution: `src/utils/paths.ts` must use `__dirname`
  / `import.meta.url` for bundled prompts and launchd templates, **never**
  relative paths from cwd
- Smoke test on a second Mac (or a fresh user account) — not just the dev box:
  ```
  npm install -g @anthropic-ai/claude-code
  claude /login
  npm install -g adaria-ai
  adaria-ai init
  adaria-ai doctor
  adaria-ai start
  ```
- If smoke test reveals path issues, fix and republish patch version
- Tag `v0.1.0`, `npm publish`
- Update README.md with install instructions, badges, screenshot
- Add a `postinstall` hint (NOT an auto-runner) that prints "Run `adaria-ai init` to get started"

**Exit criteria:** A second Mac (not the dev box) can go from zero to a
working `adaria-ai status` showing all three launchd jobs loaded, using
only the public install flow. No copy-from-git, no manual file editing
beyond `adaria-ai init`.

---

## Estimated total: ~10 focused developer days

Not counting:
- Calendar slippage (expect ~2x)
- Adaria.ai brand work if adaria-new changes anything
- Phase 2 features from `docs/pilot-ai-alignment/improvements.md` (streaming,
  session UX polish, agent metrics feedback loop) — those are post-cutover

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|:----------:|:------:|------------|
| Pilot-ai's `core.ts` has more personal-agent coupling than expected, trim is painful | Medium | Days | Start with M1 trim; if it's >1 day of work, write a new `core.ts` from scratch using pilot-ai's as a reference instead of copying |
| Skill interface doesn't cleanly fit all 7 existing agents | Medium | Days | Start with ASO as the proof; if any of the 7 needs a different shape, adjust interface before porting others |
| SQLite port reveals schema drift between DB file and code | Low | Hours | Start fresh DB, don't migrate data |
| Slack app scope review (if we use a new Slack App) takes days | Low | Days | Reuse existing Growth Agent app, just rename in install |
| launchd plist conflicts between old and new daemons | Low | Hours | Use distinct plist labels, document in M7 |
| Fridgify recipe prompt injection defense needs re-validation in TypeScript | Medium | Hours | Carry over the escaping + test cases from `commands/error-hints.test.js` + the sanitization unit tests |
| `claude` CLI keychain behaviour differs on the new plist | Medium | Hours | Day 1 smoke test: `adaria-ai doctor` must pass `claude -p` probe before any skill work |
| M7 parallel run doubles external API load (App Store Connect, ASOMobile, GA4, Search Console) and risks rate limit / duplicate writes | Medium | Hours–Days | adaria-ai runs in read-only mode during parallel week via `ADARIA_DRY_RUN=1`; write paths (blog publish, review reply) stay gated off; collectors read from shared DB where possible |
| Two daemons sharing `~/.claude` auth state — one side runs `/login` and invalidates the other | Low | Hours | Document in M7 runbook: no `/login` during parallel week. `adaria-ai doctor` warns if claude auth was touched within last 24h |
| Mode B MCP tool enables Claude to leak raw review text / PII to Slack when it should summarise | Medium | Hours | M5.5 tool descriptions explicitly forbid pass-through of row data; `db-query.ts` truncates + flags sensitive columns; prompt-guard test case |
| npm package path resolution breaks when installed globally (cwd vs `__dirname`) | Medium | Hours | M9 smoke test on a second Mac is mandatory, not optional. `paths.ts` is the single source of truth for any bundled asset path |
