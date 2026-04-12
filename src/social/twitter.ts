/**
 * Twitter/X client — API v2 for posting, v1.1 for media upload.
 *
 * Ported from linkgo `ai-service/src/social/twitter_client.py` patterns.
 * Uses raw fetch instead of tweepy (no Python SDK equivalent in TS).
 * OAuth 1.0a headers are constructed manually for v1.1 media uploads.
 */

import crypto from "node:crypto";
import {
  type SocialClient,
  type SocialPostContent,
  type SocialPostResult,
  type ValidationResult,
  isDryRun,
  dryRunResult,
} from "./base.js";
import * as logger from "../utils/logger.js";

const MAX_CHARS = 280;
const TCO_URL_LENGTH = 23;
const URL_REGEX = /https?:\/\/[^\s]+/g;

export interface TwitterConfig {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

export class TwitterClient implements SocialClient {
  readonly platform = "twitter" as const;

  constructor(private readonly config: TwitterConfig) {}

  async post(content: SocialPostContent): Promise<SocialPostResult> {
    if (isDryRun()) {
      logger.info(`[twitter] DRY_RUN: would post: ${content.text.slice(0, 100)}`);
      return dryRunResult("twitter", content);
    }

    const text = this.buildText(content);
    const validation = this.validateContent(text);
    if (!validation.valid) {
      return {
        success: false,
        platform: "twitter",
        error: validation.issues.join("; "),
      };
    }

    try {
      const body: Record<string, unknown> = { text };

      // Upload image if provided
      if (content.imageUrl) {
        const mediaId = await this.uploadMedia(content.imageUrl);
        if (mediaId) {
          body["media"] = { media_ids: [mediaId] };
        }
      }

      const response = await this.v2Request("POST", "/tweets", body);
      const postId = (response as { data?: { id?: string } })?.data?.id;

      return {
        success: true,
        platform: "twitter",
        postId,
        postUrl: postId
          ? `https://twitter.com/i/status/${postId}`
          : undefined,
        postedAt: new Date().toISOString(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[twitter] Post failed: ${msg}`);
      return { success: false, platform: "twitter", error: msg };
    }
  }

  validateContent(text: string): ValidationResult {
    const issues: string[] = [];
    const suggestions: string[] = [];

    if (!text.trim()) {
      issues.push("Text is empty");
      return { valid: false, characterCount: 0, issues, suggestions };
    }

    // URLs count as 23 chars (t.co shortening)
    const effectiveLength = text.replace(URL_REGEX, "x".repeat(TCO_URL_LENGTH)).length;

    if (effectiveLength > MAX_CHARS) {
      issues.push(`Text exceeds ${String(MAX_CHARS)} characters (effective: ${String(effectiveLength)})`);
    }

    return {
      valid: issues.length === 0,
      characterCount: effectiveLength,
      issues,
      suggestions,
    };
  }

  async deletePost(postId: string): Promise<boolean> {
    if (isDryRun()) {
      logger.info(`[twitter] DRY_RUN: would delete post ${postId}`);
      return true;
    }
    try {
      await this.v2Request("DELETE", `/tweets/${postId}`);
      return true;
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

  private async uploadMedia(imageUrl: string): Promise<string | null> {
    try {
      // Download image
      const imgResponse = await fetch(imageUrl);
      if (!imgResponse.ok) return null;
      const buffer = Buffer.from(await imgResponse.arrayBuffer());

      // Build OAuth 1.0a headers for v1.1 media upload
      const uploadUrl = "https://upload.twitter.com/1.1/media/upload.json";
      const boundary = `----FormBoundary${crypto.randomUUID().replace(/-/g, "")}`;

      const bodyParts = [
        `--${boundary}\r\n`,
        'Content-Disposition: form-data; name="media_data"\r\n\r\n',
        buffer.toString("base64"),
        `\r\n--${boundary}--\r\n`,
      ];
      const bodyBuffer = Buffer.from(bodyParts.join(""));

      const oauthHeaders = this.buildOAuth1Headers("POST", uploadUrl);

      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          ...oauthHeaders,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body: bodyBuffer,
      });

      if (!response.ok) {
        logger.error(`[twitter] Media upload failed: ${String(response.status)}`);
        return null;
      }

      const result = (await response.json()) as { media_id_string?: string };
      return result.media_id_string ?? null;
    } catch (err) {
      logger.error(
        `[twitter] Media upload error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async v2Request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const url = `https://api.twitter.com/2${path}`;
    const oauthHeaders = this.buildOAuth1Headers(method, url);

    const response = await fetch(url, {
      method,
      headers: {
        ...oauthHeaders,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Twitter API ${String(response.status)}: ${text}`);
    }

    return response.json() as unknown;
  }

  /**
   * Build OAuth 1.0a Authorization header.
   */
  private buildOAuth1Headers(
    method: string,
    url: string,
  ): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomUUID().replace(/-/g, "");

    const params: Record<string, string> = {
      oauth_consumer_key: this.config.apiKey,
      oauth_nonce: nonce,
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: timestamp,
      oauth_token: this.config.accessToken,
      oauth_version: "1.0",
    };

    // Build signature base string
    const sortedParams = Object.keys(params)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!)}`)
      .join("&");

    const baseString = `${method.toUpperCase()}&${encodeURIComponent(url)}&${encodeURIComponent(sortedParams)}`;
    const signingKey = `${encodeURIComponent(this.config.apiSecret)}&${encodeURIComponent(this.config.accessTokenSecret)}`;

    const signature = crypto
      .createHmac("sha1", signingKey)
      .update(baseString)
      .digest("base64");

    params["oauth_signature"] = signature;

    const header = Object.keys(params)
      .sort()
      .map((k) => `${encodeURIComponent(k)}="${encodeURIComponent(params[k]!)}"`)
      .join(", ");

    return { Authorization: `OAuth ${header}` };
  }
}
