<p align="center">
  <img src="https://raw.githubusercontent.com/ahnwoojin/adaria-ai/main/assets/logo.png" alt="adaria.ai" width="420" />
</p>

<p align="center">
  <strong>AI-powered marketing operations agent for mobile app teams</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/adaria-ai"><img src="https://img.shields.io/npm/v/adaria-ai.svg" alt="npm version" /></a>
  <a href="https://github.com/ahnwoojin/adaria-ai/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/adaria-ai.svg" alt="license" /></a>
  <img src="https://img.shields.io/node/v/adaria-ai.svg" alt="node version" />
  <img src="https://img.shields.io/badge/platform-macOS-blue.svg" alt="platform" />
</p>

---

adaria-ai is a single-user, local-first marketing operations agent that runs as a macOS background service. It connects to Slack, orchestrates data collection from 8 marketing sources, runs Claude-powered analysis skills, and delivers weekly growth briefings with approval-gated actions.

Built for the [Adaria.ai](https://adaria.ai) app portfolio (Fridgify, Arden TTS, Tempy), but configurable for any mobile app team via `apps.yaml`.

## Features

**8 Analysis Skills** &mdash; ASO keyword tracking, review sentiment & reply drafts, onboarding funnel analysis, SEO blog generation, short-form content ideas, SDK request aggregation, content strategy, and social media publishing.

**8 Data Collectors** &mdash; App Store Connect, Google Play Console, ASOMobile, Eodin SDK, Eodin Blog + Search Console + GA4, Fridgify Recipes API, YouTube Data API, Arden TTS metrics.

**6 Social Platforms** &mdash; Generate and publish platform-optimised marketing content to Twitter/X, Facebook, Threads, TikTok, YouTube Community, and LinkedIn. Every post is approval-gated.

**Two Interaction Modes**

| Mode | Trigger | Example |
|------|---------|---------|
| **Mode A** &mdash; Skill command | `@adaria-ai aso fridgify` | Runs full ASO analysis with keyword rankings, competitor diffs, and metadata proposals |
| **Mode B** &mdash; Conversational | `@adaria-ai how are reviews this week?` | Claude answers using 4 read-only MCP tools against your marketing data |

**Automated Briefings** &mdash; Weekly growth reports and daily threshold alerts delivered to Slack on a launchd cron schedule.

**Approval-Gated Write Actions** &mdash; Blog publishing, review replies, metadata changes, and social posts require explicit Slack button approval before execution.

## Architecture

```
                           Slack
                             |
                       +-----+-----+
                       |  daemon   |  (always-on, launchd)
                       +-----+-----+
                             |
                   +---------+---------+
                   |                   |
              Mode A              Mode B
          (skill dispatch)    (Claude + MCP tools)
                   |                   |
            skills/*.ts          tools/*.ts
                   |              (read-only)
          collectors/*.ts             |
                   |              SQLite DB
            safety.ts
        (approval gates)
                   |
         Slack Block Kit
       [Approve] [Reject]
```

Three separate launchd processes:

| Process | Schedule | Purpose |
|---------|----------|---------|
| `com.adaria-ai.daemon` | Always on | Reactive Slack event handler |
| `com.adaria-ai.weekly` | Sun 23:00 UTC | Full weekly analysis + briefing |
| `com.adaria-ai.monitor` | Daily 23:00 UTC | Threshold-based alerts |

## Quick Start

```bash
# 1. Install
npm install -g @anthropic-ai/claude-code
claude /login
npm install -g adaria-ai

# 2. Configure
adaria-ai init

# 3. Run
adaria-ai start
adaria-ai status    # verify 3 launchd jobs loaded
adaria-ai doctor    # health check
```

## CLI Commands

```bash
adaria-ai init                # Interactive setup wizard
adaria-ai init slack          # Configure Slack credentials only
adaria-ai init collectors     # Configure data source credentials
adaria-ai init social         # Configure social platform credentials

adaria-ai start               # Install and load 3 launchd plists
adaria-ai stop                # Unload all launchd plists
adaria-ai status              # Check launchd job states
adaria-ai logs                # Tail daemon logs

adaria-ai doctor              # Full health check
adaria-ai analyze             # Run weekly analysis manually
adaria-ai monitor             # Run daily monitor manually
```

## Configuration

All runtime state lives in `~/.adaria/` (override with `ADARIA_HOME`):

```
~/.adaria/
  config.yaml          # Written by `adaria-ai init`
  apps.yaml            # Your apps, platforms, keywords, competitors
  sessions.json        # Slack thread <-> Claude session map
  audit.jsonl          # Every action logged
  data/adaria.db       # SQLite database
  logs/                # Daemon, weekly, monitor logs
```

Secrets are stored in macOS Keychain, never in config files.

### Dev Profile

Run a separate dev instance alongside production:

```bash
# Dev profile uses ~/.adaria-dev with isolated keychain namespace
npm run init:dev
npm run smoke:collectors:dev
npm run smoke:social:dev
```

## Skills Reference

| Skill | Command | What it does |
|-------|---------|-------------|
| ASO | `aso <app>` | Keyword rankings, rank changes, competitor diffs, metadata proposals |
| Reviews | `review <app>` | Sentiment analysis, complaint clustering, reply drafts |
| Onboarding | `onboarding <app>` | Funnel analysis, cohort retention, drop-off hypotheses |
| SEO Blog | `blog <app>` | Blog post generation + Fridgify recipe content |
| Short-form | `shortform <app>` | YouTube Shorts performance + content ideas |
| SDK Requests | `sdkrequest <app>` | SDK event aggregation and analysis |
| Content | `content <app>` | Pinterest pins + trend content ideas |
| Social | `social <app>` | Generate + post to 6 platforms (approval-gated) |

## Security

- **Slack allowlist** &mdash; Only configured user IDs can interact with the bot
- **Prompt injection defense** &mdash; All external data (reviews, recipes, competitor metadata) is sanitized and XML-wrapped before reaching Claude
- **Read-only MCP tools** &mdash; Mode B has no write access; skills are never exposed as tools
- **Approval gates** &mdash; Every write action requires human confirmation
- **Audit log** &mdash; Every invocation, skill dispatch, and approval action is logged
- **No secrets in npm** &mdash; Pre-publish scanner blocks tarball if credentials detected
- **Keychain storage** &mdash; All tokens stored in macOS Keychain, not files

## Tech Stack

- **Runtime:** Node.js 20+, TypeScript (strict, ESM)
- **AI:** Claude CLI (via [@anthropic-ai/claude-code](https://www.npmjs.com/package/@anthropic-ai/claude-code))
- **Messaging:** Slack (Socket Mode + Bolt)
- **Database:** SQLite (better-sqlite3, WAL mode)
- **Process management:** macOS launchd
- **Testing:** Vitest (545 tests)

## Requirements

- macOS (launchd-based process management)
- Node.js 20+
- Claude Code CLI installed and authenticated
- Slack workspace with a bot app (Socket Mode enabled)

## License

[MIT](LICENSE)

---

<p align="center">
  Built by <a href="https://github.com/ahnwoojin">Woojin Ahn</a> for the <a href="https://adaria.ai">Adaria.ai</a> app portfolio
</p>
