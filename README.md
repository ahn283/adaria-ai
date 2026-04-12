# adaria-ai

Single-user marketing operations agent for the Adaria.ai app portfolio (Fridgify, Arden TTS, Tempy). Runs as a macOS launchd daemon, receives commands and free-form questions via Slack, orchestrates data collection from 8 marketing sources, dispatches Claude-powered analysis skills, and delivers weekly briefings with approval-gated write actions.

**Status:** pre-release (M0 bootstrap). Not yet published to npm. See [`docs/growth-agent/`](./docs/growth-agent/) for the full plan — start with `prd.md` and `checklist.md`.

## Profiles and safety

Every credential the agent uses flows through `adaria-ai init`. The wizard writes `$ADARIA_HOME/config.yaml` and stores secrets in the macOS Keychain under a service prefix derived from `$ADARIA_HOME`, so you can run a **dev profile** and the production daemon side by side on the same machine without either clobbering the other:

- **Production** (default): `$HOME/.adaria` — Keychain service `adaria-ai`
- **Dev profile**: `$HOME/.adaria-dev` — Keychain service `adaria-ai-dev`

```bash
# 1. Seed a dev profile once with live (or scoped-down) credentials:
npm run init:dev
# 2. Exercise every configured collector against real APIs:
npm run smoke:collectors:dev
```

Real `config.yaml` and `apps.yaml` files never live inside the repository — they are ignored by Git and sit only under `$HOME/.adaria*`. The `files` field in `package.json` ships only `dist/`, `src/`, `prompts/`, `launchd/`, `apps.example.yaml`, `README.md`, and `LICENSE`, and `npm run prepublishOnly` runs `check:tarball-secrets`, which rips open the candidate tarball and refuses to publish if it finds anything that looks like a Slack token, Anthropic key, Google API key, or PEM private key block.
