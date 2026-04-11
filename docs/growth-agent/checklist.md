# adaria-ai — execution checklist

Tick items grouped by milestone. Derived from `milestones.md` with exit
criteria inlined as verification steps. Cross-cutting items (docs, tests,
CI) are listed at the end.

**Estimate:** ~10 focused dev days. Calendar 2x.

---

## Pre-M0 — prerequisites

- [x] Read all 5 planning docs in this directory
- [x] Confirm `/Users/ahnwoojin/Github/adaria-ai` exists and is empty
- [x] Confirm `/Users/ahnwoojin/Github/pilot-ai` is accessible for copying
- [x] Confirm `/Users/ahnwoojin/growth-agent` is accessible for porting
- [x] Commit growth-agent Phase 1 fix (silent-failure) and push — freeze from this point forward
- [x] Verify `npm view adaria-ai` still returns 404 (not taken)
- [x] Verify Node 20+ installed (`node --version`)
- [x] Verify `claude` CLI installed and authed (`claude -p "hello"` works)

## M0 — Bootstrap (~0.5 day)

**Goal:** empty → compilable TypeScript project, npm-publishable shape.

- [x] `cd /Users/ahnwoojin/Github/adaria-ai && git init`
- [x] Write `.gitignore` (node_modules, dist, .env, logs, *.db, .adaria/, *.tgz)
- [x] `npm init -y`
- [x] Edit `package.json`:
  - [x] `name: "adaria-ai"`
  - [x] `version: "0.0.1"`
  - [x] `"private": true` (anti-oops guard — removed in M9; added per M0 review HIGH #1)
  - [x] `type: "module"`
  - [x] `bin: { "adaria-ai": "./dist/index.js" }`
  - [x] `files: ["dist/", "src/", "prompts/", "launchd/", "README.md", "LICENSE"]` (src/ added per M0 review MEDIUM #3 — sourcemap resolution)
  - [x] `engines: { "node": ">=20" }`
  - [x] `scripts.build: "tsc"`
  - [x] `scripts.test: "vitest run --passWithNoTests"`
  - [x] `scripts.lint: "eslint src/"`
  - [x] `scripts.prepublishOnly: "npm run build && npm run lint && npm test"`
- [x] Write `.npmignore` (tests/, docs/, scripts/, .env*, apps.yaml, config.yaml)
- [x] Install runtime deps (@slack/bolt, better-sqlite3, commander, js-yaml, inquirer) + dev deps (typescript, @types/node, @types/better-sqlite3, @types/inquirer, @types/js-yaml, vitest, eslint, @eslint/js, typescript-eslint)
- [x] Write `tsconfig.json` (strict, module: NodeNext, target ES2022, outDir: dist, `types: ["node"]`, all strict sub-flags on)
- [x] Write `eslint.config.js` (flat config)
- [x] Create `src/index.ts` stub — commander CLI printing version
- [x] Create `src/utils/paths.ts` — resolves `ADARIA_HOME` (default `~/.adaria`), bundled prompts dir, launchd templates dir (all via `import.meta.url`)
- [x] Create `prompts/.gitkeep`, `launchd/.gitkeep` — prevent silent `files:` misses (M0 review HIGH #2)
- [x] Create minimal `README.md` + MIT `LICENSE` (M0 review HIGH #2 part 3)
- [x] `npm run build` compiles
- [x] `npm run lint` passes
- [x] `npm test` runs zero tests (no failures, via `--passWithNoTests`)
- [x] `npm pack --dry-run` shows only `dist/`, `src/`, `prompts/.gitkeep`, `launchd/.gitkeep`, `package.json`, `README.md`, `LICENSE` — no leaks
- [x] `npm publish` refused with `EPRIVATE` (guard verified)
- [x] Commit: `chore: bootstrap adaria-ai TypeScript project` (ee8a573)

**Exit criteria verification:**
- [x] `node dist/index.js --version` prints the version (`0.0.1`)
- [x] `npm pack` produces a valid tarball (3.2 kB, 15 files)

## M1 — Pilot-ai runtime import (~1.5 days)

**Goal:** Slack daemon boots; `@adaria-ai ping` returns a real Claude response.

### Tooling upgrades (deferred from M0 review)

- [x] Split `tsconfig.json` → `tsconfig.base.json` (shared compilerOptions) + `tsconfig.json` (noEmit, includes src + tests, used by IDE and ESLint) + `tsconfig.build.json` (build, excludes tests)
- [x] Add `typecheck` npm script (`tsc --noEmit` against tsconfig.json)
- [x] Enable type-aware ESLint with `tseslint.configs.recommendedTypeChecked`, `no-floating-promises`, `no-misused-promises`; `tsconfigRootDir` resolved via `fileURLToPath` for Node 20.0 compat
- [x] Config files (`eslint.config.js`, `*.config.*`) excluded from type-aware linting to avoid circular tsconfig include

### Copy from pilot-ai (per `porting-matrix.md`)

- [x] `src/agent/claude.ts` — adapted (120s default timeout; 15 min for weekly orchestrator config)
- [x] `src/agent/core.ts` — **major trim**:
  - [x] Drop: project resolver, pilot-ai md-based skills loader, memory context (project-scoped), Google/GitHub auth checks, token refresher, permission watcher
  - [x] **Keep**: auth check, audit, reactions, status evolution, session continuity, error diff, msg_too_long fallback, **MCP context builder**, **tool-descriptions injection**, **MCP server health checks**
  - [x] If trim takes > 1 day → stop and rewrite `core.ts` from scratch with pilot-ai as reference
- [x] `src/agent/session.ts` — path change to `~/.adaria/sessions.json` via `paths.ts`
- [x] `src/agent/memory.ts` — conversation-scoped memory only
- [x] `src/agent/conversation-summary.ts` — verbatim
- [x] `src/agent/safety.ts` — pilot-ai ApprovalManager base (growth-agent gates merged in M5)
- [x] `src/agent/audit.ts` — path change to `~/.adaria/audit.jsonl`
- [x] `src/agent/mcp-manager.ts` — framework, no tools registered yet (rewritten as skeleton; see `porting-matrix.md`)
- [x] `src/agent/mcp-launcher.ts` — framework only (rewritten as skeleton; see `porting-matrix.md`)
- [x] `src/messenger/adapter.ts`, `slack.ts` (add `eventTs` field), `split.ts`, `factory.ts`
- [x] `src/security/auth.ts` (allowlist check, Slack-only), `prompt-guard.ts` (XML tag wrappers, wrapMemory intentionally omitted)
- [x] `src/config/schema.ts` (zod, Slack + Claude + security + safety + agent), `store.ts` (YAML + chmod tightening for 0700/0600), `keychain.ts` (macOS security CLI, `adaria-ai:` prefix)
- [x] `src/messenger/adapter.ts` (interface only — concrete SlackAdapter in M1d; `eventTs?: string` optional per M1c review H3)
- [x] `src/utils/circuit-breaker.ts`, `rate-limiter.ts`, `logger.ts` (ADARIA_HOME aware, `adaria-` prefix), `retry.ts`, `escape.ts`, `errors.ts` (`AdariaError` + `withDefaults` helper for exactOptional), `parse-json.ts` (growth-agent port, bracket-matching) + 7 test files (68 tests passing)
- [x] `src/cli/daemon.ts`, `start.ts`, `stop.ts`, `status.ts`, `logs.ts`, `init.ts`, `doctor.ts`

### Adapt + wire

- [x] Adapt `src/config/store.ts` and `schema.ts` to adaria-ai config shape (slack + claude; no google/github/tools)
- [x] Write `launchd/com.adaria-ai.daemon.plist.template` based on growth-agent's
- [x] Rewire `core.handleMessage`:
  - [x] Mode A: dispatch to placeholder skill registry that returns `"(skill not implemented)"` for every command
  - [x] Mode B: fall through to Claude CLI with empty MCP tool list (framework plumbing verified)
- [x] `adaria-ai init` wizard: bot token, signing secret, app token, allowlist user ID, channel
- [x] `adaria-ai start` → launchctl load → daemon visible in `launchctl list`

### Verify

- [ ] Slack workspace: reuse `Growth Agent` app (decision 5 — freeze)
- [ ] Mention the bot → daemon receives event → audit logged → Claude runner called → response posted back
- [ ] 🤔 → ✅ reaction sequence fires
- [ ] Status message evolves in place
- [ ] `adaria-ai doctor` passes basic checks (claude auth, slack scopes)

**Exit criteria verification:**
- [ ] `@adaria-ai 안녕` returns a real Claude response
- [ ] Reactions 🤔 → ✅ visible on original message
- [ ] Audit log entry written to `~/.adaria/audit.jsonl`

## M2 — Collector port (~1 day)

**Goal:** all 8 collectors callable from TypeScript with existing test coverage.

- [ ] Port `src/collectors/appstore.ts` + test
- [ ] Port `src/collectors/playstore.ts` + test
- [ ] Port `src/collectors/eodin-sdk.ts` + test
- [ ] Port `src/collectors/eodin-blog.ts` + test
- [ ] Port `src/collectors/asomobile.ts` + test
- [ ] Port `src/collectors/fridgify-recipes.ts` + test (incl. cascade logic)
- [ ] Port `src/collectors/youtube.ts` + test
- [ ] Port `src/collectors/arden-tts.ts` + test
- [ ] Add return-type interfaces for each collector in `src/types/`
- [ ] Write `scripts/smoke-collectors.ts` — hits each API, prints sample output
- [ ] Run smoke test once manually against real APIs

**Exit criteria verification:**
- [ ] `npm test` passes with all collector tests
- [ ] Smoke test prints non-empty sample for every collector

## M3 — DB + config port (~0.5 day)

**Goal:** SQLite initialized, apps.yaml loaded, typed queries.

- [ ] Port `src/db/schema.ts` with 8+ tables (keyword_rankings, sdk_events, reviews, approvals, competitor_metadata, agent_metrics, seo_metrics, web_traffic, blog_performance, short_form_performance)
- [ ] Port `src/db/queries.ts` with typed prepared statements
- [ ] Port `src/config/load-config.ts`
- [ ] Port `src/config/load-apps.ts`
- [ ] Set DB path via `paths.ts` to `$ADARIA_HOME/data/adaria.db`
- [ ] Write `tests/db/migration-smoke.test.ts` — fresh DB, run v1-v5 migrations, read every table
- [ ] Copy growth-agent's `apps.yaml` → `apps.example.yaml` (root)
- [ ] Verify loader against `apps.example.yaml`

**Exit criteria verification:**
- [ ] `adaria-ai doctor` reports "DB OK, N apps loaded (Fridgify, Arden, Tempy)"

## M4 — First skill: ASO (~1.5 days)

**Goal:** end-to-end proof of the skill pattern.

- [ ] Write `src/skills/index.ts` — skill registry + dispatch logic
- [ ] Write `src/types/skill.ts` — `Skill`, `SkillContext`, `SkillResult` interfaces
- [ ] Port `src/skills/aso.ts` from `src/agents/aso-agent.js`:
  - [ ] Uses AsoMobileCollector + AppStoreCollector via `ctx.collectors`
  - [ ] Calls `ctx.runner.runClaude()` with the four ASO prompts
  - [ ] Returns `SkillResult { summary, alerts, approvals }`
- [ ] Hook into `core.handleMessage`: `@adaria-ai aso fridgify` → dispatch `AsoSkill`
- [ ] Format Slack response using Block Kit
- [ ] Write `tests/skills/aso.test.ts` — mock collectors + runner, verify dispatch builds expected prompt inputs
- [ ] Write `scripts/snapshot-briefing.ts` — JSON dump of skill result for diff-based parity check (used from M4 onward)

**Exit criteria verification:**
- [ ] `@adaria-ai aso fridgify` returns the same analysis growth-agent produces
- [ ] Response formatted as Slack Block Kit

## M5 — Remaining skills (~2 days)

**Goal:** all 6 remaining skills running.

- [ ] Port `src/skills/review.ts` + test
- [ ] Port `src/skills/onboarding.ts` + test
- [ ] Port `src/skills/seo-blog.ts`:
  - [ ] Fridgify recipe branch
  - [ ] Prompt sanitization (review C1 from growth-agent Phase 1)
  - [ ] Test includes injection attempt cases
- [ ] Port `src/skills/short-form.ts` + test
- [ ] Port `src/skills/sdk-request.ts` + test (decide: stateless or class with aggregation state)
- [ ] Port `src/skills/content.ts` OR fold into `short-form.ts` — decide during port
- [ ] Merge growth-agent `approval-manager.js` gates into `src/agent/safety.ts`:
  - [ ] `blog_publish` gate
  - [ ] `metadata_change` gate
  - [ ] `review_reply` gate
  - [ ] `sdk_request` gate
- [ ] Wire approval buttons in Slack Block Kit
- [ ] Verify approve click → audit entry → action fires
- [ ] Verify reject click → audit entry → action abandoned
- [ ] Verify non-allowlisted approver rejected

**Exit criteria verification:**
- [ ] `@adaria-ai blog fridgify` generates + stages blog posts with approval buttons
- [ ] Approve click → `EodinBlogPublisher.publish` fires
- [ ] Every skill has at least one unit test

## M5.5 — Conversational tools / Mode B (~0.5 day)

**Goal:** free-form mentions work via MCP tool use.

- [ ] Write `src/tools/db-query.ts`:
  - [ ] Input schema: `{ table: enum, where?, orderBy?, limit? }`
  - [ ] Whitelist tables explicitly
  - [ ] Reject non-whitelisted inputs
  - [ ] Truncate output at 50 rows / 10KB
- [ ] Write `src/tools/collector-fetch.ts`:
  - [ ] Input schema: `{ collector: enum, app: string, fresh?: bool }`
  - [ ] Cache-aware — return DB row if fresh, otherwise hit API
- [ ] Write `src/tools/skill-result.ts`:
  - [ ] Read last-N weekly briefing blobs from DB per app
- [ ] Write `src/tools/app-info.ts`:
  - [ ] Read parsed `apps.yaml` metadata
- [ ] Register all four tools with `mcp-manager.ts`
- [ ] Write `src/agent/tool-descriptions.ts` — descriptions for the 4 marketing tools
- [ ] Update `core.ts` Mode B path — pass MCP config to Claude CLI with system prompt ("You are adaria-ai, a marketing analytics assistant... Use tools to answer read questions. Never attempt writes; never guess data you can fetch.")
- [ ] Write `tests/tools/db-query.test.ts` — rejects non-whitelisted table
- [ ] Write `tests/tools/prompt-injection.test.ts` — attempts to bypass whitelist via description injection fail
- [ ] Write `tests/integration/mode-b.test.ts` — scripted mention → tool call → synthesised answer against fixture
- [ ] Update `doctor.ts` to list registered MCP tools and verify they start

**Exit criteria verification:**
- [ ] `@adaria-ai 이번 주 프리지파이 별점 1점 리뷰 몇 개야?` → Claude calls `db-query` → posts count
- [ ] No skill run involved in the answer
- [ ] Raw review text not leaked to Slack (summarised or counted only)

## M6 — Orchestrators (~1 day)

**Goal:** weekly + daily analyses runnable end-to-end.

- [ ] Port `src/orchestrator/weekly.ts`:
  - [ ] Iterate active apps
  - [ ] Dispatch weekly skills in parallel (per app)
  - [ ] Assemble `WeeklyReport`
  - [ ] Send Block Kit briefing to configured channel
  - [ ] Aggregate approvals into one message
- [ ] Port `src/orchestrator/monitor.ts`:
  - [ ] Threshold checks (rating drop, ranking drop, conversion drop)
  - [ ] Fire alerts on breach
- [ ] Port `src/orchestrator/dashboard.ts` — cross-app comparison
- [ ] Write `src/cli/analyze.ts` — one-shot CLI entry: load config → init DB → init collectors → call orchestrator → exit
- [ ] Write `src/cli/monitor.ts` — one-shot CLI entry: same pattern
- [ ] Write `launchd/com.adaria-ai.weekly.plist.template` (Sun 23:00 UTC)
- [ ] Write `launchd/com.adaria-ai.monitor.plist.template` (Daily 23:00 UTC)
- [ ] Update `adaria-ai start` to install all three plists
- [ ] Update `adaria-ai stop` to unload all three
- [ ] Update `adaria-ai status` to check all three labels

**Exit criteria verification:**
- [ ] `npx adaria-ai analyze` runs full weekly analysis against real data
- [ ] Weekly briefing appears in Slack
- [ ] `launchctl kickstart -k gui/$UID/com.adaria-ai.weekly` produces same briefing
- [ ] `npx adaria-ai monitor` runs and exits without error

## M7 — Parity + cutover prep (~1 day)

**Goal:** adaria-ai matches growth-agent. Cutover is safe.

### Parallel run setup

- [ ] Set `ADARIA_DRY_RUN=1` in adaria-ai plist — disables all write paths
- [ ] Point adaria-ai Slack output to DM channel (not #growth)
- [ ] Verify adaria-ai reads from same data sources but writes nothing
- [ ] Both daemons running: growth-agent (production #growth) + adaria-ai (DM, dry-run)

### Parity verification

- [ ] Run `scripts/snapshot-briefing.ts` on adaria-ai
- [ ] Run equivalent extractor on growth-agent
- [ ] Diff the two Sunday briefings section-by-section
- [ ] Every section matches within tolerance OR difference is explainable
- [ ] Verify approval buttons work end-to-end in DM:
  - [ ] Blog publish approval (dry-run — log what would be published)
  - [ ] Review reply approval (dry-run)
  - [ ] Metadata change approval (dry-run)

### Doctor updates

- [ ] Port `doctor.ts` to cover all growth-marketing checks:
  - [ ] App Store Connect credentials
  - [ ] Google Play credentials
  - [ ] ASOMobile API
  - [ ] Eodin SDK
  - [ ] Eodin Blog token
  - [ ] GA4
  - [ ] Search Console
  - [ ] apps.yaml validity
  - [ ] DB accessible
  - [ ] MCP tools registered
- [ ] Add warning: claude auth state touched within last 24h

### Docs

- [ ] Write `docs/ARCHITECTURE.md` — system diagram, data flow, how skills dispatch
- [ ] Write `docs/SETUP.md` — install + init + troubleshooting
- [ ] Write `docs/SKILLS.md` — skill authoring guide
- [ ] Start `docs/PORTING-LOG.md` — log surprises during the port

### Operational runbook (M7 parallel week)

- [ ] **Do not** run `claude /login` this week (shared auth state)
- [ ] **Do not** commit to growth-agent unless it's a Slack-down fix
- [ ] Monitor both daemons daily via `adaria-ai status` / `growth-agent status`

**Exit criteria verification:**
- [ ] Full Sunday weekly run on adaria-ai produces briefing indistinguishable from growth-agent's, or every difference is documented

## M8 — Cutover (~0.5 day)

**Goal:** adaria-ai is the only live daemon.

- [ ] Stop growth-agent daemon: `./bin/daemon-ctl.sh stop`
- [ ] Unload growth-agent launchd plist: `launchctl unload ...`
- [ ] Remove `ADARIA_DRY_RUN=1` from adaria-ai plist
- [ ] Switch adaria-ai Slack channel from DM back to `#growth`
- [ ] `adaria-ai stop && adaria-ai start` to pick up config change
- [ ] Post cutover announcement in `#growth`
- [ ] Monitor first live weekly run on adaria-ai
- [ ] Tag `growth-agent v1-final`
- [ ] Update growth-agent README with pointer to adaria-ai
- [ ] Commit to growth-agent: `chore: archive repo, see adaria-ai`
- [ ] Archive growth-agent repo on GitHub

### Rollback path (if Monday briefing fails)

- [ ] `adaria-ai stop`
- [ ] `launchctl load <growth-agent.plist>`
- [ ] `./bin/daemon-ctl.sh start` on growth-agent
- [ ] Investigate, fix, retry — no data lost

**Exit criteria verification:**
- [ ] Monday morning Slack briefing comes from adaria-ai
- [ ] growth-agent daemon not running
- [ ] `launchctl list | grep adaria-ai` shows 3 jobs loaded

## M9 — npm publish (~0.5 day)

**Goal:** `npm install -g adaria-ai` works on a fresh Mac.

- [ ] **Remove `"private": true` from `package.json`** — added in M0 as an anti-oops guard; M9 is the first legitimate publish
- [ ] Verify `package.json` `files` field ships exactly: `dist/`, `src/`, `prompts/`, `launchd/`, README.md, LICENSE
- [ ] Verify `src/utils/paths.ts` uses `import.meta.url` for bundled asset paths (never cwd-relative)
- [ ] Run `npm pack` locally and inspect tarball contents with `tar -tzf`
- [ ] Verify `prompts/` contains all 11 `.md` files and `launchd/` contains 3 plist templates — empty `.gitkeep` only = regression
- [ ] Bump version to `0.1.0`
- [ ] Smoke test on a second Mac (or a fresh user account):
  - [ ] `npm install -g @anthropic-ai/claude-code`
  - [ ] `claude /login`
  - [ ] `npm install -g adaria-ai` (from local tarball first, then published)
  - [ ] `adaria-ai init`
  - [ ] `adaria-ai doctor` — all green
  - [ ] `adaria-ai start`
  - [ ] `adaria-ai status` shows all three plists loaded
- [ ] If smoke test reveals path issues → fix → republish patch
- [ ] `npm login` with 2FA
- [ ] `git tag v0.1.0`
- [ ] `npm publish`
- [ ] Update `README.md` with install instructions, badges, screenshot
- [ ] Add `postinstall` script printing "Run `adaria-ai init` to get started" (hint only — no auto-runner)

**Exit criteria verification:**
- [ ] Second Mac reaches `adaria-ai status` (3 jobs loaded) using only public install flow
- [ ] `npm view adaria-ai version` returns `0.1.0`

---

## Cross-cutting checklist

### Testing

- [ ] Every collector has a unit test (M2)
- [ ] Every skill has a unit test (M4, M5)
- [ ] Every MCP tool has a unit test with whitelist rejection case (M5.5)
- [ ] `prompt-guard.ts` has injection test cases covering Fridgify recipe + Mode B tool descriptions
- [ ] DB migration smoke test runs in CI (M3)
- [ ] Orchestrator integration test with mocked collectors (M6)

### Documentation

- [ ] `README.md` at repo root — install, usage, contributing
- [ ] `docs/ARCHITECTURE.md` — system diagram, data flow (M7)
- [ ] `docs/SETUP.md` — install + init + troubleshooting (M7)
- [ ] `docs/SKILLS.md` — skill authoring guide (M7)
- [ ] `docs/PORTING-LOG.md` — living log of port surprises (start M1, update through M8)

### Security

- [ ] Allowlist enforcement verified (M1)
- [ ] Prompt-guard covers Fridgify recipe injection (M5)
- [ ] MCP tools are read-only and whitelisted (M5.5)
- [ ] No secrets in npm tarball (M9 `tar -tzf` inspection)
- [ ] Audit log captures every Claude invocation, skill dispatch, approval action

### CI / automation (post-M9, not blocking)

- [ ] GitHub Actions workflow: `npm ci && npm run build && npm test && npm run lint` on push
- [ ] GitHub Actions publish workflow on `v*` tag push (requires `NPM_TOKEN` secret + 2FA considerations)
- [ ] Dependabot or Renovate for dependency updates
- [ ] Pre-commit hook (optional): lint + typecheck

### Operational readiness

- [ ] `adaria-ai doctor` is the single source of truth for "is the system healthy"
- [ ] Every error path logs to `~/.adaria/logs/` with enough context to debug from the log alone
- [ ] Rollback path from M8 is documented in `docs/SETUP.md`
- [ ] `ADARIA_HOME` override documented for parallel run + testing

---

## Progress tracker

| Milestone | Est. days | Status | Started | Completed |
|-----------|:---------:|--------|---------|-----------|
| M0 Bootstrap | 0.5 | ✅ | 2026-04-12 | 2026-04-12 |
| M1 Runtime import | 1.5 | 🟨 | 2026-04-12 | — (code + tests landed; awaiting manual Slack smoke test per exit-criteria section) |
| M2 Collectors | 1.0 | ⬜ | — | — |
| M3 DB + config | 0.5 | ⬜ | — | — |
| M4 ASO skill | 1.5 | ⬜ | — | — |
| M5 Remaining skills | 2.0 | ⬜ | — | — |
| M5.5 Mode B tools | 0.5 | ⬜ | — | — |
| M6 Orchestrators | 1.0 | ⬜ | — | — |
| M7 Parity + parallel | 1.0 | ⬜ | — | — |
| M8 Cutover | 0.5 | ⬜ | — | — |
| M9 npm publish | 0.5 | ⬜ | — | — |
| **Total** | **~10** | | | |
