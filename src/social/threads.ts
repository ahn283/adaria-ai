/**
 * Threads client — Meta Threads API.
 *
 * Uses the two-step container → publish flow. Images require creating
 * an image container first, then publishing it.
 */

import {
  type SocialClient,
  type SocialPostContent,
  type SocialPostResult,
  type ValidationResult,
  isDryRun,
  dryRunResult,
} from "./base.js";
import * as logger from "../utils/logger.js";

const BASE_URL = "https://graph.threads.net/v1.0";
const MAX_CHARS = 500;

export interface ThreadsConfig {
  accessToken: string;
  userId: string;
}

export class ThreadsClient implements SocialClient {
  readonly platform = "threads" as const;

  constructor(private readonly config: ThreadsConfig) {}

  async post(content: SocialPostContent): Promise<SocialPostResult> {
    if (isDryRun()) {
      logger.info(`[threads] DRY_RUN: would post: ${content.text.slice(0, 100)}`);
      return dryRunResult("threads", content);
    }

    const text = this.buildText(content);
    const validation = this.validateContent(text);
    if (!validation.valid) {
      return {
        success: false,
        platform: "threads",
        error: validation.issues.join("; "),
      };
    }

    try {
      // Step 1: Create media container
      const containerParams: Record<string, string> = {
        text,
        media_type: content.imageUrl ? "IMAGE" : "TEXT",
        access_token: this.config.accessToken,
      };
      if (content.imageUrl) {
        containerParams["image_url"] = content.imageUrl;
      }

      const containerResponse = await fetch(
        `${BASE_URL}/${this.config.userId}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(containerParams),
        },
      );

      if (!containerResponse.ok) {
        const err = await containerResponse.text();
        throw new Error(`Container creation failed: ${err}`);
      }

      const container = (await containerResponse.json()) as { id?: string };
      if (!container.id) throw new Error("No container ID returned");

      // Step 2: Publish
      const publishResponse = await fetch(
        `${BASE_URL}/${this.config.userId}/threads_publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            creation_id: container.id,
            access_token: this.config.accessToken,
          }),
        },
      );

      if (!publishResponse.ok) {
        const err = await publishResponse.text();
        throw new Error(`Publish failed: ${err}`);
      }

      const result = (await publishResponse.json()) as { id?: string };

      return {
        success: true,
        platform: "threads",
        postId: result.id,
        postUrl: result.id
          ? `https://www.threads.net/post/${result.id}`
          : undefined,
        postedAt: new Date().toISOString(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[threads] Post failed: ${msg}`);
      return { success: false, platform: "threads", error: msg };
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

  async deletePost(postId: string): Promise<boolean> {
    if (isDryRun()) {
      logger.info(`[threads] DRY_RUN: would delete post ${postId}`);
      return true;
    }
    try {
      const response = await fetch(
        `${BASE_URL}/${postId}?access_token=${encodeURIComponent(this.config.accessToken)}`,
        { method: "DELETE" },
      );
      return response.ok;
    } catch {
      return false;
    }
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
