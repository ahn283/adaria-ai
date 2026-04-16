# Brand Profile System (adaria-ai M6.7)

## Product Requirements Document

**Auto-collected Brand Context for Marketing Skills**

| Key | Value |
|-----|-------|
| Status | Draft — replaces 2026-04-14 growth-agent draft |
| Owner | Woojin & Yunjung (Eodin) |
| Date | 2026-04-15 |
| Milestone | M6.7 (follows M6.5 Social publishing, precedes M7 parity run) |
| Depends on | M5 skills, M5.5 MCP tools, M6 orchestrators, Slack `files:read` scope |

---

## 1. Overview

### 1.1 Problem Statement

adaria-ai's 7 marketing skills (ASO, SEO blog, short-form, review, onboarding,
SDK-request, social-publish) generate content with only `app.name` and
`app.primary_keywords` from `apps.yaml`. Output is generic: review replies
sound identical across Fridgify / Arden / Tempy; blog hero copy has no
brand voice; Pinterest pins lack visual direction.

The brand data is already public — App Store listings, landing pages, npm
READMEs — but nothing extracts and structures it for prompt injection.

### 1.2 Solution

Auto-generate a structured `brand.yaml` per **service** (app, web, or
package) via a **multi-turn BrandSkill** driven through Slack conversation.
The skill collects public data, runs Claude analysis, saves to
`~/.adaria/brands/{serviceId}/`, and accepts optional logo + design-system
image uploads in the same conversation. Existing skills then inject the
brand context into every prompt.

### 1.3 Design Principles

- **Skill-native** — BrandSkill is a regular Mode A skill with a new
  multi-turn pattern. Mode B MCP tool set (read-only, 4 tools) is not
  expanded.
- **Conversation-driven** — type / URL / images are collected through
  Slack dialog, not CLI flags or YAML pre-editing.
- **Service-agnostic** — same `brand.yaml` schema for app / web / package.
- **Decoupled from `apps.yaml`** — BrandSkill writes only `brand.yaml`.
  `apps.yaml` (which drives the weekly orchestrator) is unchanged.
- **Graceful degradation** — skills run identically when no `brand.yaml`
  exists. `{{brandContext}}` resolves to an empty string.
- **Selective injection** — text context to all skills; images only to
  skills that produce visual output.

---

## 2. Service Types & Collection

| Type | Example | Identifier(s) asked | Collectors used |
|------|---------|---------------------|-----------------|
| `app` | Fridgify, Arden, Tempy | store URL(s) | `AppStoreCollector`, `PlayStoreCollector`, `AsoMobileCollector` (existing, M2) |
| `web` | eodin.app | website URL | new `fetchWebData(url)` — HTML + meta/OG + CSS, parsed with `cheerio` |
| `package` | `@eodin/analytics-sdk` | npm name, optional GitHub repo | new `fetchPackageData(npmName, githubRepo?)` — npm Registry + GitHub README (unauthenticated, 60 req/hr limit) |

All three paths feed the same Claude analysis prompt
(`prompts/brand-generate.md`) and emit the same `brand.yaml` schema.

---

## 3. `brand.yaml` Schema

```yaml
# Auto-generated — do not hand-edit voice/audience sections. Edit goals/visual manually.
_meta:
  service_type: app                  # app | web | package
  generated_at: "2026-04-15T08:00:00Z"
  sources: ["appstore", "playstore", "asomobile"]
  identifiers:                       # source-of-truth for BrandSkill re-gen
    appstore_id: "123456789"
    playstore_id: "com.eodin.fridgify"

identity:
  tagline: "Never waste food again"
  mission: "Help people reduce food waste by tracking what's in their fridge"
  positioning: "Simple, friendly fridge management for busy people"
  category: "Food & Drink"

voice:
  tone: "friendly, casual, encouraging"
  personality: "like a helpful roommate who reminds you about groceries"
  do: ["use simple language", "be encouraging about small wins"]
  dont: ["be preachy about waste", "use technical jargon"]

audience:
  primary: "Young professionals (25-35) living alone or with roommates"
  pain_points: ["forgetting what's in the fridge", "food going bad"]
  motivations: ["saving money", "reducing waste"]

visual:
  primary_color: ""                  # manual override only
  style: "clean, minimal, food-photography friendly"

competitors:
  differentiation: "Simplest UX — add items by photo, not manual entry"

goals:
  current_quarter: ""                # manual via future Slack command
  key_metrics: []
```

Images stored alongside:

- `~/.adaria/brands/{serviceId}/logo.{ext}`
- `~/.adaria/brands/{serviceId}/design-system.{ext}`

`{ext}` preserves original MIME: `image/png → .png`, `image/jpeg → .jpg`,
`image/webp → .webp`. Overwrites on re-upload; only one logo + one
design-system per service.

---

## 4. Architecture

### 4.1 File layout

```
src/
  brands/
    loader.ts          # brand.yaml + image loading, formatBrandContext()
    generator.ts       # type dispatch → collect → Claude analyze → write yaml
    fetchers/
      web.ts           # HTML/meta/OG/CSS fetch + parse
      package.ts       # npm Registry + GitHub README fetch
    flow.ts            # conversation state machine (stateless; state in DB)
  skills/
    brand.ts           # BrandSkill — dispatch + continue entry points
  db/
    schema.ts          # + brand_flows table (migration v7)
    queries.ts         # + brand_flows CRUD
  messenger/
    slack.ts           # + event.files forwarding + downloadFile() helper
  utils/
    paths.ts           # + brandsDir(serviceId)
prompts/
  brand-generate.md    # shared Claude analysis prompt (all 3 types)
tests/
  brands/
    loader.test.ts
    generator.test.ts
    fetchers.test.ts
    flow.test.ts
  skills/
    brand.test.ts
  messenger/
    slack-files.test.ts
```

### 4.2 Multi-turn skill pattern (new)

Until M6.7, every skill is one-shot: `dispatch(ctx, text) → SkillResult`
and the thread ends. BrandSkill introduces a continuation pattern the
runtime must support.

**New types (in `src/types/skill.ts`):**

```ts
interface SkillContinuation {
  flowKind: "brand";                 // extensible for future multi-turn skills
  flowId: string;                    // ULID
  expects: "text" | "file" | "either";
  prompt: string;                    // shown to user by core.ts
}

interface SkillResult {
  // ...existing fields
  continuation?: SkillContinuation;  // when set, skill is awaiting user reply
}

interface Skill {
  dispatch(ctx: SkillContext, text: string): Promise<SkillResult>;
  // new optional entry point for continuation:
  continueFlow?(ctx: SkillContext, flowId: string, msg: ContinuationMessage): Promise<SkillResult>;
}

interface ContinuationMessage {
  text: string;
  files: SlackFile[];                // empty array if no attachments
}
```

**`brand_flows` table (migration v7):**

| column | type | notes |
|---|---|---|
| flow_id | TEXT PRIMARY KEY | ULID |
| user_id | TEXT NOT NULL | Slack user |
| thread_key | TEXT NOT NULL | `{channel_id}:{thread_ts}` |
| service_id | TEXT | set after ASK_IDENTIFIER |
| state | TEXT NOT NULL | enum (see §4.3) |
| data_json | TEXT NOT NULL | partial brand data accumulated so far |
| created_at | INTEGER NOT NULL | unix ms |
| updated_at | INTEGER NOT NULL | unix ms; flows idle > 30 min are abandoned |

Unique index on `(user_id, thread_key)` — at most one active flow per
thread per user.

**`core.ts` routing change (`handleMessage` entry):**

```
1. auth allowlist check (existing)
2. NEW: query brand_flows for (userId, thread_key) where updated_at > now - 30m
   - if hit → call BrandSkill.continueFlow(ctx, flowId, {text, files})
   - else → continue to existing Mode A / Mode B dispatch
3. After skill returns, if SkillResult.continuation present:
   - upsert brand_flows row (state advanced, data_json merged)
   - post continuation.prompt to Slack as follow-up message
```

### 4.3 Conversation states (owned by BrandSkill)

```
IDLE
  ↓ first mention: "@adaria-ai brand" (or "브랜드")
ASK_TYPE                 "app / web / package 중 어떤 서비스야?"
  ↓ user replies type
ASK_IDENTIFIER           type별 질문:
                           app: "App Store 또는 Play Store URL 줘"
                           web: "웹사이트 URL 줘"
                           package: "npm 패키지 이름 줘"
  ↓ valid identifier
(app only)
  ASK_COMPETITORS        "경쟁 앱 bundleID 있으면 콤마로. (스킵: '없음')"
  ↓
COLLECTING               [no user input — auto]
  - dispatch to type-specific fetcher
  - ctx.runClaude(prompts/brand-generate.md, …)
  - parse JSON → brand.yaml in-memory
  ↓
PREVIEW                  Block Kit 카드 (identity / voice / audience /
                         visual / competitors) + [저장] [취소] 버튼
  ↓ [저장] 클릭
ASK_LOGO                 "로고 이미지 업로드 (PNG/JPG/WEBP ≤ 5MB, 스킵: '건너뛰기')"
  ↓ file or skip
ASK_DESIGN               "디자인 시스템 이미지 (스킵: '건너뛰기')"
  ↓ file or skip
DONE                     "✅ brands/{serviceId}/ 저장 완료. 주간 분석에 반영하려면 apps.yaml에 추가해."
  → flow row deleted
```

Abort paths: user says "취소" at any state → flow deleted, "취소됨" reply.
30-min idle → background cleanup deletes row; next user message starts fresh.

### 4.4 Slack file handling

**Scope requirement (one-time setup — blocks Phase 0 exit):**
Slack app dashboard → OAuth & Permissions → Bot Token Scopes → add
`files:read` → reinstall workspace. Without this, `url_private_download`
returns 403.

**Plumbing (Phase 0):**

- `src/messenger/slack.ts` `#setupEventHandlers`: forward `event.files`
  into the normalised `MessengerMessage` as `files: SlackFile[]`.
- Add `SlackMessenger.downloadFile(url, destPath): Promise<void>` —
  fetches `url_private_download` with `Authorization: Bearer <botToken>`,
  streams to `destPath`.
- MIME validation: accept `image/png`, `image/jpeg`, `image/webp` only.
- Size cap: 5 MB (reject with polite reply).
- Filename sanitisation: ignore user-supplied name. Write to
  `brandsDir(serviceId) / (logo|design-system).{extFromMime}`.
- Overwrite behaviour: before writing, `rm` any existing `logo.*` or
  `design-system.*` in that dir (pattern glob) so extension changes
  don't leave stale files.

### 4.5 Brand context injection (Phase 5)

All 11 prompt templates get a shared section:

```markdown
## Brand context
{{brandContext}}
```

`formatBrandContext(profile)` → ~300-token human-readable block covering
identity / voice / audience / competitors / visual.style. Null-safe:
returns empty string when no profile exists.

**Text + image injection per skill:**

| Skill | Text | Logo | Design system | Rationale |
|-------|:---:|:---:|:---:|---|
| `content` (Pinterest) | ✓ | ✓ | ✓ | Visual output |
| `short-form` | ✓ | ✓ | ✓ | Intro/outro branding |
| `aso` (screenshots only) | ✓ | ✓ | ✓ | Screenshot redesign |
| `aso` (metadata prompts) | ✓ | — | — | Text-only |
| `seo-blog` | ✓ | ✓ | — | Hero image direction |
| `review` | ✓ | — | — | Tone only |
| `onboarding` | ✓ | — | — | Positioning context |
| `sdk-request` | ✓ | — | — | Positioning context |
| `social-publish` | ✓ | ✓ | ✓ | Visual + voice |

Image injection format (Claude vision content blocks): prepend to the
user-content array **before** the text block to maximise prompt cache
hit rate across calls.

### 4.6 Approval

- **No approval gate.** BrandSkill writes only to `~/.adaria/brands/` —
  local files, user-driven. Not added to `safety.ts`.
- **No dry-run flag.** The original PRD added an `ADARIA_DRY_RUN=1`
  short-circuit; it was removed in M7-cleanup along with every other
  dry-run branch. The user-facing PREVIEW step gates the disk write.

---

## 5. Token cost

| Component | Tokens | Frequency | Est. monthly |
|-----------|--------|-----------|--------------|
| `brandContext` text | ~300 | every skill call (~30/week) | negligible (cached) |
| logo image | ~800 | visual skills (~10/week) | ~$0.03 |
| design-system image | ~1,600 | visual skills (~10/week) | ~$0.05 |
| Brand generation | ~5 k in + ~2 k out | on demand (a few per year) | ~$0.05/run |

Prompt caching: brand context is static across calls, so placing it
at the top of the prompt (before dynamic user content) lets the Claude
CLI runner cache it at the session level.

---

## 6. Files to create / modify

### New (Phase 1–5)

| File | Phase |
|------|-------|
| `src/types/brand.ts` | 1 |
| `src/utils/paths.ts` — `brandsDir()` | 1 |
| `src/brands/loader.ts` + test | 1 |
| `src/brands/fetchers/web.ts` + test | 2 |
| `src/brands/fetchers/package.ts` + test | 2 |
| `src/brands/generator.ts` + test | 2 |
| `prompts/brand-generate.md` | 2 |
| `src/db/schema.ts` — `brand_flows` migration v7 | 3 |
| `src/db/queries.ts` — brand_flows helpers + tests | 3 |
| `src/brands/flow.ts` — state machine + test | 3 |
| `src/skills/brand.ts` — dispatch + continueFlow + test | 4 |

### Modified

| File | Phase | Change |
|------|-------|--------|
| `src/messenger/slack.ts` | 0 | forward `event.files`, add `downloadFile()` |
| `src/messenger/adapter.ts` | 0 | extend `MessengerMessage` with `files?` |
| `src/types/skill.ts` | 4 | add `SkillContinuation`, `continueFlow?` |
| `src/agent/core.ts` | 4 | flow routing hook at handleMessage entry |
| `src/skills/registry.ts` | 4 | register `BrandSkill` with commands `["brand", "브랜드"]` |
| `src/skills/aso.ts`, `review.ts`, `onboarding.ts`, `seo-blog.ts`, `short-form.ts`, `sdk-request.ts`, `content.ts`, `social-publish.ts` | 5 | load brand profile, pass `brandContext` + images |
| `prompts/*.md` (11 files) | 5 | add `## Brand context\n{{brandContext}}` section |
| `src/orchestrator/weekly.ts` | 5 | load brand profile per app, pass into skill deps |

---

## 7. Security

- **Slack allowlist**: existing `auth.ts` still gates every message.
  Flow routing happens **after** auth check.
- **Prompt injection**: external text (website copy, README, reviews)
  is routed through `sanitizeExternalText` from `prompt-guard.ts`
  before being embedded in the Claude generate prompt. Fridgify-recipe
  style attacker-controlled fields are stripped.
- **SSRF on web / package fetchers**: reuse the `safe-fetch` allowlist
  pattern already in collectors (`src/collectors/eodin-sdk.ts`
  precedent). For `web` type, the URL is user-supplied so **block
  private IP ranges** (RFC1918, loopback, link-local) via DNS resolution
  check; fail closed.
- **File downloads**: MIME whitelist, 5 MB cap, fixed output path
  (no traversal), overwrite-existing semantics.
- **Secrets**: no new credentials. GitHub unauthenticated API is used
  for public READMEs (60 req/hr per IP — generous for this workload).
  On 403 / 429, surface "GitHub rate limit — 1시간 뒤 재시도해" and
  abort the flow cleanly. No token storage in v1; revisit if users
  hit the limit in practice.

---

## 8. Verification

1. `npm run build && npm run lint && npm test` green.
2. **Flow E2E (manual, via `@adaria-ai brand` in DM or channel thread):**
   - type: app → store URL → preview → skip images → brand.yaml exists
   - type: web → URL → preview → upload logo → `logo.png` exists
   - type: package → npm name → GitHub repo → preview → upload both
   - "취소" mid-flow → flow row deleted, no partial yaml written
   - 30-min idle → next message starts fresh flow
3. **Graceful fallback**: rename `~/.adaria/brands/fridgify/` → run
   `@adaria-ai aso fridgify` → skill succeeds, prompts contain empty
   `Brand context` section.
4. **Image injection**: place known logo → run `content-agent` skill →
   verify Claude API call payload contains image block (inspect audit
   log).
5. **Cancel at PREVIEW**: complete the flow up to PREVIEW, reply
   `취소` → `brand.yaml` is removed (orphan cleanup) and the flow row
   is deleted.

---

## 9. Out of scope (future)

- DM-only brand flow (current design requires `@adaria-ai` mention
  each turn; DM-no-mention routing is a future simplification).
- Auto re-generation when public data changes (cron).
- Brand profile edit command (`@adaria-ai brand edit fridgify voice`).
- Cross-service Eodin-level brand guidelines.
- Auto-download of store screenshots as reference images.
- Auto-detect service type from URL/identifier pattern.
- Store brand images in Eodin Growth service (remote), not just local.

---

## 10. Decisions

1. **Web HTML parser**: `cheerio` — battle-tested, ~500 kB is acceptable
   for a CLI tool. Regex on real-world HTML is a time bomb.
2. **GitHub API**: unauthenticated — 60 req/hr is ample for this
   workload (a few brand generations per month). On rate-limit, surface
   a polite "1시간 뒤 재시도해" error. Add optional `GITHUB_TOKEN` only
   if limits are hit in practice.
3. **Flow storage**: SQLite `brand_flows` table. Daemon restarts are
   not rare and a half-done flow should resume from the persisted state.
4. **Preview format**: Block Kit card with `[저장]` / `[취소]` buttons.
   Brand profile has many sections (identity / voice / audience /
   visual / competitors) that benefit from structured rendering. Reuses
   the existing approval-button plumbing from M4 — button `action_id`
   encodes the `flow_id` and the click advances the flow state.
   `ASK_LOGO` / `ASK_DESIGN` states still use file upload + "건너뛰기"
   text input (no button for skip to keep the upload UX clean).
