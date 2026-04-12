import { SignJWT, importPKCS8 } from "jose";

import { ExternalApiError, RateLimitError } from "../utils/errors.js";
import { parseRetryAfter } from "../utils/retry.js";
import type {
  AppStoreLocalization,
  AppStoreLocalizationUpdate,
  StoreReview,
} from "../types/collectors.js";

/**
 * App Store Connect API collector.
 *
 * @see https://developer.apple.com/documentation/appstoreconnectapi
 */
export interface AppStoreCollectorOptions {
  keyId: string;
  issuerId: string;
  /** PEM-encoded private key (PKCS#8) for ES256 JWT signing. */
  privateKey: string;
}

/**
 * Test-only overrides. Deliberately kept off {@link AppStoreCollectorOptions}
 * so that production config loaders (M3) cannot introduce a user-controlled
 * base URL into the SSRF surface. Only passed from unit tests.
 */
export interface AppStoreCollectorTestHooks {
  baseUrl?: string;
}

type RequestInitLike = {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
};

const DEFAULT_BASE_URL = "https://api.appstoreconnect.apple.com/v1";
const TOKEN_LIFETIME_MS = 19 * 60 * 1000;
const NAME_LIMIT = 30;
const SUBTITLE_LIMIT = 30;
const KEYWORDS_LIMIT = 100;
const REVIEW_RESPONSE_LIMIT = 5970;

interface AppStoreInfoLocalizationResponse {
  data: {
    id: string;
    attributes?: {
      locale?: string;
      name?: string;
      subtitle?: string;
      keywords?: string;
      description?: string;
    };
  }[];
}

interface AppStoreInfoResponse {
  data: { id: string }[];
}

interface AppStoreReviewResponse {
  data?: {
    id: string;
    attributes: {
      rating: number;
      body: string;
      createdDate: string;
    };
  }[];
}

export class AppStoreCollector {
  private readonly keyId: string;
  private readonly issuerId: string;
  private readonly privateKey: string;
  private readonly baseUrl: string;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    options: AppStoreCollectorOptions,
    testHooks?: AppStoreCollectorTestHooks
  ) {
    if (!options.keyId || !options.issuerId || !options.privateKey) {
      throw new Error(
        "AppStoreCollector requires keyId, issuerId, and privateKey"
      );
    }
    this.keyId = options.keyId;
    this.issuerId = options.issuerId;
    this.privateKey = options.privateKey;
    this.baseUrl = testHooks?.baseUrl ?? DEFAULT_BASE_URL;
  }

  private async generateToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    const key = await importPKCS8(this.privateKey, "ES256");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.keyId, typ: "JWT" })
      .setIssuer(this.issuerId)
      .setIssuedAt()
      .setExpirationTime("20m")
      .setAudience("appstoreconnect-v1")
      .sign(key);

    this.cachedToken = token;
    this.tokenExpiresAt = Date.now() + TOKEN_LIFETIME_MS;
    return token;
  }

  private async request<T>(path: string, init?: RequestInitLike): Promise<T> {
    const token = await this.generateToken();
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    };

    const fetchInit: RequestInit = { headers };
    if (init?.method !== undefined) fetchInit.method = init.method;
    if (init?.body !== undefined) fetchInit.body = init.body;

    const response = await fetch(url, fetchInit);

    if (response.status === 429) {
      throw new RateLimitError("App Store API rate limited", {
        retryAfterSeconds: parseRetryAfter(
          response.headers.get("Retry-After")
        ),
      });
    }

    if (!response.ok) {
      const body = await response.text();
      throw new ExternalApiError(
        `App Store API ${String(response.status)}: ${body}`,
        { statusCode: response.status }
      );
    }

    return (await response.json()) as T;
  }

  async getAppInfo(appStoreId: string): Promise<AppStoreInfoResponse> {
    return this.request<AppStoreInfoResponse>(`/apps/${appStoreId}/appInfos`);
  }

  async getAppLocalizations(
    appStoreId: string,
    locale = "ko"
  ): Promise<AppStoreLocalization | null> {
    const infos = await this.getAppInfo(appStoreId);
    const infoId = infos.data[0]?.id;
    if (!infoId) return null;

    const localizations = await this.request<AppStoreInfoLocalizationResponse>(
      `/appInfos/${infoId}/appInfoLocalizations`
    );

    const match = localizations.data.find(
      (l) => l.attributes?.locale === locale
    );
    if (!match) return null;

    const attrs = match.attributes ?? {};
    return {
      id: match.id,
      locale: attrs.locale ?? locale,
      name: attrs.name ?? "",
      subtitle: attrs.subtitle ?? "",
      keywords: attrs.keywords ?? "",
      description: attrs.description ?? "",
    };
  }

  /**
   * Update app localization metadata (title, subtitle, keywords, description).
   * Requires App Store Connect API write permission and should only be
   * called from an approval-gated write path.
   */
  async updateLocalization(
    localizationId: string,
    update: AppStoreLocalizationUpdate
  ): Promise<unknown> {
    if (!localizationId) {
      throw new Error("updateLocalization: localizationId is required");
    }
    if (
      update.name === undefined &&
      update.subtitle === undefined &&
      update.keywords === undefined &&
      update.description === undefined
    ) {
      throw new Error(
        "updateLocalization: at least one field must be provided"
      );
    }
    if (update.name !== undefined && update.name.length > NAME_LIMIT) {
      throw new Error(
        `updateLocalization: name exceeds ${String(NAME_LIMIT)} char limit (${String(update.name.length)})`
      );
    }
    if (update.subtitle !== undefined && update.subtitle.length > SUBTITLE_LIMIT) {
      throw new Error(
        `updateLocalization: subtitle exceeds ${String(SUBTITLE_LIMIT)} char limit (${String(update.subtitle.length)})`
      );
    }
    if (update.keywords !== undefined && update.keywords.length > KEYWORDS_LIMIT) {
      throw new Error(
        `updateLocalization: keywords exceeds ${String(KEYWORDS_LIMIT)} char limit (${String(update.keywords.length)})`
      );
    }

    const attributes: Record<string, string> = {};
    if (update.name !== undefined) attributes.name = update.name;
    if (update.subtitle !== undefined) attributes.subtitle = update.subtitle;
    if (update.keywords !== undefined) attributes.keywords = update.keywords;
    if (update.description !== undefined) attributes.description = update.description;

    return this.request(`/appInfoLocalizations/${localizationId}`, {
      method: "PATCH",
      body: JSON.stringify({
        data: {
          type: "appInfoLocalizations",
          id: localizationId,
          attributes,
        },
      }),
    });
  }

  /**
   * Reply to a customer review. Approval-gated write path.
   */
  async replyToReview(reviewId: string, responseBody: string): Promise<unknown> {
    if (typeof responseBody !== "string" || responseBody.trim().length === 0) {
      throw new Error("replyToReview: responseBody must be a non-empty string");
    }
    if (responseBody.length > REVIEW_RESPONSE_LIMIT) {
      throw new Error(
        `replyToReview: responseBody exceeds App Store ${String(REVIEW_RESPONSE_LIMIT)} char limit (${String(responseBody.length)})`
      );
    }
    return this.request(`/customerReviewResponses`, {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "customerReviewResponses",
          attributes: { responseBody },
          relationships: {
            review: { data: { type: "customerReviews", id: reviewId } },
          },
        },
      }),
    });
  }

  async getReviews(
    appStoreId: string,
    limit = 50
  ): Promise<StoreReview[]> {
    const data = await this.request<AppStoreReviewResponse>(
      `/apps/${appStoreId}/customerReviews?limit=${String(limit)}&sort=-createdDate`
    );
    return (data.data ?? []).map((r) => ({
      reviewId: r.id,
      rating: r.attributes.rating,
      body: r.attributes.body,
      createdAt: r.attributes.createdDate,
    }));
  }
}
