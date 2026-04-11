# adaria-ai — target folder structure

This is the shape on day 1 of M1 (after bootstrap + pilot-ai import). Files
marked `NEW` are not in either source.

```
adaria-ai/
├── package.json              # name: "adaria-ai", bin: "adaria-ai" → dist/index.js
│                             # files: ["dist/", "prompts/", "launchd/"]
│                             # publishConfig: { access: "public" } (or private registry)
├── tsconfig.json
├── eslint.config.js
├── .npmignore                # NEW — excludes tests/, docs/, scripts/, .env*
├── .env.example
├── config.example.yaml       # Slack/Claude config sample (new shape)
├── apps.example.yaml         # Multi-app config sample — user copies to ~/.adaria/apps.yaml
├── .gitignore
├── README.md
├── LICENSE
│
├── launchd/                  # NEW — plist templates (shipped in npm package)
│   ├── com.adaria-ai.daemon.plist.template        # reactive Slack daemon
│   ├── com.adaria-ai.weekly.plist.template        # Sun 23:00 UTC → `adaria-ai analyze`
│   └── com.adaria-ai.monitor.plist.template       # Daily 23:00 UTC → `adaria-ai monitor`
│                                                  # templates loaded via __dirname at runtime,
│                                                  # rendered into ~/Library/LaunchAgents/ by `adaria-ai start`
│
├── src/
│   ├── index.ts              # commander CLI entry
│   │
│   ├── cli/
│   │   ├── daemon.ts         # `adaria-ai daemon` — foreground process launched by launchd
│   │   ├── start.ts          # `adaria-ai start` — launchctl load
│   │   ├── stop.ts           # `adaria-ai stop` — launchctl unload
│   │   ├── status.ts
│   │   ├── logs.ts
│   │   ├── doctor.ts         # runs claude auth check, env snapshot, scope check
│   │   ├── init.ts           # interactive setup (ported from bin/setup.sh)
│   │   ├── analyze.ts        # NEW — one-shot weekly orchestrator (cron entry)
│   │   ├── monitor.ts        # NEW — one-shot daily monitor (cron entry)
│   │   └── user.ts           # adduser / removeuser / listusers
│   │
│   ├── agent/
│   │   ├── claude.ts         # from pilot-ai — Claude CLI runner
│   │   ├── core.ts           # from pilot-ai — handleMessage, command routing + Mode B MCP fallthrough
│   │   ├── session.ts        # from pilot-ai — thread ↔ session store
│   │   ├── memory.ts         # from pilot-ai — memory context builder (conversation-scoped only)
│   │   ├── conversation-summary.ts  # from pilot-ai — msg_too_long fallback
│   │   ├── audit.ts          # from pilot-ai — audit log
│   │   ├── safety.ts         # merged — pilot-ai ApprovalManager base + growth-agent gates
│   │   ├── mcp-manager.ts    # from pilot-ai — MCP server lifecycle (framework only)
│   │   ├── mcp-launcher.ts   # from pilot-ai — spawns MCP servers for Claude CLI
│   │   ├── tool-descriptions.ts  # adapted — descriptions for adaria-ai marketing tools
│   │   └── metrics.ts        # port of growth-agent/src/agent-metrics.js — skill execution metrics
│   │
│   ├── messenger/
│   │   ├── adapter.ts        # from pilot-ai
│   │   ├── slack.ts          # from pilot-ai
│   │   ├── split.ts          # from pilot-ai
│   │   ├── factory.ts        # from pilot-ai
│   │   └── telegram.ts       # future — not ported yet
│   │
│   ├── security/
│   │   ├── auth.ts           # from pilot-ai
│   │   └── prompt-guard.ts   # from pilot-ai
│   │
│   ├── utils/
│   │   ├── circuit-breaker.ts  # from pilot-ai
│   │   ├── rate-limiter.ts     # from pilot-ai
│   │   ├── logger.ts           # from pilot-ai
│   │   ├── retry.ts            # from pilot-ai
│   │   ├── escape.ts           # from pilot-ai
│   │   ├── errors.ts           # from pilot-ai
│   │   ├── paths.ts            # NEW — resolves ADARIA_HOME, bundled prompts dir, launchd templates dir
│   │   └── parse-json.ts       # from growth-agent — bracket-matching JSON extractor
│   │
│   ├── config/
│   │   ├── load-config.ts    # port from growth-agent
│   │   ├── load-apps.ts      # port from growth-agent
│   │   └── store.ts          # from pilot-ai (minus Google/GitHub/tool config)
│   │
│   ├── db/
│   │   ├── schema.ts         # port from growth-agent — 8 tables
│   │   └── queries.ts        # port from growth-agent
│   │
│   ├── tools/                # NEW — read-only MCP tools exposed to Claude for Mode B
│   │   ├── db-query.ts       # whitelisted SELECT against SQLite
│   │   ├── collector-fetch.ts # cache-aware collector wrapper
│   │   ├── skill-result.ts   # read last-N weekly briefings
│   │   └── app-info.ts       # read apps.yaml metadata
│   │
│   ├── collectors/           # all ported from growth-agent
│   │   ├── appstore.ts
│   │   ├── playstore.ts
│   │   ├── eodin-sdk.ts
│   │   ├── eodin-blog.ts
│   │   ├── asomobile.ts
│   │   ├── fridgify-recipes.ts
│   │   ├── youtube.ts
│   │   └── arden-tts.ts
│   │
│   ├── skills/               # NEW concept — growth-agent's agents become skills
│   │   ├── index.ts          # skill registry + dispatch by command name
│   │   ├── aso.ts            # port of src/agents/aso-agent.js
│   │   ├── review.ts         # port of src/agents/review-agent.js
│   │   ├── onboarding.ts     # port of src/agents/onboarding-agent.js
│   │   ├── seo-blog.ts       # port of src/agents/seo-blog-agent.js (w/ Fridgify branch)
│   │   ├── short-form.ts     # port of src/agents/short-form-agent.js
│   │   ├── sdk-request.ts    # port of src/agents/sdk-request-agent.js
│   │   └── content.ts        # port of src/agents/content-agent.js (if distinct)
│   │
│   ├── orchestrator/
│   │   ├── weekly.ts         # port of src/orchestrator.js — runs all skills for all apps
│   │   ├── monitor.ts        # port of src/monitor.js — daily threshold alerts
│   │   └── dashboard.ts      # port of src/dashboard.js — cross-app comparison for briefing
│   │
│   └── types/
│       ├── app.ts            # apps.yaml entry type
│       ├── report.ts         # weekly briefing report shape
│       └── skill.ts          # shared skill interface
│
├── prompts/                  # flat copy from growth-agent
│   ├── aso-description.md
│   ├── aso-inapp-events.md
│   ├── aso-metadata.md
│   ├── aso-screenshots.md
│   ├── onboarding-hypotheses.md
│   ├── onboarding-review-timing.md
│   ├── review-clustering.md
│   ├── review-replies.md
│   ├── review-sentiment.md
│   ├── seo-blog.md
│   ├── seo-blog-fridgify-recipe.md
│   └── short-form-ideas.md
│
├── tests/
│   ├── agent/
│   │   └── claude.test.ts
│   ├── skills/
│   │   ├── aso.test.ts
│   │   ├── review.test.ts
│   │   └── seo-blog.test.ts
│   ├── collectors/
│   │   └── ... (port existing)
│   ├── config/
│   │   └── load-apps.test.ts
│   └── orchestrator/
│       └── weekly.test.ts
│
└── docs/
    ├── ARCHITECTURE.md       # system diagram, data flow, how skills dispatch
    ├── SETUP.md              # ported from growth-agent
    ├── SKILLS.md             # skill authoring guide
    └── PORTING-LOG.md        # decisions / surprises during the port (living doc)
```

## Key differences from growth-agent

1. **TypeScript.** All `.js` → `.ts`. Shared types in `src/types/`.
2. **Skills registry.** The 7 agent functions become a `Skill` interface with
   `dispatch(cmd, ctx) → result`. Core handler looks up the skill by command
   prefix; the orchestrator iterates the registry.
3. **No scheduler.js.** Weekly and daily analyses are separate launchd plists
   that invoke the CLI one-shot. The reactive daemon only handles Slack
   events.
4. **No commands.js.** Message routing lives inside pilot-ai's `core.ts`
   `handleMessage`, which has session continuity, audit logs, reactions,
   streaming baked in.
5. **No claude-runner.js.** Pilot-ai's `claude.ts` replaces it — `spawn`
   + stream-json + CLAUDECODE strip + circuit breaker, already battle-tested.

## Two invocation modes

adaria-ai handles two distinct flows from Slack, and the architecture
reflects both explicitly:

- **Mode A — explicit command.** `@adaria-ai aso fridgify`, `blog fridgify`,
  cron triggers (`adaria-ai analyze`). `core.ts` recognises a command prefix
  and dispatches directly into `src/skills/` registry. No Claude tool use
  involved in the routing step (Claude is called **inside** the skill as the
  analysis engine, not as the router).
- **Mode B — conversational mention.** `@adaria-ai 이번 주 프리지파이 리뷰
  분위기 어때?`. No command prefix matches, so `core.ts` falls through to
  Claude CLI with the MCP tools in `src/tools/` available. Claude decides
  which read-only tool to call and composes the answer. Heavy skills are
  **not** exposed — Mode B is strictly for reading existing data and past
  briefing results. Write paths (blog publish, review reply) stay Mode A +
  `ApprovalManager`.

## Key differences from pilot-ai

1. **No personal-agent tool implementations.** `browser`, `figma`, `notion`,
   `obsidian`, `filesystem`, `vscode`, `google-*`, `calendar`, `email`,
   `voice`, `clipboard`, `github`, `image`, `linear` — all dropped. Marketing
   work happens via domain-specific collectors + a small set of read-only
   MCP tools in `src/tools/`.
2. **MCP framework kept, tool surface replaced.** `agent/mcp-manager.ts` and
   `agent/mcp-launcher.ts` are copied from pilot-ai; what changes is the
   tools they register — adaria-ai ships 4 marketing read tools instead of
   ~15 personal-agent tools. Mode B routing depends on this framework being
   intact, so `core.ts` keeps its MCP context builder and tool-descriptions
   injection path.
3. **apps.yaml concept.** Pilot-ai has no multi-app awareness — everything
   runs in a single context. adaria-ai carries growth-agent's multi-app
   config: every skill iterates over active apps.
4. **SQLite.** Pilot-ai uses flat JSON files (`~/.pilot/sessions.json`,
   `~/.pilot/audit.jsonl`). adaria-ai keeps growth-agent's SQLite DB because
   time-series queries (keyword ranking trends, review sentiment over 90
   days, blog performance) are not practical over JSON.
5. **ApprovalManager with real gates.** Pilot-ai's `safety.ts` is generic
   approval tracking; adaria-ai bolts on the growth-agent gates for
   `blog_publish`, `metadata_change`, `review_reply`.
6. **Weekly briefing report.** A structured, Slack-blocks-formatted summary
   sent once a week per app. Pilot-ai has nothing equivalent.

## npm distribution

Same shape as pilot-ai — `npm install -g adaria-ai`, then `adaria-ai init`
on any macOS box.

**package.json highlights:**

```json
{
  "name": "adaria-ai",
  "version": "0.1.0",
  "type": "module",
  "bin": { "adaria-ai": "./dist/index.js" },
  "files": ["dist/", "prompts/", "launchd/"],
  "engines": { "node": ">=20" }
}
```

**What ships in the tarball:**
- `dist/` — compiled JS + .d.ts
- `prompts/` — all 11 `.md` files (loaded at runtime via `__dirname`)
- `launchd/` — plist templates (rendered into `~/Library/LaunchAgents/` by `adaria-ai start`)
- `README.md`, `LICENSE`

**What does NOT ship:**
- `src/`, `tests/`, `docs/`, `scripts/`, `.env*`, `apps.yaml` (user's own),
  `config.yaml` (user's own), `.adaria/` (runtime state)

**Runtime state goes to `~/.adaria/`** (not the install dir):
```
~/.adaria/
├── config.yaml         # written by `adaria-ai init`
├── apps.yaml           # user edits this — list of apps to analyse
├── sessions.json       # thread ↔ session map
├── audit.jsonl         # audit log
├── data/
│   └── adaria.db       # SQLite
├── logs/
│   ├── daemon.out.log
│   ├── daemon.err.log
│   ├── weekly.out.log
│   └── monitor.out.log
└── LaunchAgents/       # rendered plists are installed to ~/Library/LaunchAgents/
                        # this dir only keeps generation metadata
```

Override root via `ADARIA_HOME` env var (used by tests and for running
two instances side-by-side during M7 parallel run).

**Install flow on a fresh Mac:**
```bash
npm install -g @anthropic-ai/claude-code    # Claude CLI dependency
claude /login                                # one-time auth
npm install -g adaria-ai                     # this package
adaria-ai init                               # interactive wizard →
                                             #   writes ~/.adaria/config.yaml
                                             #   writes ~/.adaria/apps.yaml skeleton
                                             #   prompts for Slack tokens, allowlist
adaria-ai doctor                             # verify all checks pass
adaria-ai start                              # renders + loads 3 launchd plists
```

**Publishing:**
- Private scope `@adaria/adaria-ai` OR public `adaria-ai` — decided in OQ-10
- `npm publish` runs `npm run build` first via `prepublishOnly`
- Version bumps are conventional (semver); M8 cutover ships `0.1.0`
- CI publishes on tag push once GitHub Actions is set up (post-M8)
