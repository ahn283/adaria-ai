/**
 * Production skill registry.
 *
 * Creates a SkillRegistry with all 8 skills wired up. Skills that
 * require collector dependencies receive empty/optional deps — they
 * skip gracefully when the required collector is not configured.
 *
 * M7 prerequisite: replaces the M1 placeholder registry in the daemon.
 */

import { SkillRegistry } from "./index.js";
import { AsoSkill } from "./aso.js";
import { ReviewSkill } from "./review.js";
import { OnboardingSkill } from "./onboarding.js";
import { SeoBlogSkill } from "./seo-blog.js";
import { ShortFormSkill } from "./short-form.js";
import { SdkRequestSkill } from "./sdk-request.js";
import { ContentSkill } from "./content.js";
import { SocialPublishSkill } from "./social-publish.js";
import {
  EodinBlogPublisher,
  markdownToHtml,
  estimateReadTime,
} from "../collectors/eodin-blog.js";
import { FridgifyRecipesCollector } from "../collectors/fridgify-recipes.js";
import type { AdariaConfig } from "../config/schema.js";

/**
 * Build the production skill registry with all skills registered.
 *
 * Skills that require external collectors (ASO, Review, Onboarding)
 * are constructed with empty/optional deps. They throw at dispatch
 * time if the required collector is missing, which the orchestrator's
 * `timedRun` handles as a graceful skip.
 *
 * Skills that work without external deps (Content, SdkRequest) are
 * always functional.
 */
export function createProductionRegistry(
  config: AdariaConfig,
): SkillRegistry {
  const registry = new SkillRegistry();

  // Skills with optional/empty deps — skip if collectors not configured
  registry.register(
    new AsoSkill({
      asoMobile: {
        getKeywordRankings: () =>
          Promise.reject(new Error("ASO collector not configured")),
        getKeywordSuggestions: () =>
          Promise.reject(new Error("ASO collector not configured")),
        getCompetitorInfo: () =>
          Promise.reject(new Error("ASO collector not configured")),
      },
    }),
  );

  registry.register(new ReviewSkill({}));

  registry.register(
    new OnboardingSkill({
      sdkCollector: {
        getSummary: () =>
          Promise.reject(new Error("SDK collector not configured")),
        getFunnel: () =>
          Promise.reject(new Error("SDK collector not configured")),
        getCohort: () =>
          Promise.reject(new Error("SDK collector not configured")),
      },
    }),
  );

  const eodinGrowthToken = config.collectors.eodinGrowth?.token;
  registry.register(
    new SeoBlogSkill({
      ...(eodinGrowthToken
        ? {
            blogPublisher: new EodinBlogPublisher({ token: eodinGrowthToken }),
            markdownToHtml,
            estimateReadTime,
          }
        : {}),
      recipesCollector: new FridgifyRecipesCollector(),
    }),
  );
  registry.register(new ShortFormSkill({}));

  // Skills without external deps
  registry.register(new SdkRequestSkill());
  registry.register(new ContentSkill());

  // Social publish skill
  registry.register(
    new SocialPublishSkill({
      socialConfigs: {
        twitter: config.social.twitter,
        facebook: config.social.facebook,
        threads: config.social.threads,
        tiktok: config.social.tiktok,
        youtube: config.social.youtube,
        linkedin: config.social.linkedin,
      },
    }),
  );

  return registry;
}
