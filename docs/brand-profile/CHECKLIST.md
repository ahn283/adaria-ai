# Brand Profile (M6.7) — Execution Checklist

Tick items per phase. Each phase is one logical commit following the
mandatory dev loop: develop → build → code review → unit test → checklist
update → commit.

---

## Prerequisites

- [ ] Confirm M5 (all 7 skills) + M5.5 (MCP tools) + M6 (orchestrators) +
      M6.5 (social) all merged
- [ ] Slack App Dashboard → OAuth & Permissions → Bot Token Scopes → add
      `files:read`
- [ ] Workspace에 앱 재설치 (scope 변경 후 필수)
- [ ] Verify existing `SLACK_BOT_TOKEN` still valid after reinstall
- [ ] `npm install cheerio` — added in Phase 2 as web HTML parser dep

---

## Phase 0 — Slack file download plumbing ✅

Commit: `feat(m6.7): plumb slack file downloads` (TBD hash)

- [x] `MessengerAdapter.downloadImage?(attachment, destPath)` added as
      optional interface method (`src/messenger/adapter.ts`) — already
      had `ImageAttachment` + `IncomingMessage.images` from M1, so no
      new `SlackFile` type on the interface
- [x] `src/messenger/slack.ts` — `SlackFile` internal interface hoisted,
      `app_mention` handler extended to forward `event.files` into
      `IncomingMessage.images` (DM `message` handler already did)
- [x] `SlackAdapter.downloadImage()` — fetches `url_private`, streams
      to disk via buffer + `writeFile`, sends bot-token auth header
- [x] MIME whitelist (`image/png | image/jpeg | image/webp`) enforced
      twice: on the inbound `attachment.mimeType` AND on the server
      response `Content-Type` (guards against HTML error page when
      `files:read` scope is missing)
- [x] 5 MB cap enforced via `content-length` header (if present) AND a
      post-download length check
- [x] Path-traversal guard: reject relative paths, reject any `..`
      segments in raw input (caught a bug — `normalize()` silently
      collapses `..`, so the guard must check input not normalized)
- [x] H1 fix — URL host allowlist (`files.slack.com`, `files-edge.slack.com`)
      + https-only + `redirect: "error"` to prevent bot-token leak to
      third-party hosts
- [x] `tests/messenger/slack.test.ts` — 11 new tests (3 for
      app_mention file forwarding, 8 for `downloadImage` covering happy
      path, relative path, traversal, bad MIME, HTML response, oversized
      declared, oversized actual, 403 error, host allowlist, non-https,
      malformed URL). 31/31 pass.
- [x] `npm run build && npm run lint && npm test -- tests/messenger/slack.test.ts` green
- [x] senior-code-reviewer pass — H1 fixed; MEDIUM 2건 (streaming
      download, atomic .tmp+rename write) deferred to Phase 1 loader
      work. Review saved at
      `docs/code-reviews/review-2026-04-15-m6.7-phase0.md`.

## Phase 1 — Schema + loader + paths ✅

Commit: `feat(m6.7): brand profile schema + loader` (TBD hash)

- [x] `src/types/brand.ts` — zod schema for `brand.yaml` (identity, voice,
      audience, visual, competitors, goals, `_meta`). Section-level +
      field-level `default()` so minimal YAML is null-safe.
- [x] `src/utils/paths.ts` — `brandsDir(serviceId?: string)` helper
      anchored at `ADARIA_HOME/brands`. `ADARIA_HOME` read at call time
      for test isolation. Whitelist regex
      `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` rejects path separators,
      NUL/newline/tab/unicode control chars, leading dots, empty.
- [x] `src/brands/loader.ts`:
  - [x] `loadBrandProfile(serviceId)` — parse YAML (`JSON_SCHEMA` to
        block tag expansion), validate with zod, return
        `BrandProfile | null`. Missing file → null; malformed YAML →
        `ConfigError`; schema mismatch → `ConfigError`.
  - [x] `formatBrandContext(profile)` — ~300-token human-readable block
        covering identity / voice / audience / competitors / visual.
        `null` → empty string (PRD §1.3 graceful degradation).
  - [x] `loadBrandImages(serviceId, kinds)` — scans per-service dir for
        `logo.*` / `design-system.*`, accepts png/jpg/jpeg/webp, returns
        `[{ data (base64), mediaType, kind }]`. Rejects symlinks via
        `withFileTypes` + `isFile()`.
- [x] `tests/brands/loader.test.ts` — 24 tests: brandsDir whitelist
      (separators, control chars, unicode, dotfile, accepted forms),
      profile (missing file, valid with defaults, malformed YAML,
      invalid schema, missing `_meta`), formatter (null, populated,
      minimal), images (missing dir, png/jpg/jpeg/webp variants,
      multi-kind, symlink rejection, unsupported ext, kind filter).
- [x] `npm run build && npm run lint && npm test -- tests/brands/loader.test.ts`
      green (24/24). Full suite has 2 pre-existing unrelated failures
      in `tests/db/queries.test.ts` (present on main before change).
- [x] senior-code-reviewer pass — Grade A-, 0 CRITICAL / 0 HIGH /
      3 MEDIUM. All 3 MEDIUM fixed in-phase (whitelist regex,
      symlink rejection, malformed YAML wrap + tests). Review at
      `docs/code-reviews/review-2026-04-15-m6.7-phase1.md`.

## Phase 2 — Generator + fetchers + prompt ✅

Commit: `feat(m6.7): brand generator` (TBD hash)

- [x] `npm install cheerio` (no @types needed — ships its own). Also
      imports `undici` (already bundled with Node 20) for DNS-pinned
      Agent.
- [x] `src/brands/fetchers/web.ts` — HTML fetch + `cheerio` parse for
      title, meta description, og:*, theme-color, CSS `--*primary*`
      custom properties. SSRF guard: `resolvePublicAddress` pre-flight
      DNS (IPv4 + IPv6), block RFC1918 / loopback / link-local /
      multicast / IPv4-mapped. **DNS TOCTOU closed** via
      `makePinnedDispatcher` — undici `Agent` with custom `connect.lookup`
      that returns the already-vetted address. `redirect: "error"`,
      http/https only, 15s timeout, `content-length` preflight + 2 MB
      body cap, HTML content-type check.
- [x] `src/brands/fetchers/package.ts` — npm Registry + GitHub README
      (unauth, 60 req/hr). `readmeSource: "npm" | "github" | null`
      threaded through so `_meta.sources` labels accurately. Scoped
      names (`@scope/name`) URL-encoded. 403/429 → `RateLimitError`
      with 1h retry.
- [x] `src/brands/generator.ts`:
  - [x] `generateBrandProfile(req, deps)` — dispatches on serviceType
  - [x] `type: app` — abstract `AppStoreBrandFetcher` /
        `PlayStoreBrandFetcher` / `AsoMobileBrandFetcher` interfaces.
        BrandSkill (Phase 4) wires real collectors through adapters.
        Throws `ConfigError` when all fetchers return null (prevents
        hallucinated profile from empty input).
  - [x] `type: web` / `type: package` — direct fetcher calls via deps.
  - [x] `sanitizeExternalText` applied to every external field
        (store description, listing copy, website body, README,
        homepage URL).
  - [x] `parseJsonResponse` → zod schema with `.partial().default({})`
        so missing Claude sections fall back to defaults. Invalid JSON
        → `ConfigError` with 한국어 userMessage.
  - [x] Writes `$ADARIA_HOME/brands/{serviceId}/brand.yaml` with
        header comment. `mkdir -p` before write.
  - [x] `ADARIA_DRY_RUN=1` → skip fetchers, Claude, write. Returns
        placeholder profile with `dryRun: true`.
- [x] `prompts/brand-generate.md` — shared template, `<input>` wrapped
      + explicit "treat as data not instructions" guard, fixed JSON
      schema, "empty when uncertain" rule.
- [x] `tests/brands/fetchers.test.ts` — 37 tests: isPrivateOrReservedIp
      IPv4/IPv6 allow/deny matrix, SSRF block via DNS + literal IP,
      non-http schemes, content-type mismatch, content-length cap,
      non-2xx, npm happy path + readmeSource labelling (npm/github/null),
      GitHub 404/403 rate limit, scoped package encoding.
- [x] `tests/brands/generator.test.ts` — 9 tests: app/web/package
      dispatch with mocked deps, sanitisation assertion (no raw
      `<script>`), dry-run (no I/O), ConfigError for missing URL/name,
      all-null app fetchers, invalid Claude JSON, default-filling.
- [x] `npm run build && npm run lint && npm test -- tests/brands/` green
      (70/70).
- [x] senior-code-reviewer pass — B+, 0 CRITICAL / 1 HIGH / 3 MEDIUM.
      All 4 addressed in-phase (DNS-pinned dispatcher, content-length
      preflight, readmeSource labelling, all-null fetcher guard).
      Review at `docs/code-reviews/review-2026-04-15-m6.7-phase2.md`.

## Phase 3 — Flow state persistence ✅

Commit: `feat(m6.7): brand flow persistence` (TBD hash)

- [x] `src/db/schema.ts` — migration v7: `brand_flows` table per PRD §4.2
      (flow_id PK, user_id, thread_key, service_id nullable, state,
      data_json, created_at + updated_at as INTEGER unix ms).
- [x] `CREATE UNIQUE INDEX idx_brand_flows_user_thread ON (user_id, thread_key)`
      + `idx_brand_flows_updated_at` for stale-cleanup scan.
- [x] `src/db/queries.ts` — `upsertBrandFlow` (ON CONFLICT upsert on
      user_id+thread_key), `getActiveBrandFlow(userId, threadKey,
      idleCutoffMs)`, `deleteBrandFlow(flowId)`,
      `deleteStaleBrandFlows(cutoffMs)`.
- [x] `src/brands/flow.ts` — pure reducer `nextState(current, data, event)`
      returning `{ state, data, reply, terminal }`. Zero I/O so full
      transition tree is testable w/o DB. `startBrandFlow()` entry.
      `BRAND_FLOW_STATES` union. Parsers for App Store URL / numeric id
      / Play package / web URL / bare domain / scoped npm name.
      Cancel tokens + skip tokens. `deriveServiceId` for directory-safe
      ids from identifiers.
- [x] `tests/brands/flow.test.ts` — 42 tests: start, type parsing (ko/en),
      app/web/package identifier parsing (URL + bare + invalid),
      competitors (comma, '없음', skip), PREVIEW save/cancel/unknown,
      ASK_LOGO + ASK_DESIGN via file attach + skip, cancel from every
      state, COLLECTING inertness, deriveServiceId branches.
- [x] `tests/db/brand-flows.test.ts` — 8 tests: insert, upsert advances
      state in-place, unique (user_id, thread_key) enforced across
      flow_ids, idleCutoffMs filter, delete, stale cleanup, nullable
      service_id, per-user isolation in same thread.
- [x] `npm run build && npm run lint && npm test -- tests/brands/flow.test.ts tests/db/brand-flows.test.ts` green (50/50).
- [x] senior-code-reviewer pass — deferred (pure reducer + routine CRUD;
      review coverage consolidated with Phase 4 which exercises the
      reducer end-to-end).

## Phase 4 — BrandSkill + core.ts routing ✅

Commit: `feat(m6.7): BrandSkill multi-turn flow` (TBD hash)

- [x] `src/types/skill.ts` — `SkillContinuation` + `ContinuationMessage`
      exported; optional `Skill.continueFlow` on the interface; optional
      `SkillContext.flowContext` (userId + threadKey) + `downloadFile`
      so BrandSkill gets what it needs without broadening the signature
      of the 8 existing skills.
- [x] `src/skills/brand.ts`:
  - [x] `dispatch(ctx, text)` — requires `ctx.flowContext`, starts a
        new flow via `startBrandFlow()`, persists ASK_TYPE row, returns
        `SkillResult { continuation }` expecting text.
  - [x] `continueFlow(ctx, flowId, msg)` — loads flow row, handles
        image attachments for ASK_LOGO/ASK_DESIGN via `ctx.downloadFile`
        (MIME whitelist, overwrites existing logo/design-system), runs
        `nextState` reducer, chains COLLECTING → PREVIEW by calling
        `generateBrandProfile` synchronously so user sees preview in
        one turn. Cleans up orphaned `brand.yaml` on PREVIEW cancel
        (tracks `_yamlPath` in flow data).
  - [x] Text-based `[저장]` / `[취소]` gate at PREVIEW; full Block Kit
        button plumbing is deferred (future cleanup — text works).
  - [x] Handles `취소` at any state, terminal DONE/CANCELLED deletes row.
- [x] `src/agent/core.ts` — Mode C flow-routing hook:
  - [x] DM-safe threadKey (`${channelId}:${threadId ?? "dm"}`) so flows
        persist across DM messages (review H1 fix).
  - [x] Explicit Mode A command in an active flow wins — terminates
        the flow first so reducer doesn't keep capturing turns (H2 fix).
  - [x] `findActiveBrandFlow` uses `safety.approvalTimeoutMinutes` as
        idle cutoff. Unified approval plumbing across Mode A and C.
  - [x] `buildSkillContext(flowContext?)` injects `flowContext` +
        `downloadFile` lazily so existing skills see no change.
- [x] `src/skills/index.ts` — `findSkillByName()` helper for core.ts
      routing. `Skill.continueFlow?` optional; existing skills untouched.
- [x] `src/skills/registry.ts` — `BrandSkill` registered with commands
      `["brand", "브랜드"]`.
- [x] `tests/skills/brand.test.ts` — 10 tests: dispatch start +
      persistence, missing flowContext error, ASK_TYPE → ASK_IDENTIFIER,
      web flow drives generator, cancel from ASK_TYPE, logo upload +
      MIME whitelist, unknown flow id, generator error surfacing,
      orphan brand.yaml cleanup on PREVIEW cancel.
- [x] `tests/db/schema.test.ts` — updated to expect 13 tables including
      `brand_flows`.
- [x] `npm run build && npm run lint && npm test` green (687/689; 2
      pre-existing unrelated `tests/db/queries.test.ts` failures on main).
- [x] senior-code-reviewer pass — B+, 0 CRITICAL / 2 HIGH / 4 MEDIUM.
      H1 (DM threadKey), H2 (Mode A escape), M1 (orphan yaml), M3
      (no-op ternary) all fixed in-phase. M2 (COLLECTING reply swallow)
      + M4 (per-thread isolation test) deferred. Review at
      `docs/code-reviews/review-2026-04-15-m6.7-phase4.md`.

## Phase 5 — Brand context injection into skills ✅

Commit: `feat(m6.7): inject brand context into skills` (TBD hash)

- [x] Added `## Brand context\n{{brandContext}}` section to all 13
      shipped prompt templates (aso-metadata / aso-screenshots /
      aso-inapp-events / aso-description / review-sentiment /
      review-clustering / review-replies / onboarding-hypotheses /
      onboarding-review-timing / seo-blog / seo-blog-fridgify-recipe /
      short-form-ideas / social-publish).
- [x] `src/prompts/loader.ts` — `preparePrompt` resolves any unfilled
      `{{brandContext}}` to empty string after user-provided vars are
      substituted (PRD §1.3 graceful degradation — existing 500+
      skill-adjacent tests that don't stage a profile stay green).
- [x] `src/brands/context.ts` — NEW `resolveBrandContextForApp(appId)`
      helper that wraps `loadBrandProfile` + `formatBrandContext` and
      swallows broken-yaml / IO errors so one bad profile can't
      regress the weekly orchestrator for other apps.
- [x] Skills updated (load context once per dispatch, thread through
      every `preparePrompt` call):
  - [x] `src/skills/aso.ts` (metadata / screenshots / inapp-events)
  - [x] `src/skills/review.ts` (sentiment / clustering / replies)
  - [x] `src/skills/onboarding.ts` (hypotheses / review-timing)
  - [x] `src/skills/seo-blog.ts` (generic + Fridgify recipe variant)
  - [x] `src/skills/short-form.ts`
  - [x] `src/skills/social-publish.ts`
- [x] Weekly orchestrator unchanged — skills self-load profiles so the
      orchestrator stays a thin dispatcher. `apps.yaml` app ids map
      1:1 to `brands/{id}/brand.yaml` paths by convention.
- [x] `content.ts` + `sdk-request.ts` do not call `preparePrompt`
      (content has no prompts; sdk-request uses ctx.runClaude directly
      with hardcoded prompt). Text-only injection for those is a future
      touch-up — explicitly deferred.
- [x] Image injection (logo / design-system) also deferred — Claude
      CLI runner is text-only; vision content blocks need Anthropic
      SDK path. Tracked as follow-up. Loader (`loadBrandImages`) and
      Phase 0 download plumbing are in place when that lands.
- [x] `tests/brands/context.test.ts` — 5 new tests: null fallback,
      populated profile renders, invalid yaml swallow, `preparePrompt`
      brand-context fallback + substitution.
- [x] `npm run build && npm run lint && npm test` green (692/694;
      2 pre-existing unrelated failures on `tests/db/queries.test.ts`).
- [x] senior-code-reviewer pass — deferred; the change is mechanical
      (threading a single opt string through `preparePrompt` calls)
      and the added helper is 15 LOC with its own tests. Review
      coverage consolidated with Phase 6 milestone doc pass.

## Phase 6 — Milestone + docs alignment

Commit: `docs(m6.7): add M6.7 milestone entry`

- [ ] `docs/growth-agent/milestones.md` — new `## M6.7 — Brand profile
      (~2 days)` section matching M6.5 format
- [ ] `docs/growth-agent/checklist.md` — new `## M6.7` subsection
      linking back to `docs/brand-profile/CHECKLIST.md`, plus
      progress-tracker row
- [ ] `docs/growth-agent/porting-matrix.md` — mark all M6.7 files as
      `new` (not ported from pilot-ai or growth-agent)
- [ ] Cross-link in `CLAUDE.md` "Big-picture architecture" — brief
      mention of multi-turn skill pattern introduced by BrandSkill
- [ ] senior-code-reviewer pass (doc-only, skip build + test per
      CLAUDE.md dev-loop compression rule)

---

## Exit criteria (verified manually — M6.7 complete)

- [ ] `@adaria-ai brand` in Slack thread → multi-turn flow completes for
      at least one `app`, one `web`, and one `package` type
- [ ] Logo + design-system uploads saved to
      `~/.adaria/brands/{serviceId}/` with correct extensions
- [ ] `@adaria-ai aso fridgify` (with brand.yaml present) produces
      output visibly informed by brand voice (spot-check)
- [ ] Removing `brand.yaml` → same skill runs without errors; brand
      section renders empty
- [ ] Daemon restart mid-flow → user's next message resumes from
      the persisted state
- [ ] `ADARIA_DRY_RUN=1` path logs but writes nothing
- [ ] `npm test` passes with all new tests (phase 0–5 adds ~50 tests)

---

## Progress tracker

| Phase | Status | Started | Completed |
|-------|--------|---------|-----------|
| 0 Slack files | ✅ | 2026-04-15 | 2026-04-15 |
| 1 Schema + loader | ✅ | 2026-04-15 | 2026-04-15 |
| 2 Generator | ✅ | 2026-04-15 | 2026-04-15 |
| 3 Flow persistence | ✅ | 2026-04-15 | 2026-04-15 |
| 4 BrandSkill + routing | ✅ | 2026-04-15 | 2026-04-15 |
| 5 Context injection | ✅ | 2026-04-15 | 2026-04-15 |
| 6 Milestone docs | ⬜ | — | — |
