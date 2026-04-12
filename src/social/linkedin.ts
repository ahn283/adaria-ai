/**
 * LinkedIn client — REST API v2.
 *
 * Ported from linkgo `ai-service/src/social/linkedin_client.py` patterns.
 * Posts to an organization page with optional image upload (3-step flow).
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

const REST_URL = "https://api.linkedin.com/rest";
const MAX_CHARS = 3000;
const LINKEDIN_VERSION = "202411";

export interface LinkedInConfig {
  accessToken: string;
  organizationId: string;
}

export class LinkedInClient implements SocialClient {
  readonly platform = "linkedin" as const;

  constructor(private readonly config: LinkedInConfig) {}

  async post(content: SocialPostContent): Promise<SocialPostResult> {
    if (isDryRun()) {
      logger.info(`[linkedin] DRY_RUN: would post: ${content.text.slice(0, 100)}`);
      return dryRunResult("linkedin", content);
    }

    const text = this.buildText(content);
    const validation = this.validateContent(text);
    if (!validation.valid) {
      return {
        success: false,
        platform: "linkedin",
        error: validation.issues.join("; "),
      };
    }

    try {
      const authorUrn = `urn:li:organization:${this.config.organizationId}`;

      // Upload image if provided (3-step flow)
      let assetUrn: string | null = null;
      if (content.imageUrl) {
        assetUrn = await this.uploadImage(content.imageUrl, authorUrn);
      }

      // Build post body
      const body: Record<string, unknown> = {
        author: authorUrn,
        lifecycleState: "PUBLISHED",
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        commentary: text,
        isReshareDisabledByAuthor: false,
      };

      if (assetUrn) {
        body["content"] = { media: { id: assetUrn } };
      }

      const response = await fetch(`${REST_URL}/posts`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`LinkedIn API ${String(response.status)}: ${err}`);
      }

      // Post ID is in the response header, not the body
      const postId = response.headers.get("x-linkedin-id") ?? undefined;

      return {
        success: true,
        platform: "linkedin",
        postId,
        postUrl: postId
          ? `https://www.linkedin.com/feed/update/${postId}`
          : undefined,
        postedAt: new Date().toISOString(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[linkedin] Post failed: ${msg}`);
      return { success: false, platform: "linkedin", error: msg };
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

    if (text.length > 1300) {
      suggestions.push("Consider keeping under 1,300 characters for better engagement");
    }

    const hashtagCount = (text.match(/#/g) ?? []).length;
    if (hashtagCount > 5) {
      suggestions.push("Consider using 3-5 hashtags for optimal reach");
    }
    if (hashtagCount === 0) {
      suggestions.push("Consider adding 3-5 relevant hashtags");
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
      logger.info(`[linkedin] DRY_RUN: would delete post ${postId}`);
      return true;
    }
    try {
      const response = await fetch(`${REST_URL}/posts/${postId}`, {
        method: "DELETE",
        headers: this.buildHeaders(),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * 3-step image upload: initialize → PUT binary → return asset URN.
   */
  private async uploadImage(
    imageUrl: string,
    authorUrn: string,
  ): Promise<string | null> {
    try {
      // Step 1: Download image
      const imgResponse = await fetch(imageUrl);
      if (!imgResponse.ok) return null;
      const buffer = Buffer.from(await imgResponse.arrayBuffer());
      const contentType =
        imgResponse.headers.get("content-type") ?? "image/jpeg";

      // Step 2: Initialize upload
      const initResponse = await fetch(
        `${REST_URL}/images?action=initializeUpload`,
        {
          method: "POST",
          headers: this.buildHeaders(),
          body: JSON.stringify({
            initializeUploadRequest: { owner: authorUrn },
          }),
        },
      );

      if (!initResponse.ok) {
        logger.error(`[linkedin] Image init failed: ${String(initResponse.status)}`);
        return null;
      }

      const initResult = (await initResponse.json()) as {
        value?: { uploadUrl?: string; image?: string };
      };
      const uploadUrl = initResult.value?.uploadUrl;
      const assetUrn = initResult.value?.image;
      if (!uploadUrl || !assetUrn) return null;

      // Step 3: PUT binary
      const putResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          "Content-Type": contentType,
        },
        body: buffer,
      });

      if (!putResponse.ok) {
        logger.error(`[linkedin] Image PUT failed: ${String(putResponse.status)}`);
        return null;
      }

      return assetUrn;
    } catch (err) {
      logger.error(
        `[linkedin] Image upload error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
      "LinkedIn-Version": LINKEDIN_VERSION,
    };
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
