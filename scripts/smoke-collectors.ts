/**
 * Manual collector smoke test.
 *
 * Hits each ported collector's happy path against live APIs using the
 * credentials already written by `adaria-ai init` (global creds from
 * `config.yaml.collectors`) plus per-app identifiers from `apps.yaml`.
 * Any collector whose credentials are missing, or that the first active
 * app can't be targeted against, is skipped — so a partially-configured
 * installation still runs cleanly and only the configured endpoints
 * cost real quota.
 *
 *   npm run smoke:collectors
 *
 * The script is dev-time only. It never writes anything anywhere, never
 * posts to Slack, and never touches the DB.
 */

import { AppStoreCollector } from "../src/collectors/appstore.js";
import { ArdenTtsClient } from "../src/collectors/arden-tts.js";
import { AsoMobileCollector } from "../src/collectors/asomobile.js";
import {
  EodinAnalytics,
  EodinBlogPublisher,
  EodinSeoMetrics,
} from "../src/collectors/eodin-blog.js";
import { EodinSdkCollector } from "../src/collectors/eodin-sdk.js";
import { FridgifyRecipesCollector } from "../src/collectors/fridgify-recipes.js";
import { PlayStoreCollector } from "../src/collectors/playstore.js";
import { YouTubeCollector } from "../src/collectors/youtube.js";
import { loadConfig } from "../src/config/store.js";
import { loadApps } from "../src/config/load-apps.js";
import type { AppConfig } from "../src/config/apps-schema.js";
import type { AdariaConfig } from "../src/config/schema.js";

type SmokeStatus = "ok" | "skip" | "error";

interface SmokeResult {
  name: string;
  status: SmokeStatus;
  detail?: string;
}

const results: SmokeResult[] = [];

function skip(name: string, detail: string): void {
  console.log(`\u23ed  ${name}: skipped (${detail})`);
  results.push({ name, status: "skip", detail });
}

function ok(name: string, detail: string): void {
  console.log(`\u2705 ${name}: ${detail}`);
  results.push({ name, status: "ok", detail });
}

function fail(name: string, detail: string): void {
  console.log(`\u274c ${name}: ${detail}`);
  results.push({ name, status: "error", detail });
}

function preview(obj: unknown, max = 160): string {
  const json = JSON.stringify(obj);
  if (json.length <= max) return json;
  return `${json.slice(0, max)}…`;
}

async function run(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const msg = await fn();
    ok(name, msg);
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}

function lastWeekRange(): { start: string; end: string } {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return { start, end };
}

// ---------------------------------------------------------------------------
// Per-collector smoke blocks
// ---------------------------------------------------------------------------

async function smokeAppStore(
  config: AdariaConfig,
  app: AppConfig
): Promise<void> {
  const cfg = config.collectors.appStore;
  if (!cfg) {
    skip("AppStoreCollector", "config.yaml.collectors.appStore not set");
    return;
  }
  if (!app.appStoreId) {
    skip("AppStoreCollector", `apps.yaml[${app.id}].appStoreId not set`);
    return;
  }

  const collector = new AppStoreCollector(cfg);
  await run("AppStoreCollector.getReviews", async () => {
    const reviews = await collector.getReviews(app.appStoreId ?? "", 5);
    return `${String(reviews.length)} reviews: ${preview(reviews.slice(0, 1))}`;
  });
}

async function smokePlayStore(
  config: AdariaConfig,
  app: AppConfig
): Promise<void> {
  const cfg = config.collectors.playStore;
  if (!cfg) {
    skip("PlayStoreCollector", "config.yaml.collectors.playStore not set");
    return;
  }
  if (!app.playStorePackage) {
    skip(
      "PlayStoreCollector",
      `apps.yaml[${app.id}].playStorePackage not set`
    );
    return;
  }

  const collector = new PlayStoreCollector({
    serviceAccountJson: cfg.serviceAccountJson,
  });
  await run("PlayStoreCollector.getReviews", async () => {
    const reviews = await collector.getReviews(app.playStorePackage ?? "");
    return `${String(reviews.length)} reviews: ${preview(reviews.slice(0, 1))}`;
  });
}

async function smokeEodinSdk(
  config: AdariaConfig,
  app: AppConfig
): Promise<void> {
  const cfg = config.collectors.eodinSdk;
  if (!cfg) {
    skip("EodinSdkCollector", "config.yaml.collectors.eodinSdk not set");
    return;
  }
  if (!app.eodinSdkAppId) {
    skip("EodinSdkCollector", `apps.yaml[${app.id}].eodinSdkAppId not set`);
    return;
  }

  const collector = new EodinSdkCollector(cfg);
  const { start, end } = lastWeekRange();

  await run("EodinSdkCollector.getSummary", async () => {
    const rows = await collector.getSummary(
      app.eodinSdkAppId ?? "",
      start,
      end
    );
    return `${String(rows.length)} rows: ${preview(rows.slice(0, 1))}`;
  });
  await run("EodinSdkCollector.getFunnel", async () => {
    const funnel = await collector.getFunnel(
      app.eodinSdkAppId ?? "",
      start,
      end
    );
    return `${String(funnel.funnel.length)} steps, overall_conversion=${String(
      funnel.overall_conversion
    )}`;
  });
}

async function smokeEodinGrowth(config: AdariaConfig): Promise<void> {
  const cfg = config.collectors.eodinGrowth;
  if (!cfg) {
    skip("EodinBlogPublisher", "config.yaml.collectors.eodinGrowth not set");
    return;
  }

  const pub = new EodinBlogPublisher({ token: cfg.token });
  const seo = new EodinSeoMetrics({ token: cfg.token });
  const an = new EodinAnalytics({ token: cfg.token });

  await run("EodinBlogPublisher.listSlugs", async () => {
    const slugs = await pub.listSlugs();
    return `${String(slugs.length)} slugs: ${preview(slugs.slice(0, 3))}`;
  });

  const { start, end } = lastWeekRange();
  await run("EodinSeoMetrics.getOverview", async () => {
    return preview(await seo.getOverview(start, end));
  });
  await run("EodinAnalytics.getTraffic", async () => {
    return preview(await an.getTraffic(start, end));
  });
}

async function smokeAsoMobile(
  config: AdariaConfig,
  app: AppConfig
): Promise<void> {
  const cfg = config.collectors.asoMobile;
  if (!cfg) {
    skip("AsoMobileCollector", "config.yaml.collectors.asoMobile not set");
    return;
  }
  if (!app.asoMobileId) {
    skip("AsoMobileCollector", `apps.yaml[${app.id}].asoMobileId not set`);
    return;
  }
  if (!app.platform.includes("ios")) {
    skip(
      "AsoMobileCollector",
      `apps.yaml[${app.id}].platform does not include ios`
    );
    return;
  }

  const collector = new AsoMobileCollector(cfg);
  await run("AsoMobileCollector.getKeywordSuggestions", async () => {
    const suggestions = await collector.getKeywordSuggestions(
      app.asoMobileId ?? "",
      "ios"
    );
    return `${String(suggestions.length)} suggestions: ${preview(
      suggestions.slice(0, 2)
    )}`;
  });
}

async function smokeFridgify(app: AppConfig): Promise<void> {
  if (!app.features.fridgifyRecipes) {
    skip(
      "FridgifyRecipesCollector",
      `apps.yaml[${app.id}].features.fridgifyRecipes is not enabled`
    );
    return;
  }

  const collector = new FridgifyRecipesCollector();
  await run("FridgifyRecipesCollector.getPopular", async () => {
    const rows = await collector.getPopular({ period: "month", limit: 3 });
    return `${String(rows.length)} recipes: ${preview(
      rows.map((r) => r.name ?? r.id)
    )}`;
  });
}

async function smokeYouTube(
  config: AdariaConfig,
  app: AppConfig
): Promise<void> {
  const cfg = config.collectors.youtube;
  if (!cfg) {
    skip("YouTubeCollector", "config.yaml.collectors.youtube not set");
    return;
  }
  if (!app.youtubeChannelId) {
    skip("YouTubeCollector", `apps.yaml[${app.id}].youtubeChannelId not set`);
    return;
  }

  const collector = new YouTubeCollector(cfg);
  await run("YouTubeCollector.getRecentShorts", async () => {
    const shorts = await collector.getRecentShorts(
      app.youtubeChannelId ?? "",
      5
    );
    return `${String(shorts.length)} shorts: ${preview(
      shorts.map((s) => `${s.videoId}@${s.duration ?? "?"}`)
    )}`;
  });
}

async function smokeArdenTts(config: AdariaConfig): Promise<void> {
  const cfg = config.collectors.ardenTts;
  if (!cfg) {
    skip("ArdenTtsClient", "config.yaml.collectors.ardenTts not set");
    return;
  }

  const client = new ArdenTtsClient({ endpoint: cfg.endpoint });
  await run("ArdenTtsClient.synthesize", async () => {
    const audio = await client.synthesize("smoke test", { locale: "ko" });
    return `${String(audio.length)} bytes of MP3`;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("# adaria-ai collector smoke test\n");

  let config: AdariaConfig;
  try {
    config = await loadConfig();
  } catch (err) {
    console.log(
      `\u274c config.yaml not loadable: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    console.log("Run `adaria-ai init` first.");
    process.exitCode = 1;
    return;
  }

  let app: AppConfig;
  try {
    const apps = await loadApps();
    const first = apps.apps[0];
    if (!first) {
      console.log("\u274c apps.yaml has no active apps.");
      process.exitCode = 1;
      return;
    }
    app = first;
    console.log(`Smoke target: first active app = ${app.id} (${app.name})\n`);
  } catch (err) {
    console.log(
      `\u274c apps.yaml not loadable: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    console.log(
      "Copy `apps.example.yaml` from the repo root to $ADARIA_HOME/apps.yaml."
    );
    process.exitCode = 1;
    return;
  }

  await smokeAppStore(config, app);
  await smokePlayStore(config, app);
  await smokeEodinSdk(config, app);
  await smokeEodinGrowth(config);
  await smokeAsoMobile(config, app);
  await smokeFridgify(app);
  await smokeYouTube(config, app);
  await smokeArdenTts(config);

  console.log("\n# Summary");
  const counts = { ok: 0, skip: 0, error: 0 };
  for (const r of results) counts[r.status] += 1;
  console.log(
    `ok=${String(counts.ok)}  skip=${String(counts.skip)}  error=${String(counts.error)}`
  );

  if (counts.error > 0) {
    process.exitCode = 1;
  }
}

await main();
