# adaria-ai Porting Log

Living record of surprises and decisions encountered during the growth-agent → adaria-ai port. Updated through M1–M8.

## M1 — Runtime import

- **pilot-ai core.ts trim took ~1 day** — within the milestone budget but tight. The MCP context builder, tool-descriptions injection, and MCP health checks had more coupling than expected. Rewrote as a clean skeleton rather than surgical deletions.
- **eventTs vs threadId for reactions** — growth-agent Phase 1 had a bug where reactions targeted the thread root instead of the specific message. pilot-ai inherited this. Fixed by making `eventTs` a first-class field on `IncomingMessage` and targeting reactions there.
- **Session UUID pre-generation** — pilot-ai had a subtle bug where the UUID for a new session was generated in the fallback path after a msg_too_long retry, causing the session store and Claude to disagree. Fixed by pre-generating in `buildNewSession()`.

## M2 — Collectors

- **snake_case wire shapes preserved** — Eodin SDK API returns snake_case JSON. The collector preserves this rather than converting to camelCase, since the shapes are internal and converting would risk field-name divergence.
- **Rate limit handling varies** — Fridgify recipes API returns 429 with no `Retry-After` header. Added a single-retry with 2s backoff. App Store Connect returns `Retry-After` in seconds.
- **SSRF allowlists** — ASOMobile and Eodin SDK collectors validate base URLs against an allowlist. This was not present in growth-agent.

## M3 — DB + config

- **Fresh DB, no migration** — Decision 10 in the PRD: start with a clean schema. No data migration from growth-agent.db. The weekly orchestrator populates tables from scratch.
- **WAL mode** — Enables concurrent reads during the weekly orchestrator's parallel skill dispatch. growth-agent used the default journal mode.

## M4 — ASO skill

- **Competitor descriptions are attacker-controllable** — The ASO skill fetches competitor metadata from external APIs. Descriptions are truncated to 200 chars before Claude, but should ideally run through `sanitizeExternalText` before DB insertion.
- **Prompt loader** — growth-agent used inline strings. adaria-ai loads from `prompts/*.md` files with `{{var}}` substitution, making prompts easier to iterate.

## M5 — Remaining skills

- **Fridgify recipe prompt injection** — `sanitizeUserText` in `seo-blog.ts` strips `<script>`, `ignore previous instructions`, and `system:` patterns from recipe data. This matches growth-agent Phase 1's fix. Additional XML tag stripping added in `sanitizeExternalText` in `prompt-guard.ts`.
- **Review body sanitization** — `ReviewSkill` strips prompt injection patterns from review text before passing to Claude.

## M5.5 — Mode B tools

- **Tool output truncation** — `db-query` truncates at 50 rows / 10KB to prevent overwhelming Claude's context. Review body and competitor description columns are redacted.
- **Tool descriptions** — Full descriptions with safety rules are injected into the system prompt, not truncated (a pilot-ai bug had `.slice(0, 1000)` cutting off the "Important rules" section).

## M6 — Orchestrators

- **Parallel skill dispatch** — Weekly orchestrator runs skills in two waves (wave 1: ASO, onboarding, reviews; wave 2: blog, short-form, content). Each wave runs in parallel via `Promise.allSettled`.
- **Block Kit briefing** — Weekly briefing now uses Slack Block Kit (header, section, divider, context) with a plain-text fallback for non-Block-Kit clients.

## M6.5 — Social publishing

- **Twitter OAuth 1.0a** — Manual HMAC-SHA1 signature generation. The Twitter API v2 for posting requires OAuth 1.0a, while media upload uses v1.1.
- **Facebook appsecret_proof** — Required for all Graph API calls. HMAC-SHA256 of the access token with the app secret.
- **TikTok app review** — The Content Posting API requires app review by TikTok. Feature-flagged until approved.
- **Keychain namespace isolation** — Production and dev profiles use different keychain service prefixes (`adaria-ai` vs `adaria-ai-dev`) derived from `ADARIA_HOME`.

## M7 — Parity + parallel run

- **Approval callback wiring** — `core.ts` now registers pending approvals with `ApprovalManager` and stores payloads. On approval, it calls the skill's `executePost()` method via duck-typing (`"executePost" in skill`).
- **Circuit breaker on skill Claude calls** — Added in `buildSkillContext()`. Trips after 3 consecutive failures, 2-minute reset timeout.
- **Doctor auth recency** — Checks `~/.claude` modification time and warns if touched within 24h (parallel run safety).
