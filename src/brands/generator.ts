import fs from "node:fs/promises";
import path from "node:path";

import yaml from "js-yaml";
import { z } from "zod";

import { BUNDLED_PROMPTS_DIR, brandsDir } from "../utils/paths.js";
import { ConfigError } from "../utils/errors.js";
import { info as logInfo } from "../utils/logger.js";
import { parseJsonResponse } from "../utils/parse-json.js";
import { sanitizeExternalText } from "../security/prompt-guard.js";
import {
  brandIdentitySchema,
  brandVoiceSchema,
  brandAudienceSchema,
  brandCompetitorsSchema,
  type BrandProfile,
  type BrandServiceType,
} from "../types/brand.js";
import { fetchWebData, type WebFetcherDeps } from "./fetchers/web.js";
import {
  fetchPackageData,
  type PackageFetcherDeps,
} from "./fetchers/package.js";

/**
 * Brand profile generator (M6.7 Phase 2).
 *
 * Dispatches on service type, sanitises all external text, calls Claude
 * with the shared `brand-generate.md` prompt, validates the JSON response
 * against the portion of the brand schema the model owns, then serialises
 * to `brand.yaml`. Caller (BrandSkill) controls cleanup on cancel.
 */

const claudeOutputSchema = z.object({
  identity: brandIdentitySchema.partial().default({}),
  voice: brandVoiceSchema.partial().default({}),
  audience: brandAudienceSchema.partial().default({}),
  competitors: brandCompetitorsSchema.partial().default({}),
});

export interface BrandGenerateRequest {
  serviceId: string;
  serviceType: BrandServiceType;
  /** For `app`: App Store numeric id and/or Play Store package name. */
  appStoreId?: string;
  playStorePackage?: string;
  locale?: string;
  /** For `web`: landing page URL. */
  websiteUrl?: string;
  /** For `package`: npm package name + optional GitHub `owner/repo`. */
  npmName?: string;
  githubRepo?: string;
}

/**
 * Abstract fetchers the generator calls for `serviceType: "app"`.
 * BrandSkill (Phase 4) wires real collectors through thin adapters so
 * this module stays decoupled from collector method signatures.
 */
export interface AppStoreBrandFetcher {
  fetch(
    appStoreId: string,
    locale: string
  ): Promise<{ name: string; subtitle: string; description: string } | null>;
}

export interface PlayStoreBrandFetcher {
  fetch(
    packageName: string,
    locale: string
  ): Promise<{
    title: string;
    shortDescription: string;
    fullDescription: string;
  } | null>;
}

export interface AsoMobileBrandFetcher {
  fetch(
    appStoreId: string
  ): Promise<{ category: string; keywords: string[] } | null>;
}

export interface BrandGeneratorDeps {
  runClaude: (prompt: string) => Promise<string>;
  appStore?: AppStoreBrandFetcher;
  playStore?: PlayStoreBrandFetcher;
  asoMobile?: AsoMobileBrandFetcher;
  web?: WebFetcherDeps;
  packageFetcher?: PackageFetcherDeps;
  /** Test hook — overrides `brand-generate.md` location. */
  promptsDir?: string;
  /** Test hook — clock for `_meta.generatedAt`. */
  now?: () => Date;
}

export interface BrandGenerateResult {
  profile: BrandProfile;
  yamlPath: string;
}

async function loadPromptTemplate(dir: string): Promise<string> {
  const file = path.join(dir, "brand-generate.md");
  return fs.readFile(file, "utf-8");
}

function renderPrompt(
  template: string,
  vars: Record<string, string>
): string {
  return template
    .replace(/\{\{serviceType\}\}/g, vars["serviceType"] ?? "")
    .replace(/\{\{serviceId\}\}/g, vars["serviceId"] ?? "")
    .replace(/\{\{inputBlock\}\}/g, vars["inputBlock"] ?? "");
}

function buildAppInput(
  req: BrandGenerateRequest,
  parts: {
    appStore?: { name: string; subtitle: string; description: string } | null;
    playStore?: {
      title: string;
      shortDescription: string;
      fullDescription: string;
    } | null;
    asoMobile?: { category: string; keywords: string[] } | null;
  }
): string {
  const lines: string[] = [`Type: app`, `Service id: ${req.serviceId}`];
  if (parts.appStore) {
    lines.push(
      `App Store name: ${sanitizeExternalText(parts.appStore.name, 200)}`,
      `App Store subtitle: ${sanitizeExternalText(parts.appStore.subtitle, 200)}`,
      `App Store description: ${sanitizeExternalText(parts.appStore.description, 2000)}`
    );
  }
  if (parts.playStore) {
    lines.push(
      `Play Store title: ${sanitizeExternalText(parts.playStore.title, 200)}`,
      `Play Store short description: ${sanitizeExternalText(parts.playStore.shortDescription, 200)}`,
      `Play Store full description: ${sanitizeExternalText(parts.playStore.fullDescription, 2000)}`
    );
  }
  if (parts.asoMobile) {
    lines.push(
      `Category: ${sanitizeExternalText(parts.asoMobile.category, 100)}`,
      `ASO keywords: ${parts.asoMobile.keywords.slice(0, 20).map((k) => sanitizeExternalText(k, 50)).join(", ")}`
    );
  }
  return lines.join("\n");
}

async function collectAppInput(
  req: BrandGenerateRequest,
  deps: BrandGeneratorDeps
): Promise<{ text: string; sources: string[] }> {
  const sources: string[] = [];
  const parts: Parameters<typeof buildAppInput>[1] = {};

  const locale = req.locale ?? "ko";

  if (req.appStoreId && deps.appStore) {
    const loc = await deps.appStore.fetch(req.appStoreId, locale);
    if (loc) {
      parts.appStore = loc;
      sources.push("appstore");
    }
  }

  if (req.playStorePackage && deps.playStore) {
    const listing = await deps.playStore.fetch(req.playStorePackage, locale);
    if (listing) {
      parts.playStore = listing;
      sources.push("playstore");
    }
  }

  if (req.appStoreId && deps.asoMobile) {
    const info = await deps.asoMobile.fetch(req.appStoreId);
    if (info) {
      parts.asoMobile = info;
      sources.push("asomobile");
    }
  }

  if (sources.length === 0) {
    throw new ConfigError(
      `No app data available for ${req.serviceId} — App Store, Play Store, and ASOMobile all returned nothing.`,
      {
        userMessage:
          "앱 데이터 수집에 실패했어. appStoreId / playStorePackage / 자격증명을 확인하고 다시 시도해줘.",
      }
    );
  }
  return { text: buildAppInput(req, parts), sources };
}

async function collectWebInput(
  req: BrandGenerateRequest,
  deps: BrandGeneratorDeps
): Promise<{ text: string; sources: string[] }> {
  if (!req.websiteUrl) {
    throw new ConfigError("websiteUrl is required for serviceType=web");
  }
  const data = await fetchWebData(req.websiteUrl, deps.web);
  const lines = [
    `Type: web`,
    `URL: ${data.url}`,
    `Title: ${sanitizeExternalText(data.title, 300)}`,
    `Meta description: ${sanitizeExternalText(data.description, 500)}`,
    `OG title: ${sanitizeExternalText(data.ogTitle, 300)}`,
    `OG description: ${sanitizeExternalText(data.ogDescription, 500)}`,
    `Theme color: ${sanitizeExternalText(data.themeColor, 40)}`,
    `Primary color (CSS): ${sanitizeExternalText(data.primaryColor, 40)}`,
    `Body text excerpt: ${sanitizeExternalText(data.bodyText, 4000)}`,
  ];
  return { text: lines.join("\n"), sources: ["web"] };
}

async function collectPackageInput(
  req: BrandGenerateRequest,
  deps: BrandGeneratorDeps
): Promise<{ text: string; sources: string[] }> {
  if (!req.npmName) {
    throw new ConfigError("npmName is required for serviceType=package");
  }
  const data = await fetchPackageData(
    req.npmName,
    req.githubRepo,
    deps.packageFetcher
  );
  const lines = [
    `Type: package`,
    `npm name: ${data.name}`,
    `Version: ${data.version}`,
    `Description: ${sanitizeExternalText(data.description, 500)}`,
    `Homepage: ${sanitizeExternalText(data.homepage, 300)}`,
    `Repository: ${sanitizeExternalText(data.repositoryUrl, 300)}`,
    `Keywords: ${data.keywords.slice(0, 20).map((k) => sanitizeExternalText(k, 40)).join(", ")}`,
    `README: ${sanitizeExternalText(data.readme, 8000)}`,
  ];
  const sources = ["npm"];
  if (data.readmeSource === "github") sources.push("github");
  return { text: lines.join("\n"), sources };
}

function buildIdentifiers(req: BrandGenerateRequest): Record<string, string> {
  const out: Record<string, string> = {};
  if (req.appStoreId) out["appstoreId"] = req.appStoreId;
  if (req.playStorePackage) out["playstorePackage"] = req.playStorePackage;
  if (req.websiteUrl) out["websiteUrl"] = req.websiteUrl;
  if (req.npmName) out["npmName"] = req.npmName;
  if (req.githubRepo) out["githubRepo"] = req.githubRepo;
  return out;
}

/**
 * Generate (or regenerate) a brand profile for a service and write it
 * to `$ADARIA_HOME/brands/{serviceId}/brand.yaml`. Returns the profile
 * and the resolved file path. BrandSkill's PREVIEW step is the
 * user-facing gate before the file becomes authoritative; if the user
 * cancels, BrandSkill removes the orphan via `cleanupOrphanedYaml`.
 */
export async function generateBrandProfile(
  req: BrandGenerateRequest,
  deps: BrandGeneratorDeps
): Promise<BrandGenerateResult> {
  const now = deps.now ?? (() => new Date());
  const promptsDir = deps.promptsDir ?? BUNDLED_PROMPTS_DIR;

  let collected: { text: string; sources: string[] };
  switch (req.serviceType) {
    case "app":
      collected = await collectAppInput(req, deps);
      break;
    case "web":
      collected = await collectWebInput(req, deps);
      break;
    case "package":
      collected = await collectPackageInput(req, deps);
      break;
  }

  const template = await loadPromptTemplate(promptsDir);
  const prompt = renderPrompt(template, {
    serviceType: req.serviceType,
    serviceId: req.serviceId,
    inputBlock: collected.text,
  });

  const response = await deps.runClaude(prompt);
  const parsed = parseJsonResponse(response);
  const validated = claudeOutputSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigError(
      `Claude returned an invalid brand profile for ${req.serviceId}:\n${issues}`,
      {
        userMessage:
          "브랜드 분석 결과를 파싱하지 못했어. 다시 시도해줘.",
      }
    );
  }

  const analysis = validated.data;
  const profile: BrandProfile = {
    _meta: {
      serviceType: req.serviceType,
      generatedAt: now().toISOString(),
      sources: collected.sources,
      identifiers: buildIdentifiers(req),
    },
    identity: {
      tagline: analysis.identity.tagline ?? "",
      mission: analysis.identity.mission ?? "",
      positioning: analysis.identity.positioning ?? "",
      category: analysis.identity.category ?? "",
    },
    voice: {
      tone: analysis.voice.tone ?? "",
      personality: analysis.voice.personality ?? "",
      do: analysis.voice.do ?? [],
      dont: analysis.voice.dont ?? [],
    },
    audience: {
      primary: analysis.audience.primary ?? "",
      painPoints: analysis.audience.painPoints ?? [],
      motivations: analysis.audience.motivations ?? [],
    },
    visual: { primaryColor: "", style: "" },
    competitors: {
      differentiation: analysis.competitors.differentiation ?? "",
    },
    goals: { currentQuarter: "", keyMetrics: [] },
  };

  const dir = brandsDir(req.serviceId);
  await fs.mkdir(dir, { recursive: true });
  const yamlPath = path.join(dir, "brand.yaml");
  const yamlText =
    "# Auto-generated by @adaria-ai brand. Edit visual/goals by hand; re-run to refresh voice/audience.\n" +
    yaml.dump(profile, { noRefs: true, lineWidth: 100 });
  await fs.writeFile(yamlPath, yamlText, "utf-8");
  logInfo(`[brand-generate] wrote ${yamlPath}`);

  return { profile, yamlPath };
}
