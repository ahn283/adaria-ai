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

// ---------------------------------------------------------------------------
// Eodin SDK analytics
// ---------------------------------------------------------------------------

/**
 * Daily/weekly/monthly aggregate row from the Eodin SDK analytics API.
 *
 * Wire field names are upstream-native snake_case (the Eodin API returns
 * `core_actions`, `paywall_views`) — see file header for the camelCase
 * rule. We keep the snake_case here because these map 1:1 to column names
 * in the `sdk_events` table that M3 will provision; consumers pay the cost
 * of one inconsistency at the upstream boundary instead of a translation
 * layer per skill.
 */
export interface EodinSummaryRow {
  date: string;
  installs: number;
  dau: number;
  sessions: number;
  core_actions: number;
  paywall_views: number;
  subscriptions: number;
  revenue: number;
}

export interface EodinFunnelStep {
  step: string;
  count: number;
  rate: number;
  drop_rate: number;
}

export interface EodinFunnelData {
  funnel: EodinFunnelStep[];
  overall_conversion: number;
}

export interface EodinCohort {
  cohort_date: string;
  cohort_size: number;
  /** Always normalized to fractions in [0, 1]. */
  retention: number[];
}

// ---------------------------------------------------------------------------
// ASOMobile keyword ranking
// ---------------------------------------------------------------------------

export interface AsoKeywordRanking {
  keyword: string;
  /** Current rank (1 = best), or null if unranked in the top N. */
  rank: number | null;
  searchVolume: number;
  /** 0–100 scale competition score, or null if unknown. */
  competition: number | null;
}

export interface AsoKeywordSuggestion {
  keyword: string;
  searchVolume: number;
  competition: number | null;
}

// ---------------------------------------------------------------------------
// Eodin Blog / SEO / Analytics
// ---------------------------------------------------------------------------

export type BlogCategory =
  | "Philosophy"
  | "Product"
  | "Technology"
  | "Insights"
  | "Ethics"
  | "Design";

export type BlogStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

export interface BlogPostDraft {
  slug: string;
  title: string;
  description: string;
  category: BlogCategory;
  content: string;
  thumbnail?: string;
  readTime?: string;
}

export interface BlogPostUpdate {
  title?: string;
  description?: string;
  category?: BlogCategory;
  content?: string;
  thumbnail?: string;
  readTime?: string;
  status?: BlogStatus;
}

export interface BlogListOptions {
  status?: BlogStatus;
  category?: BlogCategory;
  page?: number;
  limit?: number;
}

export interface BlogListResponse {
  data: { slug: string; title?: string; status?: BlogStatus }[];
  pagination?: { page: number; limit: number; total?: number };
}

// ---------------------------------------------------------------------------
// Fridgify recipes
// ---------------------------------------------------------------------------

export type FridgifyPeriod = "week" | "month" | "quarter" | "year";
export type FridgifyPopularMetric = "likes" | "comments" | "combined";

/**
 * Minimal shape for a Fridgify popular recipe. The upstream API returns a
 * richer object (ingredients, instructions, `aiDescription`, `tasteProfile`,
 * `imageUrl`, `stats`, `periodScore`, `cuisineTagsData`); we keep the type
 * loose with an index signature so consumers can access fields that the
 * M3 DB schema doesn't persist.
 *
 * Note that `aiDescription` is upstream-generated text that an M4 `SeoBlogSkill`
 * will fold into Claude prompts — the same prompt-guard requirement as
 * `AsoCompetitorInfo.description` applies there.
 */
export interface FridgifyRecipe {
  id: string;
  name?: string;
  periodScore?: number;
  [key: string]: unknown;
}

export interface FridgifyCascadeResult {
  period: FridgifyPeriod;
  rows: FridgifyRecipe[];
  /** True only if `rows.length >= minResults` for the chosen window. */
  satisfied: boolean;
}

// ---------------------------------------------------------------------------
// YouTube Shorts performance
// ---------------------------------------------------------------------------

export interface YouTubeVideoStats {
  videoId: string;
  title: string;
  publishedAt: string | null;
  views: number;
  likes: number;
  comments: number;
  /** ISO 8601 duration (`PT30S`, `PT1M10S`, …), or null if missing. */
  duration: string | null;
}

export interface AsoCompetitorInfo {
  title: string;
  subtitle: string;
  /**
   * Attacker-controllable: sourced from a third-party App Store / Google Play
   * listing. Skills in M4+ that forward this field into a Claude prompt MUST
   * route it through `src/security/prompt-guard.ts` first — indirect prompt
   * injection via competitor metadata is a realistic attack path.
   */
  description: string;
  keywords: string[];
}
