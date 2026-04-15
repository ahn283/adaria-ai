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

## Phase 3 — Flow state persistence

Commit: `feat(m6.7): brand flow state persistence`

- [ ] `src/db/schema.ts` — migration v7: `brand_flows` table (per PRD §4.2)
- [ ] Unique index on `(user_id, thread_key)`
- [ ] `src/db/queries.ts` — `upsertBrandFlow`, `getActiveFlow`,
      `deleteFlow`, `deleteStaleFlows` (>30 min idle)
- [ ] `src/brands/flow.ts` — pure state-machine reducer:
      `nextState(current, event) → { state, reply, persistedData }`.
      No DB calls — caller (BrandSkill) persists.
- [ ] `tests/brands/flow.test.ts` — every state transition, cancel from
      any state, invalid input at each state
- [ ] `tests/db/queries.test.ts` — brand_flows CRUD, stale cleanup,
      unique constraint
- [ ] `npm run build && npm run lint && npm test` green
- [ ] senior-code-reviewer pass

## Phase 4 — BrandSkill + core.ts routing

Commit: `feat(m6.7): BrandSkill conversational flow`

- [ ] `src/types/skill.ts` — add `SkillContinuation`, `ContinuationMessage`,
      optional `Skill.continueFlow`
- [ ] `src/skills/brand.ts`:
  - [ ] `dispatch(ctx, text)` — creates flow row, returns
        `SkillResult { continuation }` expecting type
  - [ ] `continueFlow(ctx, flowId, msg)` — advances state, handles file
        downloads via `ctx.messenger.downloadFile()`, calls generator at
        COLLECTING, renders Block Kit preview card + [저장]/[취소]
        buttons at PREVIEW, writes brand.yaml on 저장 click, returns
        next continuation or DONE
  - [ ] Preview button `action_id` encodes `flow_id` — click handler
        reuses existing approval-button plumbing from M4
  - [ ] Handles "취소" / idle cleanup
- [ ] `src/agent/core.ts` `handleMessage` — NEW flow-routing hook
      **after** auth check, **before** Mode A command match:
      query active flow → route to `BrandSkill.continueFlow` → skip
      rest of dispatch
- [ ] `core.ts` — after skill return, if `result.continuation` present:
      upsert flow row, send continuation prompt
- [ ] Register in `src/skills/registry.ts` with commands `["brand", "브랜드"]`
- [ ] `tests/skills/brand.test.ts` — full flow happy path per type,
      cancel mid-flow, idle timeout, file upload (mocked messenger),
      preview "아니오" path, dry-run path
- [ ] `npm run build && npm run lint && npm test` green
- [ ] senior-code-reviewer pass — attention to multi-turn pattern
      correctness, no regressions for one-shot skills

## Phase 5 — Brand context injection into skills

Commit: `feat(m6.7): inject brand context into skills`

- [ ] Add `## Brand context\n{{brandContext}}` to all 11 prompts:
  - [ ] `prompts/aso-metadata.md`
  - [ ] `prompts/aso-screenshots.md`
  - [ ] `prompts/aso-inapp-events.md`
  - [ ] `prompts/aso-description.md`
  - [ ] `prompts/review-sentiment.md`
  - [ ] `prompts/review-clustering.md`
  - [ ] `prompts/review-replies.md`
  - [ ] `prompts/onboarding-hypotheses.md`
  - [ ] `prompts/onboarding-review-timing.md`
  - [ ] `prompts/seo-blog.md`
  - [ ] `prompts/seo-blog-fridgify-recipe.md`
  - [ ] `prompts/short-form-ideas.md`
  - [ ] `prompts/social-publish.md`
- [ ] `src/orchestrator/weekly.ts` — per-app loop: load profile once,
      pass `brandContext` (text) + `brandImages` (array) into skill deps
- [ ] Skills updated (pass `brandContext` to `preparePrompt`):
  - [ ] `src/skills/aso.ts` (text + images for screenshots prompt only)
  - [ ] `src/skills/review.ts` (text only)
  - [ ] `src/skills/onboarding.ts` (text only)
  - [ ] `src/skills/seo-blog.ts` (text + logo)
  - [ ] `src/skills/short-form.ts` (text + logo + design-system)
  - [ ] `src/skills/sdk-request.ts` (text only)
  - [ ] `src/skills/content.ts` (text + logo + design-system, prepended
        as vision content blocks)
  - [ ] `src/skills/social-publish.ts` (text + logo + design-system)
- [ ] Existing skill tests updated — verify `brandContext` threaded
      through to `preparePrompt`; add one test per skill with brand
      profile present + one with null profile
- [ ] `npm run build && npm run lint && npm test` green
- [ ] senior-code-reviewer pass — verify no regression in skill
      behaviour when profile is null

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
| 3 Flow persistence | ⬜ | — | — |
| 4 BrandSkill + routing | ⬜ | — | — |
| 5 Context injection | ⬜ | — | — |
| 6 Milestone docs | ⬜ | — | — |
