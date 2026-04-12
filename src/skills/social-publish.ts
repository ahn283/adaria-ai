/**
 * Social publish skill.
 *
 * Generates platform-optimised marketing content via Claude and produces
 * ApprovalItem[] — one per enabled platform. On approval, the platform
 * client posts and the result is recorded in the social_posts DB table.
 */

import type { Skill } from "./index.js";
import type { SkillContext, SkillResult, ApprovalItem } from "../types/skill.js";
import type { AppConfig } from "../config/apps-schema.js";
import type { SocialPlatform, SocialPostContent } from "../social/base.js";
import { createSocialClient, type SocialConfigs } from "../social/factory.js";
import { insertSocialPost } from "../db/queries.js";
import { parseAppNameFromCommand } from "./index.js";
import { preparePrompt } from "../prompts/loader.js";
import { parseJsonResponse } from "../utils/parse-json.js";
import * as logger from "../utils/logger.js";

const ALL_PLATFORMS: SocialPlatform[] = [
  "twitter",
  "facebook",
  "threads",
  "tiktok",
  "youtube",
  "linkedin",
];

interface PlatformContent {
  platform: string;
  text: string;
  hashtags: string[];
}

export interface SocialPublishSkillDeps {
  socialConfigs: SocialConfigs;
}

export class SocialPublishSkill implements Skill {
  readonly name = "social-publish";
  readonly commands = ["social", "\uc18c\uc15c", "sns"] as const;

  constructor(private readonly deps: SocialPublishSkillDeps) {}

  async dispatch(ctx: SkillContext, text: string): Promise<SkillResult> {
    const appName = parseAppNameFromCommand(text);
    const app = appName
      ? ctx.apps.find(
          (a) => a.name.toLowerCase() === appName.toLowerCase(),
        )
      : ctx.apps[0];

    if (!app) {
      return {
        summary: `App not found: ${appName ?? "(none)"}`,
        alerts: [],
        approvals: [],
      };
    }

    // Determine which platforms are enabled for this app
    const enabledPlatforms = ALL_PLATFORMS.filter(
      (p) => app.social[p] === true,
    );

    if (enabledPlatforms.length === 0) {
      return {
        summary: `No social platforms enabled for ${app.name}. Enable platforms in apps.yaml under \`social:\`.`,
        alerts: [],
        approvals: [],
      };
    }

    // Generate platform-specific content via Claude
    const platformContents = await this.generateContent(
      ctx,
      app,
      enabledPlatforms,
    );

    if (platformContents.length === 0) {
      return {
        summary: `Failed to generate social content for ${app.name}.`,
        alerts: [],
        approvals: [],
      };
    }

    // Build approval items — one per platform
    const approvals: ApprovalItem[] = platformContents.map((pc) => ({
      id: `social-${pc.platform}-${app.id}-${Date.now()}`,
      description: `[${pc.platform.toUpperCase()}] ${pc.text.slice(0, 100)}${pc.text.length > 100 ? "..." : ""}`,
      agent: "social-publish",
      payload: {
        platform: pc.platform,
        appId: app.id,
        content: {
          text: pc.text,
          hashtags: pc.hashtags,
        } satisfies SocialPostContent,
      },
    }));

    const platformList = platformContents
      .map((pc) => `\u2022 *${pc.platform}*: ${pc.text.slice(0, 80)}...`)
      .join("\n");

    return {
      summary: `Generated social content for ${app.name} on ${String(enabledPlatforms.length)} platform(s):\n${platformList}\n\n_Approve each platform to publish._`,
      alerts: [],
      approvals,
    };
  }

  /**
   * Execute the actual post after approval. Called by the approval
   * callback handler with the payload from the ApprovalItem.
   */
  async executePost(
    ctx: SkillContext,
    payload: {
      platform: SocialPlatform;
      appId: string;
      content: SocialPostContent;
    },
  ): Promise<void> {
    const client = createSocialClient(
      payload.platform,
      this.deps.socialConfigs,
    );

    if (!client) {
      logger.error(
        `[social-publish] No client for ${payload.platform} — credentials missing`,
      );
      return;
    }

    const result = await client.post(payload.content);

    insertSocialPost(ctx.db, {
      app_id: payload.appId,
      platform: payload.platform,
      post_id: result.postId ?? null,
      post_url: result.postUrl ?? null,
      content: payload.content.text,
      image_url: payload.content.imageUrl ?? null,
      status: result.success ? "posted" : "failed",
    });

    if (result.success) {
      logger.info(
        `[social-publish] Posted to ${payload.platform}: ${result.postUrl ?? result.postId ?? "ok"}`,
      );
    } else {
      logger.error(
        `[social-publish] Failed to post to ${payload.platform}: ${result.error ?? "unknown"}`,
      );
    }
  }

  private async generateContent(
    ctx: SkillContext,
    app: AppConfig,
    platforms: SocialPlatform[],
  ): Promise<PlatformContent[]> {
    try {
      const prompt = preparePrompt("social-publish", {
        appName: app.name,
        platforms: platforms.join(", "),
        keywords: app.primaryKeywords.join(", ") || "N/A",
      });

      const response = await ctx.runClaude(prompt);
      const parsed = parseJsonResponse(response) as PlatformContent[] | null;

      if (!Array.isArray(parsed)) {
        logger.error("[social-publish] Claude did not return a JSON array");
        return [];
      }

      return parsed.filter(
        (pc) =>
          typeof pc.platform === "string" &&
          typeof pc.text === "string" &&
          pc.text.trim().length > 0 &&
          platforms.includes(pc.platform as SocialPlatform),
      );
    } catch (err) {
      logger.error(
        `[social-publish] Content generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }
}
