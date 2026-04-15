import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import {
  generateBrandProfile,
  type BrandGeneratorDeps,
} from "../brands/generator.js";
import {
  nextState,
  startBrandFlow,
  type BrandFlowData,
  type BrandFlowState,
  type BrandFlowTransition,
} from "../brands/flow.js";
import { brandsDir } from "../utils/paths.js";
import {
  info as logInfo,
  warn as logWarn,
} from "../utils/logger.js";
import type { BrandProfile, BrandServiceType } from "../types/brand.js";
import type {
  ContinuationMessage,
  SkillContext,
  SkillContinuation,
  SkillResult,
} from "../types/skill.js";
import type { Skill } from "./index.js";

/**
 * BrandSkill (M6.7 Phase 4) — multi-turn conversational flow that
 * generates a `brand.yaml` for a service via Slack dialog.
 *
 * Lifecycle:
 *   - `@adaria-ai brand` → `dispatch` starts a new flow (ASK_TYPE).
 *   - Subsequent messages in the same thread re-enter via
 *     `continueFlow` (routed by core.ts before Mode A/B dispatch).
 *   - When the reducer hits `COLLECTING`, BrandSkill calls
 *     `generateBrandProfile` synchronously and pushes the result into
 *     PREVIEW on the same turn.
 *   - ASK_LOGO / ASK_DESIGN consume attached files via
 *     `ctx.downloadFile` and write them to `brandsDir(serviceId)/`.
 *   - DONE / CANCELLED return a continuation with `prompt: ""` so
 *     core.ts deletes the flow row without posting a duplicate reply.
 */

const ALLOWED_IMAGE_EXTS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export interface BrandSkillDeps {
  generator?: Pick<BrandGeneratorDeps, "runClaude"> &
    Partial<Omit<BrandGeneratorDeps, "runClaude">>;
  /** Injection point — default calls the real generator. */
  runGenerate?: typeof generateBrandProfile;
  /** Clock override for tests. */
  now?: () => Date;
}

export class BrandSkill implements Skill {
  readonly name = "brand";
  readonly commands = ["brand", "브랜드"] as const;

  constructor(private readonly deps: BrandSkillDeps = {}) {}

  async dispatch(ctx: SkillContext, _text: string): Promise<SkillResult> {
    if (!ctx.flowContext) {
      return Promise.resolve({
        summary:
          "브랜드 플로우 시작에는 Slack 쓰레드가 필요해. 쓰레드에서 `@adaria-ai brand` 다시 실행해줘.",
        alerts: [],
        approvals: [],
      });
    }

    const metadata: FlowMetadata = ctx.flowContext;
    const transition = startBrandFlow();
    const flowId = newFlowId();
    logInfo(`[brand] starting flow ${flowId} for user ${metadata.userId}`);

    return Promise.resolve(this.buildResult(ctx, flowId, metadata, transition));
  }

  async continueFlow(
    ctx: SkillContext,
    flowId: string,
    msg: ContinuationMessage,
  ): Promise<SkillResult> {
    const record = readFlowRow(ctx, flowId);
    if (record === null) {
      return {
        summary: "활성화된 브랜드 플로우가 없어. `@adaria-ai brand` 로 다시 시작해줘.",
        alerts: [],
        approvals: [],
      };
    }

    const current = record.state;
    const data = record.data;

    // Handle file attachments for ASK_LOGO / ASK_DESIGN BEFORE the
    // reducer runs — the reducer only needs to know if a file arrived,
    // not download it.
    if (
      (current === "ASK_LOGO" || current === "ASK_DESIGN") &&
      msg.files.length > 0
    ) {
      const saved = await this.saveImage(ctx, data, current, msg.files[0]!);
      if (!saved.ok) {
        return this.buildResult(
          ctx,
          flowId,
          record.metadata,
          {
            state: current,
            data,
            reply: saved.reply,
            terminal: false,
          },
        );
      }
    }

    const transition = nextState(current, data, {
      text: msg.text,
      fileAttached: msg.files.length > 0,
    });

    // Clean up orphaned brand.yaml if user cancels at PREVIEW after
    // COLLECTING has already written the file.
    if (
      current === "PREVIEW" &&
      transition.state === "CANCELLED"
    ) {
      await this.cleanupOrphanedYaml(data);
    }

    // If the reducer advanced to COLLECTING, drive the generator now
    // and chain into PREVIEW on the same turn so the user sees the
    // preview immediately instead of waiting for another message.
    if (transition.state === "COLLECTING") {
      return this.runCollection(ctx, flowId, record.metadata, transition);
    }

    return this.buildResult(ctx, flowId, record.metadata, transition);
  }

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  private async runCollection(
    ctx: SkillContext,
    flowId: string,
    metadata: FlowMetadata,
    transition: BrandFlowTransition,
  ): Promise<SkillResult> {
    const data = transition.data;
    const serviceId = data.serviceId ?? "unknown";
    const serviceType = data.serviceType;
    if (!serviceType) {
      logWarn(`[brand] flow ${flowId} reached COLLECTING without serviceType`);
      return this.buildResult(ctx, flowId, metadata, {
        state: "CANCELLED",
        data,
        reply: "플로우 상태가 유효하지 않아 취소됐어.",
        terminal: true,
      });
    }

    try {
      const result = await this.invokeGenerator(ctx, serviceType, data);
      const summary = formatPreview(result.profile, result.dryRun);
      const nextData: BrandFlowData & { _yamlPath?: string } = {
        ...data,
        serviceId,
      };
      if (!result.dryRun) nextData._yamlPath = result.yamlPath;
      return this.buildResult(ctx, flowId, metadata, {
        state: "PREVIEW",
        data: nextData,
        reply: summary,
        terminal: false,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logWarn(`[brand] generator failed for ${serviceId}: ${errMsg}`);
      return this.buildResult(ctx, flowId, metadata, {
        state: "CANCELLED",
        data,
        reply: `브랜드 분석 실패: ${errMsg}`,
        terminal: true,
      });
    }
  }

  /**
   * Delete a partial brand.yaml the generator wrote to disk during
   * COLLECTING when the user cancels at PREVIEW. Swallows ENOENT so the
   * handler is safe to call unconditionally.
   */
  private async cleanupOrphanedYaml(data: BrandFlowData): Promise<void> {
    const yamlPath = (data as BrandFlowData & { _yamlPath?: string })
      ._yamlPath;
    if (!yamlPath) return;
    try {
      await fs.rm(yamlPath, { force: true });
      logInfo(`[brand] cleaned up orphaned ${yamlPath}`);
    } catch (err) {
      logWarn(
        `[brand] failed to cleanup ${yamlPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async invokeGenerator(
    ctx: SkillContext,
    serviceType: BrandServiceType,
    data: BrandFlowData,
  ) {
    const runner = this.deps.runGenerate ?? generateBrandProfile;
    const deps: BrandGeneratorDeps = {
      runClaude: this.deps.generator?.runClaude ?? ctx.runClaude,
      ...(this.deps.generator?.appStore && {
        appStore: this.deps.generator.appStore,
      }),
      ...(this.deps.generator?.playStore && {
        playStore: this.deps.generator.playStore,
      }),
      ...(this.deps.generator?.asoMobile && {
        asoMobile: this.deps.generator.asoMobile,
      }),
      ...(this.deps.generator?.web && { web: this.deps.generator.web }),
      ...(this.deps.generator?.packageFetcher && {
        packageFetcher: this.deps.generator.packageFetcher,
      }),
      ...(this.deps.now && { now: this.deps.now }),
    };
    const req: Parameters<typeof generateBrandProfile>[0] = {
      serviceId: data.serviceId ?? "unknown",
      serviceType,
    };
    if (data.appStoreId) req.appStoreId = data.appStoreId;
    if (data.playStorePackage) req.playStorePackage = data.playStorePackage;
    if (data.websiteUrl) req.websiteUrl = data.websiteUrl;
    if (data.npmName) req.npmName = data.npmName;
    if (data.githubRepo) req.githubRepo = data.githubRepo;
    return runner(req, deps);
  }

  private async saveImage(
    ctx: SkillContext,
    data: BrandFlowData,
    state: BrandFlowState,
    file: ContinuationMessage["files"][number],
  ): Promise<{ ok: boolean; reply: string }> {
    if (!ctx.downloadFile) {
      return {
        ok: false,
        reply:
          "파일 다운로드를 지원하지 않는 환경이야. Slack 권한(`files:read`)을 확인해줘.",
      };
    }
    const ext = ALLOWED_IMAGE_EXTS[file.mimeType];
    if (!ext) {
      return {
        ok: false,
        reply: "PNG/JPG/WEBP 이미지만 받을 수 있어. 다시 업로드해줘.",
      };
    }
    if (!data.serviceId) {
      return {
        ok: false,
        reply: "서비스 id가 없어 저장할 수 없어. `취소` 후 다시 시작해줘.",
      };
    }
    const stem = state === "ASK_LOGO" ? "logo" : "design-system";
    const dir = brandsDir(data.serviceId);
    await fs.mkdir(dir, { recursive: true });
    await removeExistingImages(dir, stem);
    const destPath = path.join(dir, `${stem}.${ext}`);
    await ctx.downloadFile(file, destPath);
    return { ok: true, reply: "" };
  }

  private buildResult(
    ctx: SkillContext,
    flowId: string,
    metadata: FlowMetadata,
    transition: BrandFlowTransition,
  ): SkillResult {
    const now = this.deps.now?.().getTime() ?? Date.now();
    const continuation: SkillContinuation = {
      flowKind: "brand",
      flowId,
      userId: metadata.userId,
      threadKey: metadata.threadKey,
      serviceId: transition.data.serviceId ?? null,
      state: transition.state,
      data: transition.data as unknown as Record<string, unknown>,
      expects: expectsFromState(transition.state),
      prompt: transition.reply,
    };
    writeFlowRow(ctx, flowId, metadata, transition, now, transition.terminal);
    return {
      summary: transition.reply,
      alerts: [],
      approvals: [],
      continuation,
    };
  }
}

// ---------------------------------------------------------------------------
// DB plumbing — the skill persists flow state directly so core.ts doesn't
// need flow-specific logic. core.ts only routes incoming messages to the
// right entry point (dispatch vs. continueFlow).
// ---------------------------------------------------------------------------

interface FlowMetadata {
  userId: string;
  threadKey: string;
}

interface StoredFlow {
  state: BrandFlowState;
  data: BrandFlowData;
  metadata: FlowMetadata;
}

function readFlowRow(ctx: SkillContext, flowId: string): StoredFlow | null {
  const row = ctx.db
    .prepare(
      "SELECT user_id, thread_key, state, data_json FROM brand_flows WHERE flow_id = ?",
    )
    .get(flowId) as
    | {
        user_id: string;
        thread_key: string;
        state: string;
        data_json: string;
      }
    | undefined;
  if (!row) return null;
  try {
    const data = JSON.parse(row.data_json) as BrandFlowData;
    return {
      state: row.state as BrandFlowState,
      data,
      metadata: { userId: row.user_id, threadKey: row.thread_key },
    };
  } catch {
    return null;
  }
}

function writeFlowRow(
  ctx: SkillContext,
  flowId: string,
  metadata: FlowMetadata,
  transition: BrandFlowTransition,
  nowMs: number,
  terminal: boolean,
): void {
  if (terminal) {
    ctx.db.prepare("DELETE FROM brand_flows WHERE flow_id = ?").run(flowId);
    return;
  }
  const serviceId = transition.data.serviceId ?? null;
  ctx.db
    .prepare(
      `INSERT INTO brand_flows (
         flow_id, user_id, thread_key, service_id, state, data_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, thread_key) DO UPDATE SET
         flow_id = excluded.flow_id,
         service_id = excluded.service_id,
         state = excluded.state,
         data_json = excluded.data_json,
         updated_at = excluded.updated_at`,
    )
    .run(
      flowId,
      metadata.userId,
      metadata.threadKey,
      serviceId,
      transition.state,
      JSON.stringify(transition.data),
      nowMs,
      nowMs,
    );
}

function expectsFromState(state: BrandFlowState): SkillContinuation["expects"] {
  if (state === "ASK_LOGO" || state === "ASK_DESIGN") return "either";
  return "text";
}

function newFlowId(): string {
  return `brand_${crypto.randomBytes(9).toString("base64url")}`;
}

async function removeExistingImages(
  dir: string,
  stem: string,
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const ext = path.extname(name).toLowerCase();
    const base = name.slice(0, name.length - ext.length);
    if (base === stem && /^\.(png|jpe?g|webp)$/i.test(ext)) {
      await fs.rm(path.join(dir, name), { force: true });
    }
  }
}

function formatPreview(profile: BrandProfile, dryRun: boolean): string {
  const tag = dryRun ? "[DRY_RUN] " : "";
  const lines = [
    `${tag}*브랜드 프로필 미리보기* (\`${profile._meta.serviceType}\`)`,
    "",
    `• Tagline: ${profile.identity.tagline || "_(비어있음)_"}`,
    `• Positioning: ${profile.identity.positioning || "_(비어있음)_"}`,
    `• Tone: ${profile.voice.tone || "_(비어있음)_"}`,
    `• Audience: ${profile.audience.primary || "_(비어있음)_"}`,
    `• Differentiation: ${profile.competitors.differentiation || "_(비어있음)_"}`,
    "",
    "저장하려면 `저장`, 취소하려면 `취소`라고 답해줘.",
  ];
  return lines.join("\n");
}
