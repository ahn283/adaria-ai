/**
 * Shared social media client interface.
 *
 * Every platform client (twitter, facebook, threads, tiktok, youtube,
 * linkedin) implements this interface. The SocialPublishSkill dispatches
 * through it without knowing which platform it's talking to.
 *
 * All `post()` implementations MUST check `ADARIA_DRY_RUN` before calling
 * the API. When set, they log the full request payload and return a
 * synthetic result with `dryRun: true`.
 */

export type SocialPlatform =
  | "twitter"
  | "facebook"
  | "threads"
  | "tiktok"
  | "youtube"
  | "linkedin";

export interface SocialPostContent {
  text: string;
  hashtags?: string[];
  imageUrl?: string;
  link?: string;
}

export interface SocialPostResult {
  success: boolean;
  platform: SocialPlatform;
  postId?: string | undefined;
  postUrl?: string | undefined;
  error?: string | undefined;
  dryRun?: boolean | undefined;
  postedAt?: string | undefined;
}

export interface ValidationResult {
  valid: boolean;
  characterCount: number;
  issues: string[];
  suggestions: string[];
}

export interface SocialClient {
  readonly platform: SocialPlatform;

  /** Post content to the platform. Checks ADARIA_DRY_RUN. */
  post(content: SocialPostContent): Promise<SocialPostResult>;

  /** Validate content against platform-specific rules. */
  validateContent(text: string): ValidationResult;

  /** Delete a previously posted item by its platform-specific ID. */
  deletePost(postId: string): Promise<boolean>;
}

/** Check whether dry-run mode is active. */
export function isDryRun(): boolean {
  return process.env["ADARIA_DRY_RUN"] === "1";
}

/** Build a dry-run result for any platform. */
export function dryRunResult(
  platform: SocialPlatform,
  _content: SocialPostContent,
): SocialPostResult {
  return {
    success: true,
    platform,
    postId: `dry-run-${Date.now()}`,
    dryRun: true,
    postedAt: new Date().toISOString(),
  };
}
