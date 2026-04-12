/**
 * Manual social platform smoke test.
 *
 * Creates each social platform client using credentials from config.yaml
 * (resolved via keychain) and runs `validateContent` + a dry-run `post`.
 * When `ADARIA_DRY_RUN=1` is set (default), no real API calls are made.
 *
 * Usage:
 *   ADARIA_DRY_RUN=1 npx tsx scripts/smoke-social.ts
 *   ADARIA_HOME=~/.adaria-dev ADARIA_DRY_RUN=1 npx tsx scripts/smoke-social.ts
 *
 * To test against real APIs (posts will be published!):
 *   ADARIA_DRY_RUN=0 npx tsx scripts/smoke-social.ts
 */

import { loadConfig } from "../src/config/store.js";
import {
  createSocialClient,
  type SocialConfigs,
} from "../src/social/factory.js";
import type { SocialClient, SocialPlatform } from "../src/social/base.js";

// Default to dry run for safety
if (!process.env["ADARIA_DRY_RUN"]) {
  process.env["ADARIA_DRY_RUN"] = "1";
}

type SmokeStatus = "ok" | "skip" | "error";

interface SmokeResult {
  platform: SocialPlatform;
  status: SmokeStatus;
  detail?: string;
  validation?: { valid: boolean; issues: string[] };
}

const PLATFORMS: SocialPlatform[] = [
  "twitter",
  "facebook",
  "threads",
  "tiktok",
  "youtube",
  "linkedin",
];

const SAMPLE_TEXT: Record<SocialPlatform, string> = {
  twitter: "Check out Fridgify - the smart recipe app! #foodtech #cooking",
  facebook:
    "Fridgify just hit 10,000 downloads! Thank you to our amazing community. We've been working hard on new features including smart recipe suggestions based on what's in your fridge.",
  threads: "New Fridgify update just dropped! Smart recipes based on your fridge contents.",
  tiktok: "POV: You open the fridge and Fridgify tells you what to cook #fridgify #cooking #foodtok",
  youtube:
    "Fridgify Weekly Update: New smart recipe algorithm, improved ingredient recognition, and 500+ new recipes added this month!",
  linkedin:
    "Excited to share that Fridgify has reached a milestone of 10,000 active users. Our AI-powered recipe suggestion engine is helping families reduce food waste by an average of 30%.",
};

async function smokePlatform(
  platform: SocialPlatform,
  client: SocialClient,
): Promise<SmokeResult> {
  const text = SAMPLE_TEXT[platform];
  const result: SmokeResult = { platform, status: "ok" };

  // 1. Validate content
  const validation = client.validateContent(text);
  result.validation = { valid: validation.valid, issues: validation.issues };

  if (!validation.valid) {
    result.status = "error";
    result.detail = `Validation failed: ${validation.issues.join(", ")}`;
    return result;
  }

  // 2. Post (dry-run or real)
  const postResult = await client.post({ text });

  if (!postResult.success) {
    result.status = "error";
    result.detail = `Post failed: ${postResult.error ?? "unknown"}`;
    return result;
  }

  result.detail = postResult.dryRun
    ? `DRY RUN — postId=${postResult.postId ?? "n/a"}`
    : `POSTED — postId=${postResult.postId ?? "n/a"} url=${postResult.postUrl ?? "n/a"}`;

  return result;
}

async function main(): Promise<void> {
  const dryRun = process.env["ADARIA_DRY_RUN"] === "1";
  console.log(`\nSocial Platform Smoke Test ${dryRun ? "(DRY RUN)" : "(LIVE!)"}\n`);
  console.log("=".repeat(60));

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error(
      `Failed to load config: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const socialConfigs: SocialConfigs = {
    twitter: config.social?.twitter,
    facebook: config.social?.facebook,
    threads: config.social?.threads,
    tiktok: config.social?.tiktok,
    youtube: config.social?.youtube,
    linkedin: config.social?.linkedin,
  };

  const results: SmokeResult[] = [];

  for (const platform of PLATFORMS) {
    const client = createSocialClient(platform, socialConfigs);

    if (!client) {
      results.push({
        platform,
        status: "skip",
        detail: "Not configured (missing credentials)",
      });
      continue;
    }

    try {
      const result = await smokePlatform(platform, client);
      results.push(result);
    } catch (err) {
      results.push({
        platform,
        status: "error",
        detail: `Exception: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("RESULTS\n");

  const statusEmoji: Record<SmokeStatus, string> = {
    ok: "✅",
    skip: "⏭️ ",
    error: "❌",
  };

  for (const r of results) {
    const emoji = statusEmoji[r.status];
    console.log(`${emoji} ${r.platform.padEnd(10)} ${r.status.toUpperCase()}`);
    if (r.detail) console.log(`   ${r.detail}`);
    if (r.validation) {
      console.log(`   Validation: ${r.validation.valid ? "PASS" : "FAIL"}`);
      for (const issue of r.validation.issues) {
        console.log(`     - ${issue}`);
      }
    }
  }

  const okCount = results.filter((r) => r.status === "ok").length;
  const skipCount = results.filter((r) => r.status === "skip").length;
  const errorCount = results.filter((r) => r.status === "error").length;

  console.log(`\nSummary: ${String(okCount)} ok / ${String(skipCount)} skip / ${String(errorCount)} error`);

  if (errorCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
