# adaria-ai — Product Requirements Document

**Status:** Draft v1 (2026-04-12)
**Owner:** Woojin Ahn
**Target release:** v0.1.0 (M9, ~10 focused dev days from M0)
**Source planning docs:** `README.md`, `folder-structure.md`, `porting-matrix.md`, `milestones.md`, `open-questions.md` (this directory)

---

## 1. Overview

adaria-ai is a single-user, local-first marketing operations agent for the
Adaria.ai app portfolio (Fridgify, Arden TTS, Tempy, and future apps). It
runs as a macOS launchd daemon, receives commands and questions via Slack,
orchestrates data collection from 8 marketing sources, dispatches Claude-
powered analysis skills, and delivers weekly briefings with approval-gated
write actions (blog publish, review reply, metadata change).

It is the successor to `eodin-growth-agent`, rebuilt on pilot-ai's runtime
bones plus growth-agent's domain logic. The rebuild is motivated by a wide
gap in reliability and developer ergonomics between the two codebases — a
gap that made continued in-place fixes to growth-agent more expensive than a
clean port.

## 2. Problem

The current `eodin-growth-agent` has accumulated structural issues that
block reliable day-to-day operation:

- **No session continuity** for Slack conversations
- **No audit log** for actions Claude takes
- **No circuit breaker** for Claude CLI failures — cascading errors
- **No spawn-based runner** — subprocess lifecycle is fragile
- **No doctor command** — misconfigurations surface as cryptic runtime errors
- **Silent-failure bug** (fixed in Phase 1, still pending upstream commit)

Meanwhile, a sibling project (`pilot-ai`) has already solved every one of
these. Rewriting growth-agent on top of pilot-ai's runtime is cheaper than
backporting these improvements piecemeal.

Separately, the existing growth-agent is **command-only**: users must issue
explicit commands like `aso fridgify`. There is no conversational path, so
free-form questions ("이번 주 리뷰 분위기 어때?") are not supported.
adaria-ai adds this as a first-class mode via Claude tool use (MCP).

## 3. Goals & non-goals

### Goals (v0.1.0)

1. **Reliability parity with pilot-ai.** Spawn-based Claude runner, session
   store, circuit breaker, audit log, prompt-guard, doctor command — all
   battle-tested modules from pilot-ai ship in adaria-ai from M1.
2. **Functional parity with growth-agent.** All 8 collectors, all 7 skill
   agents, weekly briefing, daily monitor, approval gates — ported from
   growth-agent and verified against a Sunday-over-Sunday briefing diff.
3. **Conversational Slack interaction.** Free-form `@adaria-ai` mentions
   are handled by Claude with read-only MCP tools against the marketing
   domain (DB, collectors, past briefings, app metadata).
4. **Installable distribution.** `npm install -g adaria-ai` + `adaria-ai
   init` on any macOS box reaches a running state in under 5 minutes.
5. **Safe cutover.** Parallel run during M7, 1-minute launchctl rollback
   path during M8, no data loss.
6. **Multi-platform social publishing.** Claude generates platform-optimised
   marketing content (text + hashtags + image selection) and posts via
   approval-gated write paths to Twitter/X, Facebook, Threads, TikTok,
   YouTube Community, and LinkedIn. Reference implementation patterns from
   `~/Github/linkgo/ai-service/src/social/` (Python → TypeScript port).

### Non-goals (v0.1.0)

- **Not a SaaS.** Single-user launchd daemon. The Adaria.ai SaaS product
  (`~/Github/adaria-new`) is a separate concern.
- **Not multi-user.** Slack allowlist (2 user IDs) stays. No tenancy.
- **No UI beyond Slack.** Dashboards are Slack Block Kit messages, not a
  web app.
- **Not a refactor of pilot-ai.** One-time fork at M1; no upstream-sync
  routine. Post-fork improvements are made in adaria-ai directly.
- **No personal-agent tooling.** Browser, filesystem, Figma, Notion,
  Obsidian, VS Code, Google Workspace, calendar, email — none of pilot-ai's
  tool implementations are ported.
- **No third-party MCP servers.** Google Ads / Search Console / Apple Search
  Ads MCP servers are deferred to Phase 2.
- **No automatic scheduling of social posts.** Posts are generated on
  demand (`@adaria-ai social fridgify`) or as part of the weekly briefing,
  but always approval-gated. No calendar-based auto-publish queue.
- **No long-term memory.** Pilot-ai's `~/.pilot/memory/` is not ported in
  v0.1.0. Per-thread session memory still exists.

## 4. Users

| User | Role | How they interact |
|------|------|-------------------|
| Woojin Ahn | Product + growth operator | Slack mentions, approval buttons, weekly briefing, CLI setup |
| Team member (1 add'l in allowlist) | Review approver | Slack mentions (read-only), approval buttons |

**Allowlist:** 2 Slack user IDs (U0A0UB94XRT, U0A15HYJBV2). Any other user
mentioning the bot is rejected by `security/auth.ts`.

**Primary channel:** `#growth` for weekly briefings and daily monitor
alerts. DM channels for ad-hoc questions.

## 5. Product surface

### 5.1 Slack interaction — two modes

**Mode A — explicit command**

```
@adaria-ai aso fridgify
@adaria-ai reviews arden
@adaria-ai blog fridgify
@adaria-ai 리뷰 분석 tempy
```

`core.ts` matches a command prefix and dispatches into the skill registry.
The skill runs its collector(s), calls Claude CLI with a domain prompt, and
posts a formatted Block Kit response. Heavy skills (blog generation, review
reply drafting) produce approval buttons wired to `safety.ts`
ApprovalManager.

**Mode B — conversational mention**

```
@adaria-ai 이번 주 프리지파이 리뷰 분위기 어때?
@adaria-ai 최근에 잘 오른 키워드 뭐 있어?
@adaria-ai 아덴 TTS 지난달 대비 어때?
```

No command prefix matches → `core.ts` falls through to Claude CLI with the
four read-only MCP tools registered. Claude decides which tool(s) to call
against SQLite, collectors, past briefings, or app metadata, then composes
the answer. **Mode B is strictly read-only** — heavy skills and write paths
are not exposed to Claude.

**Common to both modes:**
- Thinking reaction (🤔) on the original message while working
- Status message evolves in place ("Collecting reviews…" → "Analyzing…" → final answer)
- Success (✅) or failure (❌) reaction on completion
- Session continuity — threaded replies share context within the same Slack thread
- Audit log entry for every invocation
- Circuit breaker trips after N consecutive Claude CLI failures

### 5.2 CLI surface

```bash
adaria-ai init        # interactive setup wizard
adaria-ai start       # load daemon + weekly + monitor launchd plists
adaria-ai stop        # unload all three plists
adaria-ai status      # print state of all three launchd jobs
adaria-ai logs        # tail ~/.adaria/logs/
adaria-ai doctor      # run health checks (claude auth, slack scopes, collectors, db)
adaria-ai daemon      # foreground daemon (invoked by launchd, not by humans)
adaria-ai analyze     # one-shot weekly orchestrator (invoked by launchd cron)
adaria-ai monitor     # one-shot daily monitor (invoked by launchd cron)
adaria-ai adduser|removeuser|listusers   # allowlist management
```

### 5.3 Cron-driven automation

Three separate launchd user agents, installed by `adaria-ai start`:

| Label | Schedule | Command | Purpose |
|-------|----------|---------|---------|
| `com.adaria-ai.daemon` | Always on, auto-restart | `adaria-ai daemon` | Reactive Slack event handler |
| `com.adaria-ai.weekly` | Sun 23:00 UTC | `adaria-ai analyze` | Full weekly analysis, briefing to #growth |
| `com.adaria-ai.monitor` | Daily 23:00 UTC | `adaria-ai monitor` | Threshold-based alerts |

Rationale: the reactive daemon must never block on long-running analysis.
Separate plists make weekly/daily runs independently reproducible via
`launchctl kickstart` with direct stdout/stderr capture.

## 6. Functional requirements

### 6.1 Skills (8)

Each skill implements `Skill { name, commands[], schedule?, dispatch(ctx, app) }`.

| Skill | Reads from | Writes via (approval-gated) | Weekly? |
|-------|------------|-----------------------------|---------|
| AsoSkill | App Store Connect, Play Store, ASOMobile | metadata change | ✅ |
| ReviewSkill | App Store + Play Store reviews | review reply | ✅ |
| OnboardingSkill | Eodin SDK (funnel, cohort, SDK requests) | — | ✅ |
| SeoBlogSkill | Eodin Blog + Search Console + GA4 + Fridgify recipes | blog publish | ✅ |
| ShortFormSkill | YouTube Data API | — | ✅ |
| SdkRequestSkill | Eodin SDK request aggregation | sdk_request | ✅ |
| ContentSkill (possibly folded into ShortForm) | — | — | ✅ |
| SocialPublishSkill | Past briefings, app metadata, DB trends | social_publish (6 platforms) | ✅ |

### 6.2 Collectors (8)

All in `src/collectors/`, all ported from growth-agent JS to TS:

- `appstore.ts` — App Store Connect (JWT)
- `playstore.ts` — Google Play Developer API
- `eodin-sdk.ts` — Eodin SDK (installs, DAU, funnel, cohort, requests)
- `eodin-blog.ts` — Eodin Blog Publisher + Search Console + GA4
- `asomobile.ts` — ASOMobile keyword rankings
- `fridgify-recipes.ts` — Fridgify public API (recipes)
- `youtube.ts` — YouTube Data API
- `arden-tts.ts` — Arden TTS metrics

### 6.3 MCP tools (4, NEW)

Exposed to Claude in Mode B via pilot-ai's MCP framework. All **read-only**.

| Tool | Input schema | Output |
|------|--------------|--------|
| `db-query` | `{ table: enum, where?, orderBy?, limit? }` — table whitelist enforced | JSON rows, truncated at 50 rows / 10KB |
| `collector-fetch` | `{ collector: enum, app: string, fresh?: bool }` — cache-aware | Latest row(s) from named collector |
| `skill-result` | `{ skill: enum, app: string, limit: number }` | Last-N weekly briefing blobs |
| `app-info` | `{ app?: string }` | Parsed `apps.yaml` metadata |

**Excluded from tool surface (ever):** writes, shell, filesystem, arbitrary
HTTP, skill invocation.

### 6.4 Orchestrators (2)

| Orchestrator | Trigger | Behaviour |
|--------------|---------|-----------|
| `weekly.ts` | `adaria-ai analyze` via launchd Sun 23:00 UTC | Iterate apps → dispatch weekly skills in parallel → assemble WeeklyReport → send Block Kit briefing → aggregate approvals in one Slack message |
| `monitor.ts` | `adaria-ai monitor` via launchd daily 23:00 UTC | Threshold checks (rating drop, ranking drop, conversion drop) → fire alerts if breached |

### 6.5 Approval flow

`safety.ts` merges pilot-ai's ApprovalManager base with growth-agent's
domain gates. Gate types:

- `blog_publish` — before `EodinBlogPublisher.publish`
- `metadata_change` — before App Store / Play Store metadata update
- `review_reply` — before posting a reply to a user review
- `sdk_request` — before marking an SDK request as handled
- `social_publish` — before posting to any social media platform

### 6.6 Social publishing (6 platforms, NEW)

`SocialPublishSkill` generates platform-optimised marketing content for
each app and posts via approval-gated write paths. Reference implementation
patterns ported from `~/Github/linkgo/ai-service/src/social/` (Python →
TypeScript).

#### Supported platforms

| Platform | Client file | API / SDK | Auth method |
|----------|-------------|-----------|-------------|
| Twitter/X | `src/social/twitter.ts` | Twitter API v2 (post) + v1.1 (media upload) | OAuth 1.0a (API key + access token) |
| Facebook | `src/social/facebook.ts` | Facebook Graph API v19.0 | Page Access Token + `appsecret_proof` |
| Threads | `src/social/threads.ts` | Threads API (Meta Graph API) | Long-lived user token |
| TikTok | `src/social/tiktok.ts` | TikTok Content Posting API | OAuth 2.0 (client credentials + user token) |
| YouTube | `src/social/youtube.ts` | YouTube Data API v3 (community posts) | OAuth 2.0 (service account or user token) |
| LinkedIn | `src/social/linkedin.ts` | LinkedIn REST API v2 | OAuth 2.0 (access token + refresh) |

#### Flow

1. `@adaria-ai social fridgify` or weekly orchestrator triggers
   `SocialPublishSkill.dispatch(ctx, app)`
2. Skill reads recent briefing data (ASO highlights, review trends, blog
   posts) from DB to build context
3. Claude generates platform-specific content (respecting character limits,
   hashtag conventions, tone per platform) using `prompts/social-publish.md`
4. Skill produces `ApprovalItem[]` — one per platform, each showing the
   draft text + target platform
5. Approval buttons in Slack → approver clicks → `social_publish` gate
   fires → platform client posts
6. Result (post ID, URL) written to `social_posts` DB table + audit log

#### Platform-specific constraints

| Platform | Max text | Image support | Link preview |
|----------|----------|---------------|--------------|
| Twitter/X | 280 chars | Yes (media upload API v1.1) | Auto from URL |
| Facebook | 63,206 chars | Yes (photo upload) | Auto from link |
| Threads | 500 chars | Yes (image container) | No |
| TikTok | 2,200 chars (caption) | Video/image required | No |
| YouTube | 5,000 chars (community) | Yes (image post) | Auto |
| LinkedIn | 3,000 chars | Yes (image upload) | Auto from URL |

#### Config

Social platform credentials are stored in `~/.adaria/config.yaml` under
`social:` namespace, with secrets in macOS Keychain (same pattern as
collector credentials). Per-app platform enablement is in `apps.yaml`:

```yaml
# apps.yaml
fridgify:
  social:
    twitter: true
    facebook: true
    threads: true
    tiktok: false     # no TikTok account yet
    youtube: true
    linkedin: true
```

#### `ADARIA_DRY_RUN=1` behaviour

All platform clients check `ADARIA_DRY_RUN`. When set, they log the
full request payload that would be sent but do not call the API. This is
essential for M7 parallel run safety.

Each gate:
1. Skill produces a draft + context (what, why, risk)
2. Slack message with Block Kit approve / reject buttons
3. Approver clicks → audit log entry → action fires OR is abandoned
4. Approver is rejected if not in allowlist (double-check beyond Slack identity)

## 7. Non-functional requirements

### 7.1 Security

- **Allowlist enforcement** — every inbound Slack event passes through
  `security/auth.ts`. Non-allowlisted user IDs are ignored silently.
- **Prompt-guard** — inbound user text runs through `security/prompt-guard.ts`
  before reaching Claude. Known injection patterns rejected.
- **Read-only MCP tools** — Mode B tool surface has no write path. Whitelist
  enforced at tool implementation level, not trust-based.
- **Secrets never bundled** — all tokens live in `~/.adaria/config.yaml` on
  the user's machine, written by `adaria-ai init`. Npm tarball contains no
  credentials.
- **Audit log** — every Claude invocation, skill dispatch, approval action
  is written to `~/.adaria/audit.jsonl` with timestamp, user, action, outcome.
- **Fridgify recipe prompt injection** — re-validated in TypeScript with the
  same escaping + test cases from growth-agent Phase 1.
- **Social platform tokens** — stored in macOS Keychain, never in config
  files or npm tarball. Token refresh handled per-platform. `social_publish`
  approval gate prevents unintended posts.

### 7.2 Reliability

- **Spawn-based Claude runner** — subprocess lifecycle managed, not
  `child_process.exec` string concatenation.
- **Circuit breaker** — N consecutive Claude failures trips the breaker;
  daemon posts a Slack alert and stops invoking until reset.
- **Session continuity** — threaded Slack replies share session state via
  `~/.adaria/sessions.json`.
- **msg_too_long fallback** — `conversation-summary.ts` compresses history
  when Claude rejects oversized input.
- **Auto-restart** — launchd `KeepAlive` on daemon plist. Crash → restart
  within seconds.
- **Rollback path** — during M8 cutover, unloading adaria-ai plists and
  reloading growth-agent plists takes under 1 minute.

### 7.3 Performance

- **Slack event latency (Mode A command, cached data):** < 5s to thinking reaction, < 30s to final answer
- **Slack event latency (Mode A command, fresh collection):** < 3 min per skill
- **Slack event latency (Mode B conversational):** < 15s to final answer (read-only tools are cheap)
- **Weekly analysis duration:** < 20 min total across 3 apps × 7 skills
- **Daemon memory footprint:** < 300 MB steady state
- **Daemon startup time:** < 5s from launchctl load to first event ready

### 7.4 Observability

- `~/.adaria/logs/daemon.{out,err}.log` — tailed via `adaria-ai logs`
- `~/.adaria/logs/weekly.{out,err}.log` — weekly orchestrator output
- `~/.adaria/logs/monitor.{out,err}.log` — monitor output
- `~/.adaria/audit.jsonl` — structured event log
- `adaria-ai doctor` — one-shot health snapshot covering Claude auth, Slack
  scopes, collector credentials, DB connectivity, apps.yaml validity, MCP
  tool registration

## 8. Architecture (high level)

```
┌──────────────┐    app_mention     ┌─────────────────────────┐
│  Slack user  │───────────────────▶│  messenger/slack.ts     │
└──────────────┘                    │  (pilot-ai, +eventTs)   │
                                    └──────────┬──────────────┘
                                               │ handleMessage
                                               ▼
                                    ┌─────────────────────────┐
                                    │  agent/core.ts          │
                                    │  ├ security/auth.ts     │
                                    │  ├ security/prompt-guard│
                                    │  ├ agent/session.ts     │
                                    │  └ agent/audit.ts       │
                                    └───┬─────────────────────┘
                          cmd match?   │
                              ┌────────┴────────┐
                     yes (Mode A)        no (Mode B)
                              │                 │
                              ▼                 ▼
              ┌───────────────────────┐   ┌──────────────────────────┐
              │  skills/index.ts      │   │  agent/claude.ts          │
              │  (registry + dispatch)│   │  spawned with MCP config  │
              └──────┬────────────────┘   │  ┌─────────────────────┐  │
                     │                    │  │ tools/db-query.ts   │  │
                     ▼                    │  │ tools/collector-...  │  │
          ┌─────────────────────────┐     │  │ tools/skill-result  │  │
          │  skills/aso.ts          │     │  │ tools/app-info      │  │
          │  skills/review.ts       │     │  └─────────────────────┘  │
          │  skills/seo-blog.ts     │     └──────┬───────────────────┘
          │  skills/onboarding.ts   │            │ Claude tool use
          │  skills/short-form.ts   │            ▼
          │  skills/sdk-request.ts  │       SQLite / collectors
          │  skills/content.ts      │
          └──┬──────────────────────┘
             │ runs collectors, calls claude.ts with prompts
             ▼
    ┌────────────────────┐      ┌──────────────────┐     ┌─────────────┐
    │ collectors/*.ts    │─────▶│  db (SQLite)     │     │  agent/     │
    │ (8 sources)        │      │  ~/.adaria/data/ │     │  safety.ts  │
    └────────────────────┘      └──────────────────┘     │ (approvals) │
                                                         └─────────────┘

Cron path:
  launchd com.adaria-ai.weekly  → adaria-ai analyze  → orchestrator/weekly.ts
  launchd com.adaria-ai.monitor → adaria-ai monitor  → orchestrator/monitor.ts
  (Both exit after one run. Neither touches the daemon.)
```

See `folder-structure.md` for the full file tree and `porting-matrix.md`
for the file-by-file provenance.

## 9. Distribution

- **Package name:** `adaria-ai` (unscoped, public npm) — confirmed available
  2026-04-12
- **Version (M9 initial release):** `0.1.0`
- **Install:** `npm install -g @anthropic-ai/claude-code && claude /login &&
  npm install -g adaria-ai && adaria-ai init`
- **Target platform:** macOS with Node.js 20+. launchd user agent only. No
  Docker, no Linux daemon, no Homebrew formula.
- **What ships in tarball:** `dist/`, `prompts/`, `launchd/`, `README.md`,
  `LICENSE`. Nothing else.
- **What stays on user's machine:** `~/.adaria/` (config, sessions, audit,
  SQLite, logs) — never bundled, never published.
- **Publish cadence:** manual from dev box at M9. Post-M9, GitHub Actions on
  `v*` tag push.

## 10. Success metrics

### v0.1.0 acceptance (M9 exit)

- A second Mac (not the dev box) reaches `adaria-ai status` showing all
  three launchd jobs loaded, using only public install flow
- M7 parallel Sunday briefing diff is "explainable" (no unknown delta)
- Monday post-M8 briefing is delivered from adaria-ai without manual fixup
- `adaria-ai doctor` reports all green on the second Mac

### 30 days post-cutover

- Zero Slack-facing daemon crashes (auto-restart doesn't count, but crash-
  loop does)
- Every Mode A command returns an answer within the latency budget (§7.3)
- Every Mode B question returns a sensible answer without hallucinating a
  data point that should have come from a tool call
- At least one approval action (blog publish OR review reply OR social publish) fires end-to-end
- At least one social post published to a live platform via approval flow
- Zero PII leaks from Mode B tool output to Slack message bodies

### 90 days post-cutover

- growth-agent repo stays archived — no emergency backport commits
- New marketing app added to `apps.yaml` → weekly analysis picks it up with
  no code change

## 11. Risks

See `milestones.md` §"Risk register" for the full table with likelihood,
impact, and mitigation. Top five by concern:

1. **pilot-ai `core.ts` trim is harder than expected** — fallback is write
   from scratch using pilot-ai as reference
2. **M7 parallel run doubles external API load** — mitigated by
   `ADARIA_DRY_RUN=1` mode during parallel week
3. **Shared `~/.claude` auth between two daemons** — documented runbook:
   no `/login` during parallel week
4. **Mode B MCP tool leaks raw review text / PII to Slack** — tool
   descriptions forbid pass-through, truncate by default, prompt-guard test
5. **npm path resolution breaks when globally installed** — mandatory M9
   smoke test on a second Mac
6. **Social platform API rate limits / token expiry during weekly run** —
   per-platform rate limiter + token refresh in each client; `DRY_RUN`
   mode skips API calls entirely
7. **TikTok Content Posting API requires app review** — may delay TikTok
   support; other 5 platforms are unblocked

## 12. Out of scope (revisited for Phase 2+)

- Telegram messenger adapter (interface stays generic so it can slot in)
- Long-term memory (pilot-ai's `~/.pilot/memory/` module)
- Third-party MCP servers (Google Ads, Search Console, Apple Search Ads)
- Web dashboard
- Multi-user / multi-tenancy
- Linux / Windows support
- Auto-publish to npm on tag (simple GitHub Actions wiring, post-M9)
- Agent metrics feedback loop (adjust skill behaviour based on past results)
- Streaming responses in Slack (Block Kit update in place during long runs)
- Social post scheduling queue (calendar-based auto-publish)
- Social analytics dashboard (engagement metrics aggregation)

---

## Appendix A — decisions ledger

| # | Decision | Confirmed |
|---|----------|-----------|
| 1 | New repo at `/Users/ahnwoojin/Github/adaria-ai` | initial |
| 2 | Name: `adaria-ai` | initial |
| 3 | TypeScript | 2026-04-12 |
| 4 | Cron via separate launchd jobs, not in-process scheduler | 2026-04-12 |
| 5 | growth-agent Phase 1 commit + freeze as dogfood | 2026-04-12 |
| 6 | Migration: parallel run (M7, `ADARIA_DRY_RUN=1`) → cutover (M8) | 2026-04-12 |
| 7 | Distribution: npm unscoped `adaria-ai` public | 2026-04-12 |
| 8 | MCP framework kept, 4 marketing read-only tools added | 2026-04-12 |
| 9 | One-time fork from pilot-ai, no upstream-sync routine | 2026-04-12 |
| 10 | DB: start fresh, no migration from growth-agent.db | initial |
| 11 | Runtime root: `~/.adaria/` with `ADARIA_HOME` override | 2026-04-12 |
| 12 | Social publishing: 6 platforms (Twitter, Facebook, Threads, TikTok, YouTube, LinkedIn), TS clients ported from linkgo patterns | 2026-04-12 |
| 13 | Social publish is approval-gated, no auto-publish | 2026-04-12 |

## Appendix B — apps in scope at v0.1.0

From growth-agent's `apps.yaml`:

| App | Platforms | Features |
|-----|-----------|----------|
| Fridgify | iOS, Android | ASO, reviews, onboarding, SEO blog (+ recipe branch), short-form, SDK requests |
| Arden TTS | iOS | ASO, reviews, onboarding, short-form |
| Tempy | iOS | ASO, reviews, onboarding |

New apps are added by editing `~/.adaria/apps.yaml` — no code change
required.
