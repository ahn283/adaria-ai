import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import yaml from "js-yaml";

import { ConfigError } from "../utils/errors.js";
import { brandsDir } from "../utils/paths.js";
import {
  brandProfileSchema,
  type BrandImage,
  type BrandImageKind,
  type BrandProfile,
} from "../types/brand.js";

const IMAGE_EXT_TO_MIME: Record<string, BrandImage["mediaType"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}

/**
 * Load the brand profile for a service. Returns `null` when the YAML
 * does not exist (graceful degradation — skills must still run when
 * the operator hasn't generated a profile yet). Throws `ConfigError`
 * only when the file exists but fails schema validation.
 */
export async function loadBrandProfile(
  serviceId: string
): Promise<BrandProfile | null> {
  const filePath = path.join(brandsDir(serviceId), "brand.yaml");

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if (isEnoent(err)) {
      return null;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch (cause) {
    throw new ConfigError(
      `Failed to parse brand.yaml for ${serviceId}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      {
        cause,
        userMessage: `brand.yaml at ${filePath} is not valid YAML — re-run \`@adaria-ai brand\` to regenerate.`,
      }
    );
  }
  const result = brandProfileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid brand.yaml for ${serviceId}:\n${issues}`, {
      userMessage: `brand.yaml at ${filePath} is invalid — re-run \`@adaria-ai brand\` to regenerate.`,
    });
  }

  return result.data;
}

/**
 * Render a profile as a ~300-token human-readable block for prompt
 * injection. Returns an empty string when `profile` is null so
 * `{{brandContext}}` substitutes cleanly whether or not a profile
 * exists.
 */
export function formatBrandContext(profile: BrandProfile | null): string {
  if (profile === null) {
    return "";
  }

  const lines: string[] = [];

  const { identity, voice, audience, competitors, visual } = profile;

  if (identity.tagline || identity.positioning || identity.category) {
    lines.push("Identity:");
    if (identity.tagline) lines.push(`  Tagline: ${identity.tagline}`);
    if (identity.mission) lines.push(`  Mission: ${identity.mission}`);
    if (identity.positioning)
      lines.push(`  Positioning: ${identity.positioning}`);
    if (identity.category) lines.push(`  Category: ${identity.category}`);
  }

  if (voice.tone || voice.personality || voice.do.length || voice.dont.length) {
    lines.push("Voice:");
    if (voice.tone) lines.push(`  Tone: ${voice.tone}`);
    if (voice.personality)
      lines.push(`  Personality: ${voice.personality}`);
    if (voice.do.length)
      lines.push(`  Do: ${voice.do.map((s) => `"${s}"`).join(", ")}`);
    if (voice.dont.length)
      lines.push(`  Don't: ${voice.dont.map((s) => `"${s}"`).join(", ")}`);
  }

  if (
    audience.primary ||
    audience.painPoints.length ||
    audience.motivations.length
  ) {
    lines.push("Audience:");
    if (audience.primary) lines.push(`  Primary: ${audience.primary}`);
    if (audience.painPoints.length)
      lines.push(`  Pain points: ${audience.painPoints.join("; ")}`);
    if (audience.motivations.length)
      lines.push(`  Motivations: ${audience.motivations.join("; ")}`);
  }

  if (competitors.differentiation) {
    lines.push("Competitors:");
    lines.push(`  Differentiation: ${competitors.differentiation}`);
  }

  if (visual.style || visual.primaryColor) {
    lines.push("Visual:");
    if (visual.style) lines.push(`  Style: ${visual.style}`);
    if (visual.primaryColor)
      lines.push(`  Primary color: ${visual.primaryColor}`);
  }

  return lines.join("\n");
}

async function findImageFile(
  dir: string,
  stem: string
): Promise<{ filePath: string; mediaType: BrandImage["mediaType"] } | null> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) {
      return null;
    }
    throw err;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue; // reject symlinks, sockets, dirs
    const name = entry.name;
    const ext = path.extname(name).toLowerCase();
    const base = name.slice(0, name.length - ext.length);
    if (base !== stem) continue;
    const mime = IMAGE_EXT_TO_MIME[ext];
    if (!mime) continue;
    return { filePath: path.join(dir, name), mediaType: mime };
  }

  return null;
}

/**
 * Load brand reference images for a service. Missing images (or a
 * missing brands directory) return an empty array — vision skills
 * proceed with text-only brand context in that case.
 */
export async function loadBrandImages(
  serviceId: string,
  kinds: readonly BrandImageKind[]
): Promise<BrandImage[]> {
  const dir = brandsDir(serviceId);
  const images: BrandImage[] = [];

  for (const kind of kinds) {
    const hit = await findImageFile(dir, kind);
    if (hit === null) continue;
    const buf = await fs.readFile(hit.filePath);
    images.push({
      data: buf.toString("base64"),
      mediaType: hit.mediaType,
      kind,
    });
  }

  return images;
}
