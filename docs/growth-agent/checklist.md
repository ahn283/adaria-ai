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

- [x] Port `src/collectors/appstore.ts` + test (camelCase wire shape, `parseRetryAfter`, `testHooks` pattern, JSON:API envelope tests; see review-2026-04-12-m2-batch1-collectors.md)
- [x] Port `src/collectors/playstore.ts` + test (shared pattern; `AuthError` wrapping for invalid service account JSON)
- [x] Port `src/collectors/eodin-sdk.ts` + test (SSRF allowlist, percent-cohort normalization, API-key redaction in error bodies; snake_case wire shape intentional — see review-2026-04-12-m2-batch2-collectors.md)
- [x] Port `src/collectors/eodin-blog.ts` + test (3 clients unified under `EodinGrowthClient` base; `markdownToHtml` now HTML-escapes and scheme-whitelists link URLs; bearer redaction in error bodies; see review-2026-04-12-m2-batch3-collectors.md)
- [x] Port `src/collectors/asomobile.ts` + test (SSRF allowlist, empty-keywords guard, `AsoCompetitorInfo.description` flagged for prompt-guard in M4)
- [x] Port `src/collectors/fridgify-recipes.ts` + test (week→month→quarter→year cascade with `satisfied` flag, single-retry rate limit, `RateLimitError` on persistent 429)
- [x] Port `src/collectors/youtube.ts` + test (API key in querystring redacted on both error paths; Shorts filter tightened to 60s default with `maxDurationSeconds` override; see review-2026-04-12-m2-batch4-collectors.md)
- [x] Port `src/collectors/arden-tts.ts` + test (constructor enforces http(s) URL scheme so mis-typed endpoints fail loudly; `synthesizeBatch` returns `{ successes, failures }` with per-failure `statusCode`)
- [x] Add return-type interfaces for each collector in `src/types/` (`StoreReview`, `AppStoreLocalization`, `EodinSummaryRow/FunnelData/Cohort`, `AsoKeywordRanking/Suggestion/CompetitorInfo`, `BlogPostDraft/Update/ListOptions/ListResponse`, `FridgifyRecipe/CascadeResult`, `YouTubeVideoStats` — see `src/types/collectors.ts`)
- [x] Write `scripts/smoke-collectors.ts` — runs via `npm run smoke:collectors` through `tsx`. Loads credentials from `config.yaml.collectors` (init-driven, no env var fallback) and per-app identifiers from `apps.yaml`. Dev profile: `$HOME/.adaria-dev` via `ADARIA_HOME` override.
- [ ] Run smoke test once manually against real APIs (`npm run init:dev` → `npm run smoke:collectors:dev`; dry run verified Fridgify live API + 7 skip / 0 error)

### Added during M2 (scope extension per user request)

- [x] Extend `config.yaml.collectors` schema with 7 optional credential blocks (all 8 collectors minus Fridgify which is public) — `src/config/schema.ts`
- [x] Extend `adaria-ai init` wizard to collect all collector credentials (8 y/n gated blocks, secrets via keychain) — `src/cli/init.ts`
- [x] `KEYCHAIN_KEYS` central constant map to keep init.ts/store.ts slot names in sync — `src/config/schema.ts`
- [x] `deriveServicePrefix(ADARIA_HOME)` for prod/dev keychain namespace isolation — `src/config/keychain.ts` (7 tests)
- [x] `npm run init:dev` + `npm run smoke:collectors:dev` convenience scripts
- [x] `scripts/check-tarball-secrets.ts` pre-publish credential scanner (7 regex patterns, PEM body-required to avoid false positive) — runs in `prepublishOnly`
- [x] `package.json files` hardened: `src/` removed (dist-only, 195 files); `apps.example.yaml` added
- [x] `.gitignore` hardened: `/config.yaml`, `/apps.yaml`, `.adaria-*/` all blocked
- [x] README "Profiles and safety" section

**Exit criteria verification:**
- [x] `npm test` passes with all collector tests (360 total, 76 dedicated collector tests across 8 files)
- [ ] Smoke test prints non-empty sample for every collector (manual, pending live credentials)

## M3 — DB + config port (~0.5 day)

**Goal:** SQLite initialized, apps.yaml loaded, typed queries.

- [x] Port `src/db/schema.ts` with 11 tables (keyword_rankings, sdk_events, reviews, approvals, competitor_metadata, agent_metrics, blog_posts, short_form_performance, seo_metrics, web_traffic, blog_performance) + schema_version. 5 migrations, WAL mode, `fs.mkdirSync` parent dir guarantee. Review H1/H2/M3/M4 addressed.
- [x] Port `src/db/queries.ts` with typed prepared statements — 40+ query helpers, 17 row type interfaces, WeakMap statement cache. `AgentTrendRow` separated per review H2. `insertBlogPost` `published_at` parameterized per review M3. `insertCompetitorMetadata` preserves `null` keywords per review M4.
- [x] Port `src/config/load-config.ts` — already superseded by `src/config/store.ts` (zod-based validation + keychain resolution, landed in M1). No separate port needed.
- [x] Port `src/config/load-apps.ts` (pulled forward from M3 into M2 finisher v2; zod schema in `apps-schema.ts`, loader in `load-apps.ts`, 8 tests)
- [x] Set DB path via `paths.ts` to `$ADARIA_HOME/data/adaria.db` (already resolved in M0; `initDatabase` now ensures parent dir exists)
- [x] Write `tests/db/schema.test.ts` + `tests/db/queries.test.ts` — 41 tests: fresh DB migration, all 11 tables verified, constraint checks (platform, rating, unique, agent types), idempotent re-open, all query helpers exercised with insert/upsert/retrieve/update coverage
- [x] Copy growth-agent's `apps.yaml` → `apps.example.yaml` (root) (M2 finisher v2; camelCase fields, 3 sample apps)
- [x] Verify loader against `apps.example.yaml` (verified via `ADARIA_HOME=/tmp/... npm run smoke:collectors` — parsed all 3 apps, Fridgify recipes live API returned data)

**Exit criteria verification:**
- [ ] `adaria-ai doctor` reports "DB OK, N apps loaded (Fridgify, Arden, Tempy)"

## M4 — First skill: ASO (~1.5 days)

**Goal:** end-to-end proof of the skill pattern.

- [x] Upgrade `src/skills/index.ts` — Skill interface from `dispatch(text)` → `dispatch(ctx, text)` returning `SkillResult`. Added `parseAppNameFromCommand`. PlaceholderSkill updated. Review C1/H1 addressed.
- [x] Write `src/types/skill.ts` — `SkillContext`, `SkillResult`, `SkillAlert`, `ApprovalItem` interfaces
- [x] Port `src/skills/aso.ts` from `src/agents/aso-agent.js`:
  - [x] Uses AsoMobileCollector + AppStoreCollector via constructor-injected `AsoSkillDeps`
  - [x] Calls `ctx.runClaude()` with 3 ASO prompts (metadata, screenshots, in-app events)
  - [x] Returns `SkillResult { summary, alerts, approvals }` with approval item for metadata proposals
  - [x] Review C1: description diffs truncated to 200 chars + TODO for M5.5 prompt-guard
  - [x] Review H1: `runClaude` wrapper in core.ts writes audit log entries
  - [x] Review H2: circuit breaker on skill Claude calls — added in core.ts buildSkillContext (threshold=3, 120s reset)
- [x] Hook into `core.handleMessage`: `@adaria-ai aso fridgify` → dispatch `AsoSkill` via `buildSkillContext()`. Stub context fallback for M1 placeholder path.
- [x] Format Slack response using Block Kit — `formatBriefingBlocks()` in weekly.ts, `sendBlocks` on MessengerAdapter, plain-text fallback for non-Block-Kit clients
- [x] Write `src/prompts/loader.ts` — template loader with `{{var}}` substitution from bundled prompts/
- [x] Copy 4 ASO prompt files to `prompts/` (aso-metadata, aso-screenshots, aso-inapp-events, aso-description)
- [x] Write `tests/skills/aso.test.ts` — 15 tests: dispatch with/without app name, error handling, DB insertion, collector integration, Claude error isolation, approval item generation, platform-specific behavior
- [x] ~~Write `scripts/snapshot-briefing.ts` — captures weekly analysis to JSON for M7 parity diff~~ (removed in M7-cleanup; the parity comparison the script was built for never happens)

**Exit criteria verification:**
- [ ] `@adaria-ai aso fridgify` returns the same analysis growth-agent produces
- [ ] Response formatted as Slack Block Kit

## M5 — Remaining skills (~2 days)

**Goal:** all 6 remaining skills running.

- [x] Port `src/skills/review.ts` + test — 6 tests. Review body sanitized with prompt-injection stripping (H2). Sentiment fallback to rating-based heuristic.
- [x] Port `src/skills/onboarding.ts` + test — 5 tests. SDK funnel, cohort retention, hypotheses via Claude. sdkRequests preserved and forwarded as approvals for SdkRequestSkill pipeline (H3).
- [x] Port `src/skills/seo-blog.ts` + test — 7 tests:
  - [x] Fridgify recipe branch with cascade
  - [x] Prompt sanitization: all 6 attacker-controllable fields restored from growth-agent (C1). `sanitizeUserText` strips injection patterns + HTML tags + caps length.
  - [x] Test includes injection attempt case (recipe name + ingredients)
  - [x] `ADARIA_DRY_RUN` short-circuit removed (was originally added for M7 parallel run; removed in M7-cleanup since the project never goes parallel — approval gate is the only safeguard)
- [x] Port `src/skills/short-form.ts` + test — 3 tests. YouTube performance collection + idea generation.
- [x] Port `src/skills/sdk-request.ts` + test — 4 tests. Stateless class with `analyze()` for orchestrator + `dispatch()` for interactive. Deduplicates by event_name.
- [x] Port `src/skills/content.ts` + test — 3 tests. Kept separate from short-form (covers Pinterest pins + trend content). Uses inline prompts (growth-agent used Anthropic SDK directly; adaria-ai standardizes on ctx.runClaude).
- [x] Copy 8 remaining prompt files to `prompts/` (review-sentiment, review-clustering, review-replies, onboarding-hypotheses, onboarding-review-timing, seo-blog, seo-blog-fridgify-recipe, short-form-ideas)
- [x] Merge growth-agent `approval-manager.js` gates into `src/agent/safety.ts` — 5 gate types defined, core.ts wires approval buttons + requestApproval + onApprovalResolved
- [x] Wire approval buttons in Slack Block Kit — core.ts sends approval via sendApproval for each SkillResult.approvals item
- [ ] Verify approve/reject/non-allowlisted flows — requires manual Slack testing (M7 pre-launch smoke)

**Exit criteria verification:**
- [ ] `@adaria-ai blog fridgify` generates + stages blog posts with approval buttons
- [ ] Approve click → `EodinBlogPublisher.publish` fires
- [x] Every skill has at least one unit test (8/8 skills covered)

## M5.5 — Conversational tools / Mode B (~0.5 day)

**Goal:** free-form mentions work via MCP tool use.

- [x] Write `src/tools/db-query.ts`: table whitelist (11 tables), column redaction (review body, competitor description), column name regex validation, orderBy validation, 50-row cap, row-based truncation at 10KB. Review H2 fixed (no broken JSON). 9 tests.
- [x] Write `src/tools/collector-fetch.ts`: 7 collector types, review body redaction, days cap at 90, input validation (H3). 4 tests.
- [x] Write `src/tools/skill-result.ts`: agent_metrics query, 7 skill types, limit cap at 20, input validation (H3). 3 tests.
- [x] Write `src/tools/app-info.ts`: list all or single app lookup, case-insensitive. 4 tests.
- [x] Write `src/tools/tool-host.ts`: stdio JSON-RPC MCP server entry point, spawned by Claude CLI as subprocess. Handles initialize, tools/list, tools/call.
- [x] Register all four tools with `mcp-manager.ts` via `core.ts` constructor when db is available (review H1).
- [x] Wire `mcp-manager.ts` `buildMcpConfig` to point at `tool-host.js` via `mcp-launcher.buildToolHostServerConfig`.
- [x] Write `src/agent/tool-descriptions.ts` — full descriptions for 4 tools + safety rules. Review C1 fixed (`.slice(0, 1000)` removed so "Important rules" section reaches Claude).
- [x] `core.ts` Mode B path already wired from M1 — MCP config now generated with real tool host when tools are registered.
- [x] Write `tests/tools/db-query.test.ts` — whitelist rejection, SQL injection prevention, column redaction, limit cap, orderBy validation, empty results. 9 tests.
- [x] Write `tests/tools/collector-fetch.test.ts` + `skill-result.test.ts` + `app-info.test.ts` — 11 tests total.
- [x] Write `tests/tools/prompt-injection.test.ts` — 12 tests: Fridgify recipe injection, Mode B tool output, review body injection, XML tag escape, competitor metadata
- [ ] Write `tests/integration/mode-b.test.ts` — deferred to M7 (requires live Claude CLI)
- [x] Update `doctor.ts` — extended with DB, collectors, social checks (M7)

**Exit criteria verification:**
- [ ] `@adaria-ai 이번 주 프리지파이 별점 1점 리뷰 몇 개야?` → Claude calls `db-query` → posts count
- [ ] No skill run involved in the answer
- [ ] Raw review text not leaked to Slack (summarised or counted only)

## M6 — Orchestrators (~1 day)

**Goal:** weekly + daily analyses runnable end-to-end. SocialPublishSkill included in weekly dispatch.

- [x] Port `src/orchestrator/weekly.ts`:
  - [x] Iterate active apps
  - [x] Dispatch weekly skills in parallel (per app, wave 1 + wave 2)
  - [x] Assemble `WeeklyReport`
  - [x] Send mrkdwn briefing to configured channel
  - [x] Aggregate approvals into approval messages
- [x] Port `src/orchestrator/monitor.ts`:
  - [x] 6 threshold checks (keyword rank, review sentiment, 1-star, funnel conversion, SEO, web traffic)
  - [x] Fire alerts on breach
- [x] Port `src/orchestrator/dashboard.ts` — cross-app comparison
- [x] Write `src/orchestrator/types.ts` — WeeklyReport, MonitorAlert, SkippedAgentError, WebMetrics
- [x] Write `src/cli/analyze.ts` — one-shot CLI entry: load config → init DB → call orchestrator → exit
- [x] Write `src/cli/monitor-cmd.ts` — one-shot CLI entry: same pattern
- [x] Write `launchd/com.adaria-ai.weekly.plist.template` (Sun 23:00 UTC, KeepAlive=false)
- [x] Write `launchd/com.adaria-ai.monitor.plist.template` (Daily 23:00 UTC, KeepAlive=false)
- [x] Update `adaria-ai start` to install all three plists
- [x] Update `adaria-ai stop` to unload all three
- [x] Update `adaria-ai status` to check all three labels
- [x] Add `thresholdsConfigSchema` to `src/config/schema.ts` (8 threshold values with defaults)
- [x] Add `weeklyTimeoutMs` to `agentConfigSchema` (15 min default)
- [x] Register `analyze` and `monitor` commands in `src/index.ts`

**Exit criteria verification:**
- [ ] `npx adaria-ai analyze` runs full weekly analysis against real data
- [ ] Weekly briefing appears in Slack
- [ ] `launchctl kickstart -k gui/$UID/com.adaria-ai.weekly` produces same briefing
- [ ] `npx adaria-ai monitor` runs and exits without error

## M6.5 — Social publishing (~3 days)

**Goal:** `@adaria-ai social fridgify` generates platform-optimised content and posts to 6 platforms via approval gate.

### Phase 1: Platform clients

- [x] Write `src/social/base.ts` — `SocialClient` interface + `SocialPostResult` type:
  - [x] `post(content)`, `validateContent(text)`, `uploadMedia(url)`, `deletePost(id)`
- [x] Write `src/social/twitter.ts` — Twitter API v2 + v1.1 media upload:
  - [x] OAuth 1.0a header signing (manual HMAC-SHA1)
  - [x] 280-char validation with t.co URL normalization (23 chars per URL)
  - [x] Image upload via v1.1 `media/upload` (base64 multipart)
- [x] Write `src/social/facebook.ts` — Graph API v19.0:
  - [x] Page Access Token + `appsecret_proof` HMAC-SHA256
  - [x] Photo upload to `/{pageId}/photos` (unpublished → attached_media)
  - [x] Page token fetched via `/me/accounts`
- [x] Write `src/social/threads.ts` — Meta Threads API:
  - [x] Container creation → publish two-step flow
  - [x] 500-char limit validation
- [x] Write `src/social/tiktok.ts` — TikTok Content Posting API:
  - [x] Video/image required enforcement
  - [x] Feature-flagged (may be blocked by app review)
- [x] Write `src/social/youtube.ts` — YouTube Data API v3:
  - [x] Community post creation (bulletin type)
  - [x] 5,000-char limit
- [x] Write `src/social/linkedin.ts` — LinkedIn REST API v2:
  - [x] Organization post (not personal profile)
  - [x] 3-step image upload: initializeUpload → PUT binary → attach URN
  - [x] 3,000-char limit, hashtag count suggestions
- [x] Write `src/social/factory.ts` — `createSocialClient(platform, config)` factory

### Phase 2: Skill + config + DB

- [x] Extend `src/config/schema.ts` — `socialConfigSchema` with per-platform credential blocks:
  - [x] Twitter: apiKey, apiSecret, accessToken, accessTokenSecret
  - [x] Facebook: appId, appSecret, accessToken, pageId
  - [x] Threads: accessToken, userId
  - [x] TikTok: clientKey, clientSecret, accessToken
  - [x] YouTube: accessToken, channelId
  - [x] LinkedIn: accessToken, organizationId
  - [x] 11 KEYCHAIN_KEYS entries added for social secrets
- [x] Redesign `src/cli/init.ts` — modular sections + multi-select checkboxes:
  - [x] `adaria-ai init` — full guided (Slack → Collectors → Social)
  - [x] `adaria-ai init slack|collectors|social` — section-specific
  - [x] Multi-select checkbox for collectors (7 options) and social (6 options)
  - [x] Existing config merged, not overwritten
  - [x] Setup guide URLs for each credential
  - [x] Summary table at the end
  - [x] Social platform credential wizard (6 platforms)
- [x] Add `social_posts` table to `src/db/schema.ts`:
  - [x] Columns: id, app_id, platform, post_id, post_url, content, image_url, status, posted_at
  - [x] Migration v6, CHECK constraint on platform + status
- [x] Add social post queries to `src/db/queries.ts`:
  - [x] `insertSocialPost`, `getSocialPostsByApp`, `getSocialPostsByPlatform`, `updateSocialPostStatus`
- [x] Extend `src/config/apps-schema.ts` — per-app `social: { twitter: bool, ... }` flags with defaults
- [x] Write `src/skills/social-publish.ts`:
  - [x] `SocialPublishSkillDeps` with socialConfigs
  - [x] Calls `ctx.runClaude()` with `prompts/social-publish.md`
  - [x] Parses Claude JSON output → per-platform content
  - [x] Produces `ApprovalItem[]` — one per enabled platform
  - [x] `executePost()` method for approval callback → `client.post()` → DB insert
- [x] Write `prompts/social-publish.md`:
  - [x] Platform-specific character limits and formatting rules
  - [x] Hashtag conventions per platform
  - [x] Tone guidelines (professional for LinkedIn, casual for Twitter/Threads)
  - [x] Output format: JSON array with `{ platform, text, hashtags }`
- [x] Add `social_publish` gate to `src/agent/safety.ts`
- [x] Register `SocialPublishSkill` in `src/skills/registry.ts` — via `createProductionRegistry()` (M7)

### Phase 3: Tests

- [x] Write `tests/social/twitter.test.ts` — char validation, URL normalization
- [x] Write `tests/social/facebook.test.ts` — validation, short text suggestion
- [x] Write `tests/social/threads.test.ts` — 500-char validation
- [x] Write `tests/social/tiktok.test.ts` — caption limit, image requirement
- [x] Write `tests/social/youtube.test.ts` — 5000-char limit
- [x] Write `tests/social/linkedin.test.ts` — 3000 limit, engagement suggestion, hashtag count
- [x] Write `tests/skills/social-publish.test.ts` — dispatch, approval items, no-platforms, app not found, invalid JSON, Claude error (6 tests)

**Exit criteria verification:**
- [ ] `@adaria-ai social fridgify` generates content for all enabled platforms with approval buttons
- [ ] Approve → post appears on target platform (at least Twitter + one other verified)
- [ ] `social_posts` table records every successful post
- [x] All social tests pass (`npm test`)

## M6.7 — Brand profile (~2 days)

Full tick list in `docs/brand-profile/CHECKLIST.md`. Summary below.

- [x] Phase 0 — Slack `downloadImage` plumbing + host allowlist + file
      forwarding (commit `662ae6f`)
- [x] Phase 1 — `src/types/brand.ts` zod schema, `brandsDir()` with
      whitelist regex, `src/brands/loader.ts` with symlink-rejecting
      image loader (commit `e7f8350`)
- [x] Phase 2 — web fetcher with DNS-pinned undici `Agent` (closes
      SSRF TOCTOU), npm + GitHub README fetcher, Claude-driven
      generator with `ADARIA_DRY_RUN` short-circuit (commit `7e65111`)
- [x] Phase 3 — migration v7 `brand_flows` table, pure-reducer state
      machine in `src/brands/flow.ts` (commit `cd14ac8`)
- [x] Phase 4 — BrandSkill `dispatch` + `continueFlow`, Mode C routing
      in `core.ts` with DM-safe threadKey and Mode A escape hatch
      (commit `796a940`)
- [x] Phase 5 — `preparePrompt` brand-context fallback, 13 prompt
      templates gain `{{brandContext}}`, 6 skills load profiles per
      dispatch (commit `4cebb53`)
- [x] Phase 6 — milestone + porting-matrix + CLAUDE.md alignment
      (commit `cc26e63`)
- [x] Follow-ups — date-stable agent_metrics tests, content.ts
      brand context injection, per-thread flow isolation test,
      `design/` gitignored (commit `00fb722`)

**Exit criteria verification:** see `docs/brand-profile/CHECKLIST.md`
(manual Slack E2E pending — covered by M7 pre-launch smoke).

## M7 — Pre-launch smoke (~0.5 day)

**Goal:** Verify adaria-ai is wired correctly before the first live
weekly briefing. growth-agent is not in active use, so there is no
parity comparison.

### Prerequisites

- [ ] Slack app dashboard → Bot Token Scopes → add `files:read` and
      reinstall the app (one-time, required for M6.7 brand uploads)
- [ ] `~/.adaria/config.yaml` → set `slack.briefingChannel` to your
      DM channel (`D...`) for the smoke window so test runs do not
      hit the production channel

### Daemon wiring (deferred from M6/M6.5)

- [x] Wire `daemon.ts` to load DB, apps, pass production skill registry to AgentCore
- [x] Create `src/skills/registry.ts` — `createProductionRegistry()` with all 8 skills
- [x] Register `SocialPublishSkill` with commands `["social", "소셜", "sns"]` (M6.5 C2)
- [x] Add `socialPublish` to `WeeklyReport` interface + orchestrator dispatch (M6.5 H2)
- [x] Wire `socialPublish` dispatcher in `analyze.ts`
- [x] Include social results in `formatBriefingText` + `collectApprovalItems`
- [x] Wire `SocialPublishSkill.executePost()` to approval callback — core.ts onApprovalResolved() calls executePost() via duck-typing

### Doctor updates

- [x] Port `doctor.ts` to cover all growth-marketing checks:
  - [x] App Store Connect credentials (optional, non-fatal)
  - [x] Google Play credentials (optional, non-fatal)
  - [x] ASOMobile API (optional, non-fatal)
  - [x] Eodin SDK (optional, non-fatal)
  - [x] Eodin Growth token (optional, non-fatal)
  - [x] Social platform credentials (6 platforms, optional, non-fatal)
  - [x] briefingChannel check
  - [x] DB accessible (table count)
- [x] Add warning: claude auth state touched within last 24h — doctor.ts checkClaudeAuthRecency()

### Docs

- [x] Write `docs/ARCHITECTURE.md` — system diagram, two-mode dispatch, module layout, approval flow
- [x] Write `docs/SETUP.md` — install + init + troubleshooting + dev profiles + rollback
- [x] Write `docs/SKILLS.md` — skill interface, built-in skills, adding new skills, testing
- [x] Start `docs/PORTING-LOG.md` — M1–M7 surprises and decisions

### Smoke run (in DM)

- [ ] `adaria-ai doctor` — every check green or every red explained
- [ ] Approval-gate sanity (any one of):
  - [ ] Blog publish: trigger `@adaria-ai blog fridgify`, click `Reject`
        on the resulting button — no post lands on Eodin Blog
  - [ ] Review reply: trigger a review-reply approval, click `Reject`
- [ ] Brand flow E2E (per `docs/brand-profile/PRD.md` §8):
  - [ ] `@adaria-ai brand` in DM → complete flow for service type `app`
        (e.g. Fridgify via App Store URL + Play package)
  - [ ] `@adaria-ai brand` → complete flow for `web` (e.g. `https://eodin.app`)
  - [ ] `@adaria-ai brand` → complete flow for `package`
        (e.g. `@eodin/analytics-sdk`)
  - [ ] Upload logo + design-system images in-flow; verify
        `~/.adaria/brands/{id}/{logo,design-system}.*` written
  - [ ] `@adaria-ai aso fridgify` with `brand.yaml` present → output
        reflects brand voice (spot-check); remove yaml → skill still
        succeeds with empty brand section
  - [ ] Kill `adaria-ai daemon` mid-flow (state = ASK_IDENTIFIER),
        `launchctl kickstart -k gui/$UID/com.adaria-ai.daemon`, send
        next message → flow resumes at persisted state
  - [ ] Stale flow cleanup — leave a flow idle past
        `safety.approvalTimeoutMinutes` (default 30); next message in
        the same thread must start a fresh `ASK_TYPE` turn

**Exit criteria verification:**
- [ ] doctor green
- [ ] one approval loop manually exercised end-to-end
- [ ] brand flow demonstrated for at least one service type

## M8 — Go live (~0.5 day)

**Goal:** adaria-ai posts its first real Sunday briefing to the
production Slack channel.

- [ ] `~/.adaria/config.yaml` → switch `slack.briefingChannel` from
      DM back to the production channel (e.g. `#growth`)
- [ ] `adaria-ai stop && adaria-ai start` to pick up config change
- [ ] Sit through the first live Sunday weekly run; tail
      `~/.adaria/logs/weekly.out.log` in real time
- [ ] If anything misbehaves, switch `briefingChannel` back to DM,
      reload, fix, redeploy

**Exit criteria verification:**
- [ ] Monday morning briefing visible in the production channel
- [ ] No operator intervention needed during the run
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

- [x] Every collector has a unit test (M2) — 8/8 collectors, 76 dedicated tests across 8 files
- [x] Every skill has a unit test (M4, M5) — 7/7 skills: aso 15, review 6, onboarding 5, seo-blog 7, short-form 3, sdk-request 4, content 3 = 43 skill tests total
- [x] SocialPublishSkill has unit tests (M6.5) — 6 tests
- [x] Every social platform client has a unit test (M6.5) — 6 clients, validation + flow tests
- [x] Every MCP tool has a unit test with whitelist rejection case (M5.5) — db-query 9, collector-fetch 4, skill-result 3, app-info 4 = 20 tool tests
- [x] `prompt-guard.ts` has injection test cases covering Fridgify recipe + Mode B tool descriptions — 12 tests in prompt-injection.test.ts + 7 tests for sanitizeExternalText
- [x] DB migration smoke test runs in CI (M3) — `tests/db/schema.test.ts` (15 tests) + `tests/db/queries.test.ts` (26 tests), 41 total
- [x] Orchestrator integration test with mocked collectors (M6) — weekly 8 tests, monitor 6 tests, dashboard 3 tests = 17 total

### Documentation

- [x] `README.md` at repo root — install, usage, contributing (started M2; "Profiles and safety" section landed)
- [x] `docs/guide/ARCHITECTURE.md` — system diagram, data flow (M7)
- [x] `docs/guide/SETUP.md` — install + init + troubleshooting (M7)
- [x] `docs/guide/SKILLS.md` — skill authoring guide (M7)
- [x] `docs/guide/PORTING-LOG.md` — living log of port surprises (M1–M7)

### Security

- [ ] Allowlist enforcement verified (M1)
- [ ] Prompt-guard covers Fridgify recipe injection (M5)
- [ ] MCP tools are read-only and whitelisted (M5.5)
- [x] No secrets in npm tarball (M9 `tar -tzf` inspection) — `check:tarball-secrets` runs in `prepublishOnly`, scans 7 credential patterns (Slack/Anthropic/Google/OpenAI/GitHub/PEM), blocks publish on match. Also `src/` removed from `files` field (dist-only tarball, 195 files).
- [x] Social platform tokens stored in Keychain, not config files (M6.5) — 11 KEYCHAIN_KEYS + store.ts resolution
- [x] `social_publish` approval gate added to safety.ts (M6.5)
- [x] Social platform `post()` / `deletePost()` writes routed only via approval gate — no second-line dry-run flag (removed in M7-cleanup)
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
- [x] `ADARIA_HOME` override documented for prod/dev profile separation — README "Profiles and safety" section covers keychain namespace derivation and `init:dev` / `smoke:collectors:dev` scripts

---

## Progress tracker

| Milestone | Est. days | Status | Started | Completed |
|-----------|:---------:|--------|---------|-----------|
| M0 Bootstrap | 0.5 | ✅ | 2026-04-12 | 2026-04-12 |
| M1 Runtime import | 1.5 | 🟨 | 2026-04-12 | — (code + tests landed; awaiting manual Slack smoke test per exit-criteria section) |
| M2 Collectors | 1.0 | 🟨 | 2026-04-12 | — (all 8 collectors ported + smoke script; last item is manual smoke run against live creds) |
| M3 DB + config | 0.5 | 🟨 | 2026-04-12 | — (schema + queries + tests landed; exit criteria `doctor` DB check deferred to M4 wiring) |
| M4 ASO skill | 1.5 | 🟨 | 2026-04-12 | — (all code items done; circuit breaker, Block Kit, snapshot script landed; manual Slack verify pending) |
| M5 Remaining skills | 2.0 | 🟨 | 2026-04-12 | — (6 skills + approval wiring + Block Kit buttons landed; manual approve/reject verify pending) |
| M5.5 Mode B tools | 0.5 | 🟨 | 2026-04-12 | — (4 tools + prompt-injection tests landed; integration test deferred to M7 smoke) |
| M6 Orchestrators | 1.0 | 🟨 | 2026-04-12 | — (code + Block Kit briefing + tests landed; pending manual verify: Slack briefing + launchctl) |
| M6.5 Social publishing | 3.0 | 🟨 | 2026-04-12 | — (6 clients + skill + smoke script + all tests landed; manual platform verify pending) |
| M6.7 Brand profile | 2.0 | 🟨 | 2026-04-15 | — (all 6 phases landed; manual Slack flow E2E folded into M7 pre-launch smoke) |
| M7 Pre-launch smoke | 0.5 | 🟨 | 2026-04-12 | — (code + docs complete; manual smoke run pending) |
| M8 Go live | 0.5 | ⬜ | — | — |
| M9 npm publish | 0.5 | ⬜ | — | — |
| **Total** | **~15** | | | |
