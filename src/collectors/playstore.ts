import { SignJWT, importPKCS8 } from "jose";

import { AuthError, ExternalApiError, RateLimitError } from "../utils/errors.js";
import { parseRetryAfter } from "../utils/retry.js";
import type { StoreReview } from "../types/collectors.js";

/**
 * Google Play Developer API collector.
 * Uses a Service Account JSON for authentication via JWT → OAuth token exchange.
 *
 * @see https://developers.google.com/android-publisher
 */
export interface PlayStoreServiceAccount {
  client_email: string;
  private_key: string;
}

export interface PlayStoreCollectorOptions {
  serviceAccountJson: PlayStoreServiceAccount | string;
}

/**
 * Test-only overrides. Kept off {@link PlayStoreCollectorOptions} so
 * production config loaders cannot feed a user-controlled URL into the
 * SSRF surface.
 */
export interface PlayStoreCollectorTestHooks {
  baseUrl?: string;
  tokenUrl?: string;
}

type RequestInitLike = {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
};

const DEFAULT_BASE_URL =
  "https://androidpublisher.googleapis.com/androidpublisher/v3";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const REPLY_LIMIT = 350;

interface GoogleOAuthTokenResponse {
  access_token: string;
  expires_in: number;
}

interface PlayReviewsResponse {
  reviews?: {
    reviewId: string;
    comments?: {
      userComment?: {
        starRating?: number;
        text?: string;
        lastModified?: { seconds?: string | number };
      };
    }[];
  }[];
}

export class PlayStoreCollector {
  private readonly serviceAccount: PlayStoreServiceAccount;
  private readonly baseUrl: string;
  private readonly tokenUrl: string;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    options: PlayStoreCollectorOptions,
    testHooks?: PlayStoreCollectorTestHooks
  ) {
    if (!options.serviceAccountJson) {
      throw new Error("PlayStoreCollector requires serviceAccountJson");
    }
    if (typeof options.serviceAccountJson === "string") {
      try {
        this.serviceAccount = JSON.parse(
          options.serviceAccountJson
        ) as PlayStoreServiceAccount;
      } catch {
        // Never surface parser errors verbatim — the raw text may contain
        // a leading fragment of the private key.
        throw new AuthError(
          "PlayStoreCollector: serviceAccountJson is not valid JSON"
        );
      }
    } else {
      this.serviceAccount = options.serviceAccountJson;
    }

    if (!this.serviceAccount.client_email || !this.serviceAccount.private_key) {
      throw new Error(
        "PlayStoreCollector: serviceAccountJson must include client_email and private_key"
      );
    }

    this.baseUrl = testHooks?.baseUrl ?? DEFAULT_BASE_URL;
    this.tokenUrl = testHooks?.tokenUrl ?? DEFAULT_TOKEN_URL;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    const key = await importPKCS8(this.serviceAccount.private_key, "RS256");
    const jwt = await new SignJWT({
      scope: "https://www.googleapis.com/auth/androidpublisher",
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.serviceAccount.client_email)
      .setAudience(this.tokenUrl)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key);

    const response = await fetch(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new ExternalApiError(`Google OAuth failed: ${body}`, {
        statusCode: response.status,
      });
    }

    const data = (await response.json()) as GoogleOAuthTokenResponse;
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return this.accessToken;
  }

  private async request<T>(path: string, init?: RequestInitLike): Promise<T> {
    const token = await this.getAccessToken();
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    };

    const fetchInit: RequestInit = { headers };
    if (init?.method !== undefined) fetchInit.method = init.method;
    if (init?.body !== undefined) fetchInit.body = init.body;

    const response = await fetch(url, fetchInit);

    if (response.status === 429) {
      throw new RateLimitError("Google Play API rate limited", {
        retryAfterSeconds: parseRetryAfter(
          response.headers.get("Retry-After")
        ),
      });
    }

    if (!response.ok) {
      const body = await response.text();
      throw new ExternalApiError(
        `Google Play API ${String(response.status)}: ${body}`,
        { statusCode: response.status }
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Fetch reviews for a package.
   */
  async getReviews(packageName: string): Promise<StoreReview[]> {
    const data = await this.request<PlayReviewsResponse>(
      `/applications/${packageName}/reviews`
    );
    return (data.reviews ?? []).map((r) => {
      const comment = r.comments?.[0]?.userComment;
      const rawSeconds = comment?.lastModified?.seconds;
      const seconds =
        typeof rawSeconds === "string"
          ? Number.parseInt(rawSeconds, 10)
          : typeof rawSeconds === "number"
            ? rawSeconds
            : null;
      const createdAt =
        seconds !== null && Number.isFinite(seconds)
          ? new Date(seconds * 1000).toISOString()
          : null;
      return {
        reviewId: r.reviewId,
        rating: comment?.starRating ?? 0,
        body: comment?.text ?? "",
        createdAt,
      };
    });
  }

  /**
   * Fetch app listing details (title, short/full description) for a locale.
   */
  async getAppDetails(packageName: string, locale = "ko-KR"): Promise<unknown> {
    return this.request(
      `/applications/${packageName}/edits/-/listings/${locale}`
    );
  }

  /**
   * Reply to a review on Google Play. Approval-gated write path.
   */
  async replyToReview(
    packageName: string,
    reviewId: string,
    replyText: string
  ): Promise<unknown> {
    if (typeof replyText !== "string" || replyText.trim().length === 0) {
      throw new Error("replyToReview: replyText must be a non-empty string");
    }
    if (replyText.length > REPLY_LIMIT) {
      throw new Error(
        `replyToReview: replyText exceeds Google Play ${String(REPLY_LIMIT)} char limit (${String(replyText.length)})`
      );
    }
    return this.request(
      `/applications/${packageName}/reviews/${reviewId}:reply`,
      {
        method: "POST",
        body: JSON.stringify({ replyText }),
      }
    );
  }
}
