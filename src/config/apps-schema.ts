import { z } from "zod";

/**
 * `apps.yaml` schema.
 *
 * Lives at the repo root (dev) or `$ADARIA_HOME/apps.yaml` (installed)
 * and holds the per-app metadata the skills and orchestrators iterate
 * over. Global credentials stay in `config.yaml.collectors`; per-app
 * identifiers (App Store numeric id, Play package name, YouTube channel
 * id, primary keywords, etc.) belong here because the operator adds and
 * removes apps independently from rotating secrets.
 *
 * Wire shape note: fields are camelCase even though the growth-agent
 * predecessor used snake_case (`appstore_id`, `playstore_id`). The port
 * is one-shot so users re-write `apps.yaml` from the example template
 * once; the new names match TypeScript convention and the wire-shape
 * delta rule in `src/types/collectors.ts`.
 */

export const appPlatformSchema = z.enum(["ios", "android"]);

export const appFeaturesSchema = z
  .object({
    /** Enable the Fridgify recipe cascade in SeoBlogSkill (M5+). */
    fridgifyRecipes: z.boolean().default(false),
  })
  .default({ fridgifyRecipes: false });

export const appConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  platform: z.array(appPlatformSchema).min(1),
  /** App Store numeric id (string to preserve leading zeros). */
  appStoreId: z.string().optional(),
  /** Google Play package name (e.g. `com.eodin.fridgify`). */
  playStorePackage: z.string().optional(),
  /** App id the Eodin SDK analytics service knows this app by. */
  eodinSdkAppId: z.string().optional(),
  /** ASOMobile id (usually the App Store numeric id reused). */
  asoMobileId: z.string().optional(),
  /** YouTube channel whose Shorts back this app's growth loop. */
  youtubeChannelId: z.string().optional(),
  primaryKeywords: z.array(z.string()).default([]),
  competitors: z.array(z.string()).default([]),
  locale: z.array(z.string()).default([]),
  features: appFeaturesSchema,
  active: z.boolean().default(true),
});

export const appsFileSchema = z.object({
  apps: z.array(appConfigSchema).min(1),
});

export type AppPlatform = z.infer<typeof appPlatformSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;
export type AppsFile = z.infer<typeof appsFileSchema>;
