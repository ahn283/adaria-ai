/**
 * YouTube client — Data API v3, community posts.
 *
 * Posts community updates to a YouTube channel. Image upload via
 * the Activities API or direct community post endpoint.
 */

import {
  type SocialClient,
  type SocialPostContent,
  type SocialPostResult,
  type ValidationResult,
} from "./base.js";
import * as logger from "../utils/logger.js";

const MAX_CHARS = 5000;

export interface YouTubeConfig {
  accessToken: string;
  channelId: string;
}

export class YouTubeClient implements SocialClient {
  readonly platform = "youtube" as const;

  constructor(private readonly config: YouTubeConfig) {}

  async post(content: SocialPostContent): Promise<SocialPostResult> {
    const text = this.buildText(content);
    const validation = this.validateContent(text);
    if (!validation.valid) {
      return {
        success: false,
        platform: "youtube",
        error: validation.issues.join("; "),
      };
    }

    try {
      // YouTube Data API v3 — create a community post (activities.insert)
      // Note: Community posts require channel membership and the API
      // endpoint may be limited. Using the bulletin type.
      const response = await fetch(
        "https://www.googleapis.com/youtube/v3/activities?part=snippet,contentDetails",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            snippet: {
              channelId: this.config.channelId,
              description: text,
              type: "bulletin",
            },
            contentDetails: {
              bulletin: {
                resourceId: {
                  kind: "youtube#channel",
                  channelId: this.config.channelId,
                },
              },
            },
          }),
        },
      );

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`YouTube API ${String(response.status)}: ${err}`);
      }

      const result = (await response.json()) as { id?: string };

      return {
        success: true,
        platform: "youtube",
        postId: result.id,
        postUrl: result.id
          ? `https://www.youtube.com/post/${result.id}`
          : undefined,
        postedAt: new Date().toISOString(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[youtube] Post failed: ${msg}`);
      return { success: false, platform: "youtube", error: msg };
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
      issues.push(`Text exceeds ${String(MAX_CHARS)} characters (${String(text.length)})`);
    }

    return {
      valid: issues.length === 0,
      characterCount: text.length,
      issues,
      suggestions,
    };
  }

  deletePost(_postId: string): Promise<boolean> {
    // Community posts cannot be deleted via the Data API v3
    logger.info("[youtube] Community post deletion not supported via API");
    return Promise.resolve(false);
  }

  private buildText(content: SocialPostContent): string {
    let text = content.text;
    if (content.hashtags?.length) {
      const tags = content.hashtags.map((t) =>
        t.startsWith("#") ? t : `#${t}`,
      );
      text = `${text}\n\n${tags.join(" ")}`;
    }
    return text;
  }
}
