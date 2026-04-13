/**
 * SEO Blog Skill — generates SEO-optimized blog posts and publishes
 * to eodin.app/blogs. Includes Fridgify recipe integration with
 * prompt injection sanitization.
 *
 * Ported from growth-agent `src/agents/seo-blog-agent.js`.
 */

import type { Skill } from "./index.js";
import { parseAppNameFromCommand } from "./index.js";
import type {
  ExecutableSkill,
  SkillContext,
  SkillResult,
  ApprovalItem,
} from "../types/skill.js";
import type { AppConfig } from "../config/apps-schema.js";
import type { BlogCategory, BlogPostDraft, FridgifyCascadeResult, FridgifyRecipe } from "../types/collectors.js";
import type { CascadeOptions } from "../collectors/fridgify-recipes.js";
import { insertBlogPost } from "../db/queries.js";
import { preparePrompt } from "../prompts/loader.js";
import { warn as logWarn, info as logInfo } from "../utils/logger.js";

const MAX_FIELD_LEN = 500;
const MAX_INGREDIENT_LEN = 120;
const VALID_CATEGORIES: ReadonlySet<string> = new Set(["Philosophy", "Product", "Technology", "Insights", "Ethics", "Design"]);
const MAX_INSTRUCTION_LEN = 400;
const NUTRITION_SENTINEL = { calories: 350, fat: 12, protein: 20, carbohydrates: 40 };

export interface SeoBlogSkillDeps {
  blogPublisher?: {
    listSlugs: () => Promise<string[]>;
    create: (post: BlogPostDraft) => Promise<unknown>;
    publish: (slug: string) => Promise<unknown>;
  };
  recipesCollector?: {
    getPopularWithCascade: (opts?: CascadeOptions) => Promise<FridgifyCascadeResult>;
  };
  markdownToHtml?: (md: string) => string;
  estimateReadTime?: (text: string) => string;
}

export class SeoBlogSkill implements Skill, ExecutableSkill {
  readonly name = "seo-blog";
  readonly commands = ["blog"] as const;

  private readonly deps: SeoBlogSkillDeps;

  constructor(deps: SeoBlogSkillDeps) {
    this.deps = deps;
  }

  async dispatch(ctx: SkillContext, text: string): Promise<SkillResult> {
    const appName = parseAppNameFromCommand(text);
    const app = appName
      ? ctx.apps.find((a) => a.id.toLowerCase() === appName)
      : ctx.apps[0];

    if (!app) {
      return {
        summary: appName ? `❌ App "${appName}" not found.` : "❌ No apps configured.",
        alerts: [],
        approvals: [],
      };
    }

    return this.analyzeSeo(ctx, app);
  }

  async analyzeSeo(ctx: SkillContext, app: AppConfig): Promise<SkillResult> {
    const approvals: ApprovalItem[] = [];

    // 1. Get existing slugs
    let existingSlugs: string[] = [];
    if (this.deps.blogPublisher) {
      try {
        existingSlugs = await this.deps.blogPublisher.listSlugs();
      } catch (err) {
        logWarn(`[seo-blog] Failed to list slugs: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 2. Fridgify recipe branch
    let recipes: FridgifyRecipe[] = [];
    let recipesPeriod: string | null = null;
    let useRecipePrompt = false;

    if (app.features.fridgifyRecipes && this.deps.recipesCollector) {
      try {
        const cascade = await this.deps.recipesCollector.getPopularWithCascade({
          metric: "combined", limit: 10, minResults: 5,
        });
        if (cascade.satisfied) {
          recipes = cascade.rows;
          recipesPeriod = cascade.period;
          useRecipePrompt = true;
        } else {
          logInfo(`[seo-blog] Fridgify cascade unsatisfied (period=${cascade.period}) — using generic prompt`);
        }
      } catch (err) {
        logWarn(`[seo-blog] Fridgify recipes fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 3. Build prompt
    const promptName = useRecipePrompt ? "seo-blog-fridgify-recipe" : "seo-blog";
    const baseVars: Record<string, string> = {
      appName: app.name,
      appDescription: "",
      primaryKeywords: app.primaryKeywords.join(", "),
      asoInsights: "Nothing notable",
      reviewInsights: "Nothing notable",
      seoKeywords: "No data",
      blogPerformance: "No data (first week)",
      trafficSources: "No data",
      existingSlugs: existingSlugs.length > 0 ? existingSlugs.join(", ") : "none",
    };
    if (useRecipePrompt) {
      baseVars["period"] = recipesPeriod ?? "";
      baseVars["recipeCount"] = String(recipes.length);
      baseVars["recipesContext"] = buildRecipesContext(recipes);
    }
    const prompt = preparePrompt(promptName, baseVars);

    // 4. Generate posts via Claude
    interface PostData {
      slug?: string;
      title?: string;
      description?: string;
      category?: string;
      body?: string;
      sourceRecipeIds?: string[];
    }
    let posts: PostData[] = [];
    try {
      const raw = await ctx.runClaude(prompt);
      const result = JSON.parse(raw) as { posts?: PostData[] };
      posts = result.posts ?? [];
    } catch {
      // Claude error is non-fatal
    }

    // 5. Validate and prepare posts
    const inputRecipeIds = new Set(
      recipes.map((r) => r.id).filter((id): id is string => typeof id === "string"),
    );

    const validPosts: Array<PostData & { slug: string; title: string }> = [];
    for (const post of posts) {
      if (!post.slug || post.slug.length < 3 || existingSlugs.includes(post.slug)) continue;
      if (!post.title) continue;

      if (Array.isArray(post.sourceRecipeIds)) {
        post.sourceRecipeIds = post.sourceRecipeIds.filter(
          (id) => typeof id === "string" && inputRecipeIds.has(id),
        );
      }

      validPosts.push(post as PostData & { slug: string; title: string });
    }

    // 6. Create approval items for each post
    for (const post of validPosts) {
      approvals.push({
        id: `blog-publish-${post.slug}`,
        description: `Publish blog post: "${post.title}"`,
        agent: "seo-blog",
        payload: post,
      });
    }

    // 7. Summary
    const summary = this.buildSummary(app, validPosts, recipesPeriod);

    return { summary, alerts: [], approvals };
  }

  /**
   * ExecutableSkill entry point — called by core.ts on approval.
   */
  async executePost(ctx: SkillContext, payload: unknown): Promise<void> {
    const raw = Array.isArray(payload) ? payload : [payload];
    const posts = raw.filter(
      (p): p is { slug: string; title: string; description?: string; category?: string; body?: string; sourceRecipeIds?: string[] } =>
        typeof p === "object" && p !== null &&
        typeof (p as Record<string, unknown>)["slug"] === "string" &&
        typeof (p as Record<string, unknown>)["title"] === "string",
    );
    if (posts.length === 0) {
      logWarn("[seo-blog] executePost: no valid posts in payload");
      return;
    }
    const results = await this.publishApprovedPosts(ctx, posts);
    const failed = results.filter((r) => r.status === "failed");
    if (failed.length > 0) {
      throw new Error(`Blog publish failed for: ${failed.map((f) => f.slug).join(", ")}`);
    }
  }

  /**
   * Publish approved posts. Called after approval in orchestrator (M6).
   */
  async publishApprovedPosts(
    ctx: SkillContext,
    posts: Array<{ slug: string; title: string; description?: string; category?: string; body?: string; sourceRecipeIds?: string[] }>,
  ): Promise<Array<{ slug: string; status: string }>> {
    if (!this.deps.blogPublisher || !this.deps.markdownToHtml || !this.deps.estimateReadTime) {
      return posts.map((p) => ({ slug: p.slug, status: "skipped" }));
    }

    if (process.env["ADARIA_DRY_RUN"] === "1") {
      for (const post of posts) {
        logInfo(`[seo-blog] DRY_RUN: would publish "${post.slug}"`);
      }
      return posts.map((p) => ({ slug: p.slug, status: "dry-run" }));
    }

    const published: Array<{ slug: string; status: string }> = [];
    for (const post of posts) {
      try {
        const htmlContent = this.deps.markdownToHtml(post.body ?? "");
        const readTime = this.deps.estimateReadTime(post.body ?? "");
        await this.deps.blogPublisher.create({
          slug: post.slug,
          title: post.title,
          description: post.description ?? "",
          category: (VALID_CATEGORIES.has(post.category ?? "") ? post.category : "Insights") as BlogCategory,
          content: htmlContent,
          readTime,
        });
        await this.deps.blogPublisher.publish(post.slug);

        const keywordsPayload: Record<string, unknown> = {};
        if (post.sourceRecipeIds?.length) {
          keywordsPayload["_sourceRecipeIds"] = post.sourceRecipeIds;
        }
        insertBlogPost(ctx.db, {
          app_id: "eodin",
          title: post.title,
          slug: post.slug,
          keywords: JSON.stringify(keywordsPayload),
          published_at: new Date().toISOString(),
        });

        published.push({ slug: post.slug, status: "published" });
        logInfo(`[seo-blog] Published: ${post.slug}`);
      } catch (err) {
        published.push({ slug: post.slug, status: "failed" });
        logWarn(`[seo-blog] Publish failed for ${post.slug}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return published;
  }

  private buildSummary(
    app: AppConfig,
    posts: Array<{ title: string; sourceRecipeIds?: string[] }>,
    recipesPeriod: string | null,
  ): string {
    const lines = [`*📝 SEO Blog — ${app.name}*`];

    if (recipesPeriod) {
      lines.push(`• Based on trending Fridgify recipes (${recipesPeriod})`);
    }

    if (posts.length > 0) {
      for (const post of posts) {
        const sourceTag = post.sourceRecipeIds?.length
          ? ` [${String(post.sourceRecipeIds.length)} recipe${post.sourceRecipeIds.length > 1 ? "s" : ""}]`
          : "";
        lines.push(`• "${post.title}"${sourceTag}`);
      }
      lines.push(`• ${String(posts.length)} posts ready`);
    } else {
      lines.push("• No posts generated this week");
    }

    return lines.join("\n");
  }
}

// ── Recipe sanitization (prompt injection defense) ────────────

function isNutritionSentinel(n: unknown): boolean {
  if (!n || typeof n !== "object") return false;
  const obj = n as Record<string, unknown>;
  return (
    obj["calories"] === NUTRITION_SENTINEL.calories &&
    obj["fat"] === NUTRITION_SENTINEL.fat &&
    obj["protein"] === NUTRITION_SENTINEL.protein &&
    obj["carbohydrates"] === NUTRITION_SENTINEL.carbohydrates
  );
}

function sanitizeUserText(value: unknown, maxLen = MAX_FIELD_LEN): string | null {
  if (value == null) return null;
  const str = (typeof value === "string" ? value : JSON.stringify(value))
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    .replace(/\bignore (?:all )?previous (?:instructions|prompts?)\b/gi, "[filtered]")
    .replace(/\b(?:system|assistant|user)\s*:/gi, "[filtered]:")
    .replace(/\s+/g, " ")
    .trim();
  return str.length > maxLen ? `${str.slice(0, maxLen)}…` : str;
}

function sanitizeStringList(list: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, maxItems)
    .map((item) => sanitizeUserText(item, maxLen))
    .filter((s): s is string => s != null && s.length > 0);
}

function buildRecipesContext(recipes: FridgifyRecipe[]): string {
  const compact = recipes.map((r, i) => {
    const rec = r as Record<string, unknown>;
    const tasteProfile = rec["tasteProfile"];
    const taste = tasteProfile && typeof tasteProfile === "object"
      ? {
          sweet: (tasteProfile as Record<string, unknown>)["sweet"],
          salty: (tasteProfile as Record<string, unknown>)["salty"],
          spicy: (tasteProfile as Record<string, unknown>)["spicy"],
          umami: (tasteProfile as Record<string, unknown>)["umami"],
          sour: (tasteProfile as Record<string, unknown>)["sour"],
          texture: sanitizeUserText((tasteProfile as Record<string, unknown>)["texture"], 120),
          aroma: sanitizeUserText((tasteProfile as Record<string, unknown>)["aroma"], 120),
          beverage_pairing: sanitizeUserText((tasteProfile as Record<string, unknown>)["beverage_pairing"], 200),
          side_dishes: sanitizeUserText((tasteProfile as Record<string, unknown>)["side_dishes"], 200),
        }
      : null;

    const cuisineData = rec["cuisineData"] as Record<string, unknown> | undefined;
    return {
      rank: i + 1,
      id: typeof r.id === "string" ? r.id : null,
      name: sanitizeUserText(r.name, 200),
      cuisine: sanitizeUserText(rec["cuisine"] ?? cuisineData?.["name"], 80),
      cuisineTags: Array.isArray(rec["cuisineTags"])
        ? (rec["cuisineTags"] as unknown[]).slice(0, 10).map((t) => sanitizeUserText(t, 60))
        : [],
      difficulty: sanitizeUserText(r.difficulty, 40),
      estimatedTime: typeof r.estimatedTime === "number" ? r.estimatedTime : null,
      estimatedCost: typeof rec["estimatedCost"] === "number" ? rec["estimatedCost"] : null,
      servings: typeof r.servings === "number" ? r.servings : null,
      ingredients: sanitizeStringList(r.ingredients, 15, MAX_INGREDIENT_LEN),
      instructions: sanitizeStringList(r.instructions, 12, MAX_INSTRUCTION_LEN),
      aiDescription: sanitizeUserText(rec["aiDescription"], MAX_FIELD_LEN),
      tasteProfile: taste,
      nutritionInfo: isNutritionSentinel(r.nutritionInfo) ? null : (r.nutritionInfo ?? null),
      imageUrl: typeof rec["imageUrl"] === "string" ? rec["imageUrl"] : null,
      periodScore: typeof rec["periodScore"] === "number" ? rec["periodScore"] : null,
      stats: {
        upvotes: (rec["stats"] as Record<string, unknown> | undefined)?.["upvotes"] ?? 0,
        comments: (rec["stats"] as Record<string, unknown> | undefined)?.["comments"] ?? 0,
        saves: (rec["stats"] as Record<string, unknown> | undefined)?.["saves"] ?? 0,
      },
    };
  });
  return JSON.stringify(compact, null, 2);
}
