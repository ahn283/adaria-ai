/**
 * Social client factory.
 *
 * Creates the appropriate SocialClient for a given platform + config.
 */

import type { SocialClient, SocialPlatform } from "./base.js";
import { TwitterClient, type TwitterConfig } from "./twitter.js";
import { FacebookClient, type FacebookConfig } from "./facebook.js";
import { ThreadsClient, type ThreadsConfig } from "./threads.js";
import { TikTokClient, type TikTokConfig } from "./tiktok.js";
import { YouTubeClient, type YouTubeConfig } from "./youtube.js";
import { LinkedInClient, type LinkedInConfig } from "./linkedin.js";

export type SocialConfigs = {
  twitter?: TwitterConfig | undefined;
  facebook?: FacebookConfig | undefined;
  threads?: ThreadsConfig | undefined;
  tiktok?: TikTokConfig | undefined;
  youtube?: YouTubeConfig | undefined;
  linkedin?: LinkedInConfig | undefined;
};

/**
 * Create a social client for the given platform. Returns null if the
 * platform config is missing (credentials not configured).
 */
export function createSocialClient(
  platform: SocialPlatform,
  configs: SocialConfigs,
): SocialClient | null {
  switch (platform) {
    case "twitter":
      return configs.twitter ? new TwitterClient(configs.twitter) : null;
    case "facebook":
      return configs.facebook ? new FacebookClient(configs.facebook) : null;
    case "threads":
      return configs.threads ? new ThreadsClient(configs.threads) : null;
    case "tiktok":
      return configs.tiktok ? new TikTokClient(configs.tiktok) : null;
    case "youtube":
      return configs.youtube ? new YouTubeClient(configs.youtube) : null;
    case "linkedin":
      return configs.linkedin ? new LinkedInClient(configs.linkedin) : null;
  }
}
