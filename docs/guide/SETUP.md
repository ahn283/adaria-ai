# adaria-ai Setup Guide

## Prerequisites

- macOS with Node.js 20+
- Claude Code CLI installed and authenticated
- A Slack workspace with a bot app configured (Socket Mode + Bot Token)

## Installation

```bash
# Install Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude /login

# Install adaria-ai
npm install -g adaria-ai
```

## Initial configuration

```bash
adaria-ai init
```

The wizard walks through:

1. **Slack credentials** — bot token, signing secret, app token, channel, allowlist
2. **Collector credentials** (optional) — App Store Connect, Google Play, ASOMobile, Eodin SDK, Eodin Growth, YouTube, Arden TTS
3. **Social platform credentials** (optional) — Twitter, Facebook, Threads, TikTok, YouTube, LinkedIn

Secrets are stored in macOS Keychain. Non-secret config is in `~/.adaria/config.yaml`.

### Section-specific init

```bash
adaria-ai init slack       # Slack credentials only
adaria-ai init collectors  # Collector credentials only
adaria-ai init social      # Social platform credentials only
```

## Apps configuration

Copy the example file and edit:

```bash
cp apps.example.yaml ~/.adaria/apps.yaml
```

Edit `~/.adaria/apps.yaml` to configure your apps, platforms, keywords, competitors, and social platform flags.

## Starting the daemon

```bash
adaria-ai start   # installs 3 launchd plists
adaria-ai status  # verify all 3 jobs are loaded
adaria-ai logs    # tail daemon logs
```

## Health check

```bash
adaria-ai doctor
```

Checks: config, Claude CLI auth, database, collectors, social platforms, and claude auth recency.

## Stopping

```bash
adaria-ai stop   # unloads all 3 launchd plists
```

## Development profiles

For trying changes without touching the production state:

```bash
# Dev profile uses ~/.adaria-dev and a separate keychain namespace
ADARIA_HOME=~/.adaria-dev adaria-ai init
npm run init:dev              # shortcut

# Smoke tests
npm run smoke:collectors:dev  # test collectors with dev credentials
```

## Manual cron trigger

```bash
# Trigger weekly analysis without waiting for Sunday
launchctl kickstart -k gui/$UID/com.adaria-ai.weekly

# Trigger daily monitor
launchctl kickstart -k gui/$UID/com.adaria-ai.monitor
```

## Troubleshooting

### Daemon keeps restarting

Check `~/.adaria/logs/daemon.err.log` for crash details.

### "Claude CLI not authenticated"

```bash
claude /login
```

**Note:** `claude /login` invalidates the current Claude session — the running daemon will need to re-authenticate on its next skill invocation. `adaria-ai doctor` warns when `~/.claude` was touched in the last 24h.

### Collector errors

Re-run the credential wizard for the failing collector:

```bash
adaria-ai init collectors
```

### Rollback (M8 cutover failure)

```bash
adaria-ai stop
launchctl load <path-to-growth-agent.plist>
# growth-agent daemon is now live; adaria-ai is stopped
```
