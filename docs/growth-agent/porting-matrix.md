# Porting matrix — file-by-file

Legend:
- 🟢 **copy** — lift verbatim or near-verbatim, TS tweaks only
- 🟡 **adapt** — copy but meaningfully modify (trim, rename, refactor)
- 🔵 **merge** — take inputs from both sources and combine
- 🆕 **new** — write fresh in adaria-ai
- 🔴 **drop** — source file has no place in the new project

Source paths:
- `pilot-ai/` = `/Users/ahnwoojin/Github/pilot-ai`
- `growth-agent/` = `/Users/ahnwoojin/growth-agent` (this repo)
- `adaria-ai/` = `/Users/ahnwoojin/Github/adaria-ai` (target)

---

## From pilot-ai/src/agent/

| Source | Action | Target in adaria-ai | Notes |
|--------|--------|---------------------|-------|
| `claude.ts` | 🟡 adapt | `src/agent/claude.ts` | Rename CircuitBreaker ref; update timeout default to 120s (Slack free-form) and 15 min (weekly orchestrator). Keep stream-json, skip-permissions flag configurable, CLAUDECODE strip. |
| `core.ts` | 🟡 adapt | `src/agent/core.ts` | **Major trim.** Drop: project resolver, pilot-ai skills loader (not the adaria-ai skill registry), memory context, Google/GitHub auth checks, token refresher, permission watcher. **Keep:** auth check, audit log, thinking reactions, status message evolution, session continuity, error differentiation, msg_too_long fallback, **MCP context builder + tool-descriptions injection + MCP server health checks** (needed for conversational routing in Mode B — see `folder-structure.md`). Re-wire command-mode dispatch into `src/skills/` registry; conversational-mode falls through to Claude with MCP tools. |
| `session.ts` | 🟢 copy | `src/agent/session.ts` | Path: `~/.adaria/sessions.json` instead of `~/.pilot/sessions.json`. |
| `memory.ts` | 🟡 adapt | `src/agent/memory.ts` | Keep conversation memory (used by msg_too_long fallback). Drop project-scoped memory (no projects in adaria-ai). |
| `conversation-summary.ts` | 🟢 copy | `src/agent/conversation-summary.ts` | |
| `heartbeat.ts` | 🔴 drop | — | Cron handled by launchd, not the daemon. |
| `safety.ts` (ApprovalManager) | 🔵 merge | `src/agent/safety.ts` | Pilot-ai base + growth-agent's `approval-manager.js` gates for `blog_publish`, `metadata_change`, `review_reply`. |
| `audit.ts` (in security/) | 🟢 copy | `src/agent/audit.ts` | Path: `~/.adaria/audit.jsonl`. |
| `mcp-manager.ts` | 🆕 new (was 🟢 copy) | `src/agent/mcp-manager.ts` | Rewritten as a minimal M1 skeleton per M1 MCP review. Pilot-ai's 472-LOC version is ~80% npm-install / Keychain-launcher / claude-code-sync machinery for third-party servers (Gmail, Figma, Linear). adaria-ai exposes only 4 in-process tools bundled with the package, so copy → skeleton (descriptor registry, `buildMcpContext`, `buildMcpConfig` returning `null` when empty to mirror pilot-ai's `getMcpConfigPathIfExists` guard). Handler moved off the daemon-visible `McpToolDescriptor` into a separate `McpToolImplementation` type that lives in the tool-host subprocess (M5.5). |
| `mcp-launcher.ts` | 🆕 new (was 🟢 copy) | `src/agent/mcp-launcher.ts` | Same rationale — pilot-ai's 187-LOC version generates bash wrapper scripts that resolve npx and pull Keychain secrets for third-party servers. adaria-ai launches its single in-process tool host with `process.execPath` directly, so the M1 file is ~45 LOC: a `McpServerConfig` type and a `buildToolHostServerConfig` helper. M5.5 plugs in the real tool-host entry point. |
| `tool-descriptions.ts` | 🟡 adapt | `src/agent/tool-descriptions.ts` | Re-point descriptions from personal-agent tools to adaria-ai's marketing tools (`src/tools/*`). Same injection pathway into core.ts. |
| `skills.ts` (pilot-ai's md-based skill loader) | 🔴 drop | — | Different concept from adaria-ai's skill registry. adaria-ai's skills are code, not loaded markdown. |
| `project.ts`, `project-analyzer.ts`, `worktree.ts`, `multi-agent.ts`, `preference-detector.ts`, `memory-commands.ts`, `planner.ts`, `queue.ts`, `pipeline.ts`, `semantic-search.ts`, `token-refresher.ts`, `figma-mcp.ts` (in tools) | 🔴 drop | — | Personal-agent flavor. Not applicable. |

## From pilot-ai/src/messenger/

| Source | Action | Target | Notes |
|--------|--------|--------|-------|
| `adapter.ts` | 🟢 copy | `src/messenger/adapter.ts` | |
| `slack.ts` | 🟡 adapt | `src/messenger/slack.ts` | **Add `eventTs` field** (we already identified this fix in growth-agent Phase 1). Keep dedup Set, reactions, updateText, rate limiter, sendApproval, image attachment handling. |
| `split.ts` | 🟢 copy | `src/messenger/split.ts` | |
| `factory.ts` | 🟢 copy | `src/messenger/factory.ts` | |

## From pilot-ai/src/security/

| Source | Action | Target | Notes |
|--------|--------|--------|-------|
| `auth.ts` | 🟢 copy | `src/security/auth.ts` | |
| `audit.ts` | 🟢 copy | `src/agent/audit.ts` | Moved to `agent/` for locality. |
| `prompt-guard.ts` | 🟢 copy | `src/security/prompt-guard.ts` | |
| `permissions.ts` | 🔴 drop | — | macOS permission watcher for personal agent tools. Not needed. |
| `sandbox.ts` | 🔴 drop | — | Tool sandboxing for personal agent. Not needed. |

## From pilot-ai/src/utils/

| Source | Action | Target | Notes |
|--------|--------|--------|-------|
| `circuit-breaker.ts` | 🟢 copy | `src/utils/circuit-breaker.ts` | |
| `rate-limiter.ts` | 🟢 copy | `src/utils/rate-limiter.ts` | |
| `logger.ts` | 🟢 copy | `src/utils/logger.ts` | |
| `retry.ts` | 🟢 copy | `src/utils/retry.ts` | |
| `escape.ts` | 🟢 copy | `src/utils/escape.ts` | |
| `errors.ts` | 🟢 copy | `src/utils/errors.ts` | |
| `oauth-manager.ts`, `oauth-callback-server.ts` | 🔴 drop | — | Google OAuth — not needed. |

## From pilot-ai/src/config/

| Source | Action | Target | Notes |
|--------|--------|--------|-------|
| `store.ts` | 🟡 adapt | `src/config/store.ts` | Replace pilot-config schema with adaria-ai's (slack + claude + apps). |
| `schema.ts` | 🟡 adapt | `src/config/schema.ts` | Same. |
| `keychain.ts` | 🟢 copy | `src/config/keychain.ts` | Used for bot token storage (optional). |
| `claude-code-sync.ts` | 🔴 drop | — | MCP sync — not needed. |

## From pilot-ai/src/cli/

| Source | Action | Target | Notes |
|--------|--------|--------|-------|
| `start.ts` | 🟡 adapt | `src/cli/start.ts` | Plist label `com.adaria-ai.daemon`. Install three plists instead of one (daemon + weekly + monitor). |
| `stop.ts` | 🟡 adapt | `src/cli/stop.ts` | Unload all three plists. |
| `status.ts` | 🟡 adapt | `src/cli/status.ts` | Check all three plist labels. |
| `logs.ts` | 🟢 copy | `src/cli/logs.ts` | Path: `~/.adaria/logs/`. |
| `doctor.ts` | 🟡 adapt | `src/cli/doctor.ts` | Growth-marketing checks: Claude login, Slack scopes, App Store / Google Play credentials, ASOMobile API, Eodin SDK, apps.yaml validity, DB accessible. |
| `init.ts` | 🟡 adapt | `src/cli/init.ts` | Interactive wizard ported from growth-agent's `bin/setup.sh`. |
| `user.ts` | 🟢 copy | `src/cli/user.ts` | adduser/removeuser/listusers. |
| `project.ts` | 🔴 drop | — | Project registry. Not applicable. |
| `tools.ts`, `auth.ts`, `connection-test.ts` | 🔴 drop | — | Personal-agent CLI subcommands. |

## From pilot-ai/src/tools/

| Source | Action |
|--------|--------|
| `browser.ts`, `figma.ts`, `image.ts`, `clipboard.ts`, `notion.ts`, `obsidian.ts`, `email.ts`, `calendar.ts`, `google-*.ts`, `vscode.ts`, `shell.ts`, `filesystem.ts`, `notification.ts`, `linear.ts`, `voice.ts`, `github.ts`, `figma-mcp.ts`, `mcp-registry.ts` | 🔴 drop all implementations |

**Rationale:** The MCP **framework** (manager, launcher, tool-description
injection) is kept because Mode B (conversational Slack mentions) routes
through Claude's tool use. What's dropped is the personal-agent **tool
implementations** — they have no place in a marketing workflow. adaria-ai
ships its own small set of read-only marketing tools instead (see next
section). If a skill needs to hit Google Ads or Linear, it still calls the
API directly from a collector — same pattern growth-agent already uses.
MCP tools are for Claude's read-path, not for skill write-paths.

## NEW — adaria-ai marketing MCP tools (🆕)

Read-only tools exposed to Claude via pilot-ai's MCP framework. Used by
Mode B routing when a user mentions `@adaria-ai` with a free-form question
instead of an explicit command. Skills themselves are **not** exposed as
MCP tools — they are too heavy and have approval-gated write paths. Tools
are cheap, idempotent, and read-only.

| Target | Purpose | Reads from |
|--------|---------|------------|
| `src/tools/db-query.ts` | Parameterised `SELECT` against SQLite. Whitelisted tables: `keyword_rankings`, `reviews`, `sdk_events`, `blog_performance`, `short_form_performance`, `agent_metrics`. No writes, no DDL. | `~/.adaria/data/adaria.db` |
| `src/tools/collector-fetch.ts` | Fetch fresh data from a named collector (`appstore`, `playstore`, `eodin-sdk`, ...). Cache-aware — skips network if DB has recent row. | collectors + DB cache |
| `src/tools/skill-result.ts` | Read the last-N weekly briefing results per app. Lets Claude say "last week's ASO analysis said X" without re-running AsoSkill. | DB (`agent_metrics`, stored briefing JSON) |
| `src/tools/app-info.ts` | Read `apps.yaml` — which apps are active, which features enabled, metadata only. | `apps.yaml` |

**Out of scope (never exposed as MCP tools):**
- `blog_publish`, `metadata_change`, `review_reply` — these are skill
  outputs gated by `ApprovalManager`. Claude does not get a shortcut.
- Raw file system access, shell, arbitrary HTTP.
- Any write to the DB.

**Security:** `prompt-guard.ts` covers prompt-injection attempts against
tool descriptions. M5.5 adds test cases for "trick Claude into running a
non-whitelisted query" and "trick Claude into leaking raw review text to
Slack when it should be summarised".

## From pilot-ai/src/index.ts

| Source | Action | Target | Notes |
|--------|--------|--------|-------|
| `index.ts` | 🟡 adapt | `src/index.ts` | commander CLI entry. Drop `project`, `tools`, `addtool`, `removetool`, `sync-mcp`, `auth google`, `auth figma` subcommands. Keep `init`, `start`, `stop`, `status`, `logs`, `daemon`, `doctor`, `adduser`, `removeuser`, `listusers`. Add `analyze` and `monitor` subcommands for cron. |

---

## From growth-agent/src/

### Collectors (all 🟢 copy → TS port)

| Source | Target | Notes |
|--------|--------|-------|
| `collectors/appstore.js` | `src/collectors/appstore.ts` | App Store Connect API + JWT |
| `collectors/playstore.js` | `src/collectors/playstore.ts` | Google Play Developer API |
| `collectors/eodin-sdk.js` | `src/collectors/eodin-sdk.ts` | Eodin SDK (installs, DAU, funnel, cohort) |
| `collectors/eodin-blog.js` | `src/collectors/eodin-blog.ts` | EodinBlogPublisher + Search Console + GA4 |
| `collectors/asomobile.js` | `src/collectors/asomobile.ts` | ASOMobile keyword API |
| `collectors/fridgify-recipes.js` | `src/collectors/fridgify-recipes.ts` | Fridgify public API, cascade |
| `collectors/youtube.js` | `src/collectors/youtube.ts` | YouTube Data API |
| `collectors/arden-tts.js` | `src/collectors/arden-tts.ts` | Arden TTS |

### Agents → Skills (all 🟡 adapt — interface change)

| Source (function export) | Target (skill class) | Command triggers |
|--------------------------|----------------------|------------------|
| `agents/aso-agent.js` `analyzeAso` | `src/skills/aso.ts` `AsoSkill` | `aso`, `ASO 재분석`, weekly |
| `agents/review-agent.js` `analyzeReviews` | `src/skills/review.ts` `ReviewSkill` | `reviews`, `리뷰 분석`, weekly |
| `agents/onboarding-agent.js` `analyzeOnboarding` | `src/skills/onboarding.ts` `OnboardingSkill` | `onboarding`, weekly |
| `agents/seo-blog-agent.js` `analyzeSeo` + `publishApprovedPosts` | `src/skills/seo-blog.ts` `SeoBlogSkill` | `blog`, `블로그 작성`, weekly |
| `agents/short-form-agent.js` `analyzeShortForm` | `src/skills/short-form.ts` `ShortFormSkill` | `shortform`, `숏폼`, weekly |
| `agents/sdk-request-agent.js` `SdkRequestAgent.analyze` | `src/skills/sdk-request.ts` `SdkRequestSkill` | weekly (aggregates onboarding.sdkRequests) |
| `agents/content-agent.js` | `src/skills/content.ts` `ContentSkill` | (decide during port — may fold into `short-form.ts`) |

**Shared skill interface (sketch):**

```ts
interface Skill {
  readonly name: string;
  readonly commands: string[];          // text triggers for on-demand invocation
  readonly schedule?: 'weekly' | 'daily';  // how the orchestrator calls it
  dispatch(ctx: SkillContext, app: AppConfig): Promise<SkillResult>;
}

interface SkillContext {
  db: Database;
  runner: ClaudeRunner;                 // wraps claude.ts
  collectors: CollectorRegistry;
  webMetrics?: WebMetrics;
  prevResults?: Record<string, SkillResult>;  // for cross-skill deps (seo-blog needs aso + review)
}

interface SkillResult {
  summary: string;                      // Slack-formatted text
  alerts?: Alert[];
  approvals?: ApprovalItem[];
}
```

### Orchestrator + monitor (🟡 adapt)

| Source | Target | Notes |
|--------|--------|-------|
| `orchestrator.js` `main` | `src/orchestrator/weekly.ts` | Iterate apps, dispatch weekly skills in parallel, assemble report, send briefing, collect approvals. |
| `monitor.js` | `src/orchestrator/monitor.ts` | Threshold-based daily alerts. |
| `daemon.js` | 🔴 drop | Replaced by `src/cli/daemon.ts` from pilot-ai shape. |
| `scheduler.js` | 🔴 drop | Replaced by launchd plists. |
| `commands.js` | 🔴 drop | Replaced by `src/agent/core.ts` + skill registry. |
| `cli/claude-runner.js` | 🔴 drop | Replaced by `src/agent/claude.ts`. |
| `commands/error-hints.js` | 🟡 adapt | Merge into `src/agent/core.ts` error differentiation (pilot-ai has similar). |
| `messenger/slack.js` | 🔴 drop | Replaced by pilot-ai's. |
| `messenger/adapter.js` | 🔴 drop | Replaced by pilot-ai's. |
| `notifiers/*` | 🔴 drop | Legacy one-way notifiers. Messenger replaces. |

### DB (🟡 adapt — JS → TS)

| Source | Target |
|--------|--------|
| `db/schema.js` | `src/db/schema.ts` — 8 tables (keyword_rankings, sdk_events, reviews, approvals, competitor_metadata, agent_metrics, seo_metrics, web_traffic, blog_performance, short_form_performance) |
| `db/queries.js` | `src/db/queries.ts` — typed prepared statements |

**Migration question:** keep the existing `growth-agent.db` data or start fresh? Recommendation: **start fresh**. The existing DB has ~1 week of real data, and losing it costs nothing meaningful compared to the cleanup of dropping ad-hoc schema drift. If we want to preserve anything, export to CSV and re-import.

### Config (🟡 adapt)

| Source | Target |
|--------|--------|
| `config/load-config.js` | `src/config/load-config.ts` |
| `config/load-apps.js` | `src/config/load-apps.ts` |
| `apps.yaml` | `apps.yaml` (root) — copy as-is, includes `features.fridgify_recipes` flag |
| `config.yaml` | `config.example.yaml` — copy shape, but user re-initializes via `adaria-ai init` |
| `.env` / `.env.example` | `.env.example` — copy |

### Prompts (🟢 copy — no code)

All 11 `.md` files copied flat to `adaria-ai/prompts/`. No transformations.

### Approval manager (🔵 merge)

| Source | Target | Notes |
|--------|--------|-------|
| growth-agent `src/approval-manager.js` | `src/agent/safety.ts` | Merge into pilot-ai's ApprovalManager base. Gate types: `blog_publish`, `metadata_change`, `review_reply`, `sdk_request`. |

### Utils

| Source | Target | Notes |
|--------|--------|-------|
| `utils/parse-json.js` | `src/utils/parse-json.ts` | Bracket-matching JSON extractor for Claude responses. Keep. |
| `agent-metrics.js` | `src/agent/metrics.ts` | Tracks skill execution metrics for the feedback loop. |
| `dashboard.js` | `src/orchestrator/dashboard.ts` | Cross-app comparison for weekly briefing. |
| `approval-manager.js` | 🔵 merged into `src/agent/safety.ts` | |

---

## Items NOT yet accounted for

These are open questions flagged in `open-questions.md`. Each blocks at least
one milestone if unresolved.

- Logging format: stdout-only (launchd captures) or JSONL + rotation?
- Tests framework: vitest (growth-agent) or something pilot-ai uses? (pilot-ai uses vitest too — keep.)
- Memory store: pilot-ai's `~/.pilot/memory/` Markdown system vs growth-agent's "no memory" state
- Monorepo? Not recommended — keep a single root package.json, standard npm

---

## Sanity check — totals

| Category | pilot-ai files | growth-agent files | adaria-ai files |
|----------|---------------:|-------------------:|----------------:|
| agent/ | 24 | 7 (agents/) | ~11 (incl. MCP framework + metrics) |
| messenger/ | 4 | 3 | ~4 |
| tools/ | 20 | 0 | 4 (new marketing read-only) |
| security/ | 5 | 0 | 2 |
| utils/ | 9 | 3 | ~8 |
| collectors/ | 0 | 8 | 8 |
| skills/ | 0 | 0 (agents/) | 7 |
| db/ | 0 | 2 | 2 |
| config/ | 4 | 2 | 3 |
| cli/ | 11 | 1 | 9 |
| prompts/ | 0 | 11 | 11 |
| orchestrator/ | 0 | 2 | 3 (incl. dashboard) |
| launchd/ | 0 | 1 | 3 |
| **total src/ + prompts/ + launchd/** | **~77** | **~40** | **~75** |

Roughly parity with pilot-ai in file count, but the shape is very different:
we drop ~16 personal-agent tool implementations, add 4 read-only marketing
tools, add 7 skills + 8 collectors, and keep the MCP framework to power
conversational routing.
