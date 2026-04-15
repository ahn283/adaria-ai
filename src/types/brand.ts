import { z } from "zod";

/**
 * `brand.yaml` schema (per PRD §3).
 *
 * Lives at `$ADARIA_HOME/brands/{serviceId}/brand.yaml` and is produced
 * by the BrandSkill multi-turn flow (M6.7). Existing skills inject a
 * rendered excerpt of this profile into every Claude prompt as brand
 * context so output voice/positioning matches the service.
 *
 * Only `identity`, `voice`, `audience`, and `competitors` are auto-
 * generated. `visual`, `goals`, and `_meta` identifiers can be hand-
 * edited by the operator.
 */

export const brandServiceTypeSchema = z.enum(["app", "web", "package"]);

export const brandMetaSchema = z.object({
  serviceType: brandServiceTypeSchema,
  generatedAt: z.string().min(1),
  sources: z.array(z.string()).default([]),
  identifiers: z.record(z.string(), z.string()).default({}),
});

export const brandIdentitySchema = z.object({
  tagline: z.string().default(""),
  mission: z.string().default(""),
  positioning: z.string().default(""),
  category: z.string().default(""),
});

export const brandVoiceSchema = z.object({
  tone: z.string().default(""),
  personality: z.string().default(""),
  do: z.array(z.string()).default([]),
  dont: z.array(z.string()).default([]),
});

export const brandAudienceSchema = z.object({
  primary: z.string().default(""),
  painPoints: z.array(z.string()).default([]),
  motivations: z.array(z.string()).default([]),
});

export const brandVisualSchema = z.object({
  primaryColor: z.string().default(""),
  style: z.string().default(""),
});

export const brandCompetitorsSchema = z.object({
  differentiation: z.string().default(""),
});

export const brandGoalsSchema = z.object({
  currentQuarter: z.string().default(""),
  keyMetrics: z.array(z.string()).default([]),
});

export const brandProfileSchema = z.object({
  _meta: brandMetaSchema,
  identity: brandIdentitySchema.default({
    tagline: "",
    mission: "",
    positioning: "",
    category: "",
  }),
  voice: brandVoiceSchema.default({
    tone: "",
    personality: "",
    do: [],
    dont: [],
  }),
  audience: brandAudienceSchema.default({
    primary: "",
    painPoints: [],
    motivations: [],
  }),
  visual: brandVisualSchema.default({ primaryColor: "", style: "" }),
  competitors: brandCompetitorsSchema.default({ differentiation: "" }),
  goals: brandGoalsSchema.default({ currentQuarter: "", keyMetrics: [] }),
});

export type BrandServiceType = z.infer<typeof brandServiceTypeSchema>;
export type BrandProfile = z.infer<typeof brandProfileSchema>;
export type BrandMeta = z.infer<typeof brandMetaSchema>;

/** Image kinds loaded alongside `brand.yaml` for vision-capable skills. */
export type BrandImageKind = "logo" | "design-system";

export interface BrandImage {
  /** Base64-encoded file bytes (ready for Claude vision content blocks). */
  data: string;
  /** MIME type derived from the file extension. */
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  /** Which kind of reference this is. */
  kind: BrandImageKind;
}
