/**
 * TikTok client — Content Posting API.
 *
 * NOTE: TikTok's Content Posting API requires app review before
 * production access. This client is implemented but may be blocked
 * by the review process. Gate via apps.yaml feature flag.
 */

import {
  type SocialClient,
  type SocialPostContent,
  type SocialPostResult,
  type ValidationResult,
} from "./base.js";
import * as logger from "../utils/logger.js";

const BASE_URL = "https://open.tiktokapis.com/v2";
const MAX_CHARS = 2200;

export interface TikTokConfig {
  clientKey: string;
  clientSecret: string;
  accessToken: string;
}

export class TikTokClient implements SocialClient {
  readonly platform = "tiktok" as const;

  constructor(private readonly config: TikTokConfig) {}

  async post(content: SocialPostContent): Promise<SocialPostResult> {
    const text = this.buildText(content);
    const validation = this.validateContent(text);
    if (!validation.valid) {
      return {
        success: false,
        platform: "tiktok",
        error: validation.issues.join("; "),
      };
    }

    if (!content.imageUrl) {
      return {
        success: false,
        platform: "tiktok",
        error: "TikTok requires an image or video for posting",
      };
    }

    try {
      // Step 1: Initialize photo upload
      const initResponse = await fetch(
        `${BASE_URL}/post/publish/inbox/video/init/`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            post_info: {
              title: text,
              privacy_level: "PUBLIC_TO_EVERYONE",
              disable_comment: false,
              auto_add_music: true,
            },
            source_info: {
              source: "PULL_FROM_URL",
              photo_cover_index: 0,
              photo_images: [content.imageUrl],
            },
          }),
        },
      );

      if (!initResponse.ok) {
        const err = await initResponse.text();
        throw new Error(`TikTok post init failed: ${err}`);
      }

      const result = (await initResponse.json()) as {
        data?: { publish_id?: string };
      };

      return {
        success: true,
        platform: "tiktok",
        postId: result.data?.publish_id,
        postedAt: new Date().toISOString(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[tiktok] Post failed: ${msg}`);
      return { success: false, platform: "tiktok", error: msg };
    }
  }

  validateContent(text: string): ValidationResult {
    const issues: string[] = [];
    const suggestions: string[] = [];

    if (!text.trim()) {
      issues.push("Text is empty");
      return { valid: false, characterCount: 0, issues, suggestions };
    }

    if (text.length > MAX_CHARS) {
      issues.push(`Caption exceeds ${String(MAX_CHARS)} characters (${String(text.length)})`);
    }

    return {
      valid: issues.length === 0,
      characterCount: text.length,
      issues,
      suggestions,
    };
  }

  deletePost(_postId: string): Promise<boolean> {
    // TikTok Content Posting API does not support deletion
    logger.info("[tiktok] Post deletion not supported via API");
    return Promise.resolve(false);
  }

  private buildText(content: SocialPostContent): string {
    let text = content.text;
    if (content.hashtags?.length) {
      const tags = content.hashtags.map((t) =>
        t.startsWith("#") ? t : `#${t}`,
      );
      text = `${text} ${tags.join(" ")}`;
    }
    return text;
  }
}
