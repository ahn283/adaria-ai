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

## Phase 0 — Slack file download plumbing

Commit: `feat(m6.7): plumb slack file downloads`

- [ ] Extend `MessengerMessage` in `src/messenger/adapter.ts` with
      `files?: SlackFile[]` (optional, other adapters pass `[]`)
- [ ] Define `SlackFile` interface: `{ name, mimetype, size, url_private_download }`
- [ ] `src/messenger/slack.ts` `#setupEventHandlers` — forward
      `event.files ?? []` into normalised message
- [ ] `SlackMessenger.downloadFile(url, destPath)` — streams
      `url_private_download` to disk with bot-token auth
- [ ] MIME whitelist (`image/png | image/jpeg | image/webp`) + 5 MB cap
      enforced in `downloadFile`
- [ ] Path-traversal guard: reject any `destPath` outside `brandsDir()`
- [ ] `tests/messenger/slack-files.test.ts` — happy path, oversized file,
      wrong MIME, 403 response, path-escape attempt
- [ ] `npm run build && npm run lint && npm test` green
- [ ] senior-code-reviewer pass — fix CRITICAL/HIGH

## Phase 1 — Schema + loader + paths

Commit: `feat(m6.7): brand profile schema + loader`

- [ ] `src/types/brand.ts` — zod schema for `brand.yaml` (identity, voice,
      audience, visual, competitors, goals, `_meta`)
- [ ] `src/utils/paths.ts` — `brandsDir(serviceId?: string)` helper
      anchored at `ADARIA_HOME/brands`
- [ ] `src/brands/loader.ts`:
  - [ ] `loadBrandProfile(serviceId)` — parse YAML, validate with zod,
        return `BrandProfile | null`
  - [ ] `formatBrandContext(profile)` — ~300-token human-readable block
  - [ ] `loadBrandImages(serviceId, types)` — glob `logo.*`,
        `design-system.*`, return `[{ data, media_type }]`
- [ ] `tests/brands/loader.test.ts` — valid yaml, missing yaml, invalid
      schema, image extension variants (png/jpg/webp), missing images
- [ ] `npm run build && npm run lint && npm test` green
- [ ] senior-code-reviewer pass

## Phase 2 — Generator + fetchers + prompt

Commit: `feat(m6.7): brand generator`

- [ ] `npm install cheerio` + `@types/cheerio` (dev)
- [ ] `src/brands/fetchers/web.ts` — HTML fetch + `cheerio` parse for
      `<title>`, `<meta name=description>`, og:*, `<link rel=icon>`,
      CSS custom properties. SSRF guard: block private IP ranges via
      DNS pre-resolution
- [ ] `src/brands/fetchers/package.ts` — npm Registry + GitHub README
      fetch (unauthenticated). Base64-decode README. Accept optional
      `githubRepo`. On 403/429 → surface rate-limit error, abort flow
- [ ] `src/brands/generator.ts`:
  - [ ] `generateBrandProfile(service, deps)` — dispatch by type
  - [ ] `type: app` — use existing `AppStoreCollector`,
        `PlayStoreCollector`, `AsoMobileCollector` via deps
  - [ ] `type: web` / `type: package` — use fetchers
  - [ ] `sanitizeExternalText` from `prompt-guard.ts` on ALL attacker-
        controllable fields (website body, README, review text)
  - [ ] Call `ctx.runClaude()` with `prompts/brand-generate.md`, parse
        JSON output, validate with zod, serialise to YAML
  - [ ] Write `brandsDir(serviceId)/brand.yaml` (mkdir -p)
  - [ ] Respect `ADARIA_DRY_RUN` — skip fetch + claude + write
- [ ] `prompts/brand-generate.md` — shared analysis template with type
      placeholder + schema instruction
- [ ] `tests/brands/fetchers.test.ts` — web SSRF block, package happy
      path, GitHub 404 fallback, rate-limit message
- [ ] `tests/brands/generator.test.ts` — all 3 types with mocked
      fetchers + mocked `ctx.runClaude`, dry-run path, injection
      sanitisation, invalid Claude JSON
- [ ] `npm run build && npm run lint && npm test` green
- [ ] senior-code-reviewer pass — extra attention to SSRF + injection

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
| 0 Slack files | ⬜ | — | — |
| 1 Schema + loader | ⬜ | — | — |
| 2 Generator | ⬜ | — | — |
| 3 Flow persistence | ⬜ | — | — |
| 4 BrandSkill + routing | ⬜ | — | — |
| 5 Context injection | ⬜ | — | — |
| 6 Milestone docs | ⬜ | — | — |
