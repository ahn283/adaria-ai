/**
 * Shared types for data collectors.
 *
 * These interfaces are the "wire format" between collectors and skills: once
 * a collector returns one of these, downstream code (skills, DB layer) can
 * rely on shape stability. Platform-specific response shapes (App Store
 * Connect JSON:API, Google Play Developer API, etc.) stay encapsulated
 * inside the respective collector.
 *
 * ## Wire shape deltas from growth-agent (M2 porting notes)
 *
 * adaria-ai collectors intentionally diverge from growth-agent's JS wire
 * format in three ways. Skills ported in M4+ must read the new names:
 *
 * 1. **camelCase everywhere.** growth-agent returned `{review_id, created_at}`;
 *    adaria-ai returns `{reviewId, createdAt}`. The DB layer (M3) owns the
 *    camelCase → snake_case mapping at insert time so that SQLite column
 *    names stay conventional.
 * 2. **Flattened `AppStoreLocalization`.** growth-agent returned the raw
 *    App Store Connect JSON:API object (`{id, attributes: {name, ...}}`);
 *    adaria-ai flattens it so consumers read `loc.name` directly. M4 ASO
 *    prompt builders should not do `loc.attributes.name`.
 * 3. **`RateLimitError.retryAfterSeconds`.** growth-agent's field was
 *    `retryAfter`; renamed for clarity and moved from
 *    `src/collectors/errors.js` to `src/utils/errors.ts`.
 */

/**
 * Unified customer review shape across App Store and Google Play.
 *
 * Note the camelCase field names — see file header for rationale.
 */
export interface StoreReview {
  reviewId: string;
  rating: number;
  body: string;
  /** ISO-8601 timestamp, or null when the upstream API omits it. */
  createdAt: string | null;
}

/**
 * App Store Connect localized app metadata (title/subtitle/keywords/description).
 * Used for ASO analysis and (approval-gated) metadata updates.
 *
 * This is a **flattened** view of the underlying JSON:API `appInfoLocalization`
 * resource. See the wire shape delta note in the file header.
 */
export interface AppStoreLocalization {
  id: string;
  locale: string;
  name: string;
  subtitle: string;
  keywords: string;
  description: string;
}

/**
 * Arguments for an App Store Connect metadata update. All fields optional —
 * only provided fields are patched.
 */
export interface AppStoreLocalizationUpdate {
  name?: string;
  subtitle?: string;
  keywords?: string;
  description?: string;
}
