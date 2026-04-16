/**
 * Shared social media client interface.
 *
 * Every platform client (twitter, facebook, threads, tiktok, youtube,
 * linkedin) implements this interface. The SocialPublishSkill dispatches
 * through it without knowing which platform it's talking to.
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

  /** Post content to the platform. */
  post(content: SocialPostContent): Promise<SocialPostResult>;

  /** Validate content against platform-specific rules. */
  validateContent(text: string): ValidationResult;

  /** Delete a previously posted item by its platform-specific ID. */
  deletePost(postId: string): Promise<boolean>;
}
