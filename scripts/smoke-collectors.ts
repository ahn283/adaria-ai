/**
 * Manual collector smoke test.
 *
 * Hits each ported collector with real credentials (sourced from env
 * vars) and prints a compact sample of the response. This is **not** a
 * unit test — it talks to live APIs and costs real quota. Used once at
 * the end of M2 and any time a collector contract is touched afterwards.
 *
 *   npm run smoke:collectors
 *
 * All credentials are read from environment variables so this script
 * can be run without touching `~/.adaria/config.yaml`. Any credential
 * that is not set simply SKIPs the relevant block. A run with zero
 * credentials is still valid — it exercises the SSRF allowlist and
 * constructor validation paths without hitting the network.
 *
 * Required env vars (all optional, each collector independently skipped):
 *   ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY, ASC_APP_ID
 *   PLAY_SERVICE_ACCOUNT_JSON, PLAY_PACKAGE_NAME
 *   EODIN_SDK_API_KEY, EODIN_SDK_APP_ID
 *   EODIN_GROWTH_TOKEN
 *   ASO_MOBILE_API_KEY, ASO_APP_ID
 *   FRIDGIFY (set to any value to run — no auth required)
 *   YOUTUBE_API_KEY, YOUTUBE_CHANNEL_ID
 *   ARDEN_TTS_ENDPOINT
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

async function run(
  name: string,
  fn: () => Promise<string>
): Promise<void> {
  try {
    const msg = await fn();
    ok(name, msg);
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// App Store Connect
// ---------------------------------------------------------------------------

async function smokeAppStore(): Promise<void> {
  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  const privateKey = process.env.ASC_PRIVATE_KEY;
  const appId = process.env.ASC_APP_ID;

  if (!keyId || !issuerId || !privateKey || !appId) {
    skip(
      "AppStoreCollector",
      "set ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY, ASC_APP_ID"
    );
    return;
  }

  await run("AppStoreCollector.getReviews", async () => {
    const c = new AppStoreCollector({ keyId, issuerId, privateKey });
    const reviews = await c.getReviews(appId, 5);
    return `${String(reviews.length)} reviews: ${preview(reviews.slice(0, 1))}`;
  });
}

// ---------------------------------------------------------------------------
// Google Play
// ---------------------------------------------------------------------------

async function smokePlayStore(): Promise<void> {
  const serviceAccountJson = process.env.PLAY_SERVICE_ACCOUNT_JSON;
  const pkg = process.env.PLAY_PACKAGE_NAME;

  if (!serviceAccountJson || !pkg) {
    skip(
      "PlayStoreCollector",
      "set PLAY_SERVICE_ACCOUNT_JSON (raw JSON string) and PLAY_PACKAGE_NAME"
    );
    return;
  }

  await run("PlayStoreCollector.getReviews", async () => {
    const c = new PlayStoreCollector({ serviceAccountJson });
    const reviews = await c.getReviews(pkg);
    return `${String(reviews.length)} reviews: ${preview(reviews.slice(0, 1))}`;
  });
}

// ---------------------------------------------------------------------------
// Eodin SDK analytics
// ---------------------------------------------------------------------------

async function smokeEodinSdk(): Promise<void> {
  const apiKey = process.env.EODIN_SDK_API_KEY;
  const appId = process.env.EODIN_SDK_APP_ID;

  if (!apiKey || !appId) {
    skip("EodinSdkCollector", "set EODIN_SDK_API_KEY, EODIN_SDK_APP_ID");
    return;
  }

  const c = new EodinSdkCollector({ apiKey });
  const today = new Date().toISOString().slice(0, 10);
  const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  await run("EodinSdkCollector.getSummary", async () => {
    const rows = await c.getSummary(appId, lastWeek, today);
    return `${String(rows.length)} rows: ${preview(rows.slice(0, 1))}`;
  });
  await run("EodinSdkCollector.getFunnel", async () => {
    const funnel = await c.getFunnel(appId, lastWeek, today);
    return `${String(funnel.funnel.length)} steps, overall_conversion=${String(funnel.overall_conversion)}`;
  });
}

// ---------------------------------------------------------------------------
// Eodin Blog / SEO / Analytics
// ---------------------------------------------------------------------------

async function smokeEodinBlog(): Promise<void> {
  const token = process.env.EODIN_GROWTH_TOKEN;
  if (!token) {
    skip("EodinBlogPublisher", "set EODIN_GROWTH_TOKEN");
    return;
  }

  const pub = new EodinBlogPublisher({ token });
  const seo = new EodinSeoMetrics({ token });
  const an = new EodinAnalytics({ token });

  await run("EodinBlogPublisher.listSlugs", async () => {
    const slugs = await pub.listSlugs();
    return `${String(slugs.length)} slugs: ${preview(slugs.slice(0, 3))}`;
  });

  const today = new Date().toISOString().slice(0, 10);
  const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  await run("EodinSeoMetrics.getOverview", async () => {
    const overview = await seo.getOverview(lastWeek, today);
    return preview(overview);
  });
  await run("EodinAnalytics.getTraffic", async () => {
    const traffic = await an.getTraffic(lastWeek, today);
    return preview(traffic);
  });
}

// ---------------------------------------------------------------------------
// ASOMobile
// ---------------------------------------------------------------------------

async function smokeAsoMobile(): Promise<void> {
  const apiKey = process.env.ASO_MOBILE_API_KEY;
  const appId = process.env.ASO_APP_ID;
  if (!apiKey || !appId) {
    skip("AsoMobileCollector", "set ASO_MOBILE_API_KEY, ASO_APP_ID");
    return;
  }

  const c = new AsoMobileCollector({ apiKey });
  await run("AsoMobileCollector.getKeywordSuggestions", async () => {
    const suggestions = await c.getKeywordSuggestions(appId, "ios");
    return `${String(suggestions.length)} suggestions: ${preview(suggestions.slice(0, 2))}`;
  });
}

// ---------------------------------------------------------------------------
// Fridgify (public, no auth)
// ---------------------------------------------------------------------------

async function smokeFridgify(): Promise<void> {
  if (!process.env.FRIDGIFY) {
    skip(
      "FridgifyRecipesCollector",
      "set FRIDGIFY=1 to run (public API — no auth)"
    );
    return;
  }

  const c = new FridgifyRecipesCollector();
  await run("FridgifyRecipesCollector.getPopular", async () => {
    const rows = await c.getPopular({ period: "month", limit: 3 });
    return `${String(rows.length)} recipes: ${preview(rows.map((r) => r.name ?? r.id))}`;
  });
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

async function smokeYouTube(): Promise<void> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const channelId = process.env.YOUTUBE_CHANNEL_ID;
  if (!apiKey || !channelId) {
    skip("YouTubeCollector", "set YOUTUBE_API_KEY, YOUTUBE_CHANNEL_ID");
    return;
  }

  const c = new YouTubeCollector({ apiKey });
  await run("YouTubeCollector.getRecentShorts", async () => {
    const shorts = await c.getRecentShorts(channelId, 5);
    return `${String(shorts.length)} shorts: ${preview(
      shorts.map((s) => `${s.videoId}@${s.duration ?? "?"}`)
    )}`;
  });
}

// ---------------------------------------------------------------------------
// Arden TTS
// ---------------------------------------------------------------------------

async function smokeArdenTts(): Promise<void> {
  const endpoint = process.env.ARDEN_TTS_ENDPOINT;
  if (!endpoint) {
    skip("ArdenTtsClient", "set ARDEN_TTS_ENDPOINT");
    return;
  }

  const c = new ArdenTtsClient({ endpoint });
  await run("ArdenTtsClient.synthesize", async () => {
    const audio = await c.synthesize("smoke test", { locale: "ko" });
    return `${String(audio.length)} bytes of MP3`;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("# adaria-ai collector smoke test\n");

  await smokeAppStore();
  await smokePlayStore();
  await smokeEodinSdk();
  await smokeEodinBlog();
  await smokeAsoMobile();
  await smokeFridgify();
  await smokeYouTube();
  await smokeArdenTts();

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
