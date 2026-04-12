/**
 * Facebook client — Graph API v19.0.
 *
 * Ported from linkgo `ai-service/src/social/facebook_client.py` patterns.
 * Posts to a Facebook Page using a Page Access Token + appsecret_proof HMAC.
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

const BASE_URL = "https://graph.facebook.com/v19.0";
const MAX_CHARS = 63_206;

export interface FacebookConfig {
  appId: string;
  appSecret: string;
  accessToken: string;
  pageId: string;
}

export class FacebookClient implements SocialClient {
  readonly platform = "facebook" as const;
  private pageToken: string | null = null;

  constructor(private readonly config: FacebookConfig) {}

  async post(content: SocialPostContent): Promise<SocialPostResult> {
    if (isDryRun()) {
      logger.info(`[facebook] DRY_RUN: would post: ${content.text.slice(0, 100)}`);
      return dryRunResult("facebook", content);
    }

    const text = this.buildText(content);
    const validation = this.validateContent(text);
    if (!validation.valid) {
      return {
        success: false,
        platform: "facebook",
        error: validation.issues.join("; "),
      };
    }

    try {
      const token = await this.getPageToken();
      const proof = this.computeProof(token);

      // Upload photo if provided
      let photoId: string | null = null;
      if (content.imageUrl) {
        photoId = await this.uploadPhoto(content.imageUrl, token, proof);
      }

      // Post to page feed
      const params = new URLSearchParams({
        message: text,
        access_token: token,
        appsecret_proof: proof,
      });

      if (photoId) {
        params.set("attached_media", JSON.stringify([{ media_fbid: photoId }]));
      } else if (content.link) {
        params.set("link", content.link);
      }

      const response = await fetch(`${BASE_URL}/${this.config.pageId}/feed`, {
        method: "POST",
        body: params,
      });

      if (!response.ok) {
        const err = (await response.json()) as { error?: { message?: string } };
        throw new Error(err?.error?.message ?? `HTTP ${String(response.status)}`);
      }

      const result = (await response.json()) as { id?: string };

      return {
        success: true,
        platform: "facebook",
        postId: result.id,
        postUrl: result.id
          ? `https://www.facebook.com/${result.id}`
          : undefined,
        postedAt: new Date().toISOString(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[facebook] Post failed: ${msg}`);
      return { success: false, platform: "facebook", error: msg };
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
      issues.push(`Text exceeds ${String(MAX_CHARS)} characters`);
    }

    if (text.length < 40) {
      suggestions.push("Consider writing at least 40 characters for better engagement");
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
      logger.info(`[facebook] DRY_RUN: would delete post ${postId}`);
      return true;
    }
    try {
      const token = await this.getPageToken();
      const proof = this.computeProof(token);
      const response = await fetch(
        `${BASE_URL}/${postId}?access_token=${encodeURIComponent(token)}&appsecret_proof=${encodeURIComponent(proof)}`,
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

  private computeProof(token: string): string {
    return crypto
      .createHmac("sha256", this.config.appSecret)
      .update(token)
      .digest("hex");
  }

  private async getPageToken(): Promise<string> {
    if (this.pageToken) return this.pageToken;

    const proof = this.computeProof(this.config.accessToken);
    const response = await fetch(
      `${BASE_URL}/me/accounts?access_token=${encodeURIComponent(this.config.accessToken)}&appsecret_proof=${encodeURIComponent(proof)}`,
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch page token: HTTP ${String(response.status)}`);
    }

    const result = (await response.json()) as {
      data?: Array<{ id: string; access_token: string }>;
    };

    const page = result.data?.find((p) => p.id === this.config.pageId);
    if (!page) {
      throw new Error(`Page ${this.config.pageId} not found in managed pages`);
    }

    this.pageToken = page.access_token;
    return page.access_token;
  }

  private async uploadPhoto(
    imageUrl: string,
    token: string,
    proof: string,
  ): Promise<string | null> {
    try {
      const imgResponse = await fetch(imageUrl);
      if (!imgResponse.ok) return null;
      const buffer = Buffer.from(await imgResponse.arrayBuffer());

      const form = new FormData();
      form.set("source", new Blob([buffer]), "image.jpg");
      form.set("access_token", token);
      form.set("appsecret_proof", proof);
      form.set("published", "false");

      const response = await fetch(
        `${BASE_URL}/${this.config.pageId}/photos`,
        { method: "POST", body: form },
      );

      if (!response.ok) return null;

      const result = (await response.json()) as { id?: string };
      return result.id ?? null;
    } catch (err) {
      logger.error(
        `[facebook] Photo upload error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
