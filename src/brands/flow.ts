import type { BrandServiceType } from "../types/brand.js";

/**
 * Brand profile conversation state machine (M6.7 Phase 3).
 *
 * Pure reducer — `nextState(current, event)` → `{ state, reply,
 * persistedData }`. BrandSkill (Phase 4) owns persistence: it calls
 * this reducer, then upserts `brand_flows` and posts `reply` to Slack.
 * Keeping the state machine free of side effects means the full
 * conversation tree is unit-testable without DB or messenger mocks.
 *
 * States and transitions mirror PRD §4.3. Terminal states are `DONE`
 * and `CANCELLED`; both signal the caller to delete the flow row.
 */

export const BRAND_FLOW_STATES = [
  "ASK_TYPE",
  "ASK_IDENTIFIER",
  "ASK_COMPETITORS",
  "COLLECTING",
  "PREVIEW",
  "ASK_LOGO",
  "ASK_DESIGN",
  "DONE",
  "CANCELLED",
] as const;

export type BrandFlowState = (typeof BRAND_FLOW_STATES)[number];

export interface BrandFlowData {
  serviceType?: BrandServiceType;
  serviceId?: string;
  appStoreId?: string;
  playStorePackage?: string;
  websiteUrl?: string;
  npmName?: string;
  githubRepo?: string;
  competitors?: string[];
}

export interface BrandFlowEvent {
  text: string;
  /**
   * Whether the user attached a file this turn. The reducer uses this
   * to decide file-bearing states (ASK_LOGO, ASK_DESIGN); the caller
   * handles actual file download + save after the transition.
   */
  fileAttached?: boolean;
}

export interface BrandFlowTransition {
  state: BrandFlowState;
  data: BrandFlowData;
  /** Text to post back to Slack. Empty string means "no reply". */
  reply: string;
  /**
   * When true, the caller should delete the flow row after acting on
   * the transition. True for terminal states.
   */
  terminal: boolean;
}

const CANCEL_TOKENS = new Set(["취소", "cancel", "abort"]);
const SKIP_TOKENS = new Set(["건너뛰기", "skip", "스킵", "pass"]);

function normalised(text: string): string {
  return text.trim().toLowerCase();
}

function isCancel(text: string): boolean {
  return CANCEL_TOKENS.has(normalised(text));
}

function isSkip(text: string): boolean {
  return SKIP_TOKENS.has(normalised(text));
}

function parseServiceType(text: string): BrandServiceType | null {
  const t = normalised(text);
  if (t === "app" || t === "앱" || t === "application") return "app";
  if (t === "web" || t === "웹" || t === "website" || t === "site")
    return "web";
  if (t === "package" || t === "패키지" || t === "npm" || t === "pkg")
    return "package";
  return null;
}

function parseAppIdentifier(
  text: string
): { appStoreId?: string; playStorePackage?: string } | null {
  const trimmed = text.trim();
  // App Store URL: https://apps.apple.com/…/id123456789
  const appStoreMatch = trimmed.match(/id(\d{6,})/i);
  if (appStoreMatch?.[1]) return { appStoreId: appStoreMatch[1] };
  // Numeric-only → App Store id
  if (/^\d{6,}$/.test(trimmed)) return { appStoreId: trimmed };
  // Play Store URL: https://play.google.com/store/apps/details?id=com.x.y
  const playMatch = trimmed.match(/[?&]id=([\w.]+)/);
  if (playMatch?.[1]) return { playStorePackage: playMatch[1] };
  // Bare package name (two or more dot-separated segments).
  if (/^[a-z][\w]*(\.[a-z][\w]*)+$/i.test(trimmed))
    return { playStorePackage: trimmed };
  return null;
}

function parseWebIdentifier(text: string): string | null {
  const trimmed = text.trim();
  try {
    const u = new URL(trimmed);
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
    return null;
  } catch {
    // Allow bare domains — caller prepends https://
    if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(trimmed)) {
      return `https://${trimmed}`;
    }
    return null;
  }
}

function parsePackageIdentifier(text: string): string | null {
  const trimmed = text.trim();
  // npm package name rules (simplified): lowercase, scoped or flat.
  if (/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(trimmed)) return trimmed;
  return null;
}

function parseCompetitors(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed || isSkip(trimmed) || trimmed === "없음" || trimmed === "none")
    return [];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function cancelledTransition(data: BrandFlowData): BrandFlowTransition {
  return {
    state: "CANCELLED",
    data,
    reply: "취소됐어.",
    terminal: true,
  };
}

/**
 * Compute the next state for the flow. Pure — no I/O, no DB, no clock.
 * Given a current state + event, returns the next state, merged data,
 * and the Slack reply to post.
 */
export function nextState(
  current: BrandFlowState,
  data: BrandFlowData,
  event: BrandFlowEvent
): BrandFlowTransition {
  const text = event.text ?? "";

  if (isCancel(text)) {
    return cancelledTransition(data);
  }

  switch (current) {
    case "ASK_TYPE": {
      const type = parseServiceType(text);
      if (type === null) {
        return {
          state: "ASK_TYPE",
          data,
          reply:
            "`app`, `web`, `package` 중 하나로 답해줘. (취소하려면 `취소`)",
          terminal: false,
        };
      }
      const nextData: BrandFlowData = { ...data, serviceType: type };
      const prompt =
        type === "app"
          ? "App Store URL (또는 숫자 id) 또는 Play Store URL / 패키지 이름을 줘."
          : type === "web"
            ? "웹사이트 URL을 줘 (`https://`)."
            : "npm 패키지 이름을 줘 (예: `@eodin/analytics-sdk`).";
      return {
        state: "ASK_IDENTIFIER",
        data: nextData,
        reply: prompt,
        terminal: false,
      };
    }

    case "ASK_IDENTIFIER": {
      if (data.serviceType === "app") {
        const parsed = parseAppIdentifier(text);
        if (parsed === null) {
          return {
            state: "ASK_IDENTIFIER",
            data,
            reply:
              "유효한 App Store URL / 숫자 id / Play Store 패키지 이름을 줘.",
            terminal: false,
          };
        }
        const nextData = { ...data, ...parsed };
        if (!nextData.serviceId) nextData.serviceId = deriveServiceId(nextData);
        return {
          state: "ASK_COMPETITORS",
          data: nextData,
          reply:
            "경쟁 앱 bundleID 있으면 콤마로 구분해서 줘. 없으면 `없음` 또는 `건너뛰기`.",
          terminal: false,
        };
      }
      if (data.serviceType === "web") {
        const url = parseWebIdentifier(text);
        if (url === null) {
          return {
            state: "ASK_IDENTIFIER",
            data,
            reply: "유효한 URL을 줘 (`https://` 포함).",
            terminal: false,
          };
        }
        const nextData = { ...data, websiteUrl: url };
        if (!nextData.serviceId) nextData.serviceId = deriveServiceId(nextData);
        return {
          state: "COLLECTING",
          data: nextData,
          reply: "좋아. 웹사이트 분석 중이야… 잠시만.",
          terminal: false,
        };
      }
      if (data.serviceType === "package") {
        const name = parsePackageIdentifier(text);
        if (name === null) {
          return {
            state: "ASK_IDENTIFIER",
            data,
            reply:
              "유효한 npm 패키지 이름을 줘 (소문자, 선택적으로 `@scope/` 접두어).",
            terminal: false,
          };
        }
        const nextData = { ...data, npmName: name };
        if (!nextData.serviceId) nextData.serviceId = deriveServiceId(nextData);
        return {
          state: "COLLECTING",
          data: nextData,
          reply: "좋아. npm + GitHub에서 데이터 수집 중… 잠시만.",
          terminal: false,
        };
      }
      return {
        state: "ASK_TYPE",
        data,
        reply: "서비스 타입이 분실됐어. 다시 시작할게. app/web/package 중 선택해줘.",
        terminal: false,
      };
    }

    case "ASK_COMPETITORS": {
      const competitors = parseCompetitors(text);
      return {
        state: "COLLECTING",
        data: { ...data, competitors },
        reply: "좋아. App Store / Play Store 데이터 수집 중… 잠시만.",
        terminal: false,
      };
    }

    case "COLLECTING": {
      // Reducer does not drive collection itself — BrandSkill advances
      // this state by dispatching COLLECTING → PREVIEW directly after
      // the generator returns. Incoming user messages during
      // COLLECTING are deferred (treated as no-op reply).
      return {
        state: "COLLECTING",
        data,
        reply: "아직 분석 중이야, 잠시만 기다려줘.",
        terminal: false,
      };
    }

    case "PREVIEW": {
      // PREVIEW is advanced by a button click in Phase 4. A text reply
      // here is treated as "저장" (yes) or anything else → cancel.
      const t = normalised(text);
      if (t === "저장" || t === "save" || t === "yes" || t === "y" || t === "ok") {
        return {
          state: "ASK_LOGO",
          data,
          reply:
            "로고 이미지 업로드해줘 (PNG/JPG/WEBP ≤ 5MB). 스킵하려면 `건너뛰기`.",
          terminal: false,
        };
      }
      if (t === "취소" || t === "cancel" || t === "no" || t === "n") {
        return cancelledTransition(data);
      }
      return {
        state: "PREVIEW",
        data,
        reply: "`저장` 또는 `취소`를 눌러줘.",
        terminal: false,
      };
    }

    case "ASK_LOGO": {
      if (event.fileAttached === true) {
        return {
          state: "ASK_DESIGN",
          data,
          reply:
            "로고 저장 완료. 디자인 시스템 이미지가 있으면 업로드해줘. 없으면 `건너뛰기`.",
          terminal: false,
        };
      }
      if (isSkip(text)) {
        return {
          state: "ASK_DESIGN",
          data,
          reply:
            "디자인 시스템 이미지 있으면 업로드, 없으면 `건너뛰기`.",
          terminal: false,
        };
      }
      return {
        state: "ASK_LOGO",
        data,
        reply:
          "로고 이미지를 업로드하거나 `건너뛰기`를 입력해줘.",
        terminal: false,
      };
    }

    case "ASK_DESIGN": {
      if (event.fileAttached === true) {
        return {
          state: "DONE",
          data,
          reply: `✅ \`brands/${data.serviceId ?? ""}/\` 저장 완료. 주간 분석에 반영하려면 \`apps.yaml\`에 추가해.`,
          terminal: true,
        };
      }
      if (isSkip(text)) {
        return {
          state: "DONE",
          data,
          reply: `✅ \`brands/${data.serviceId ?? ""}/\` 저장 완료. 주간 분석에 반영하려면 \`apps.yaml\`에 추가해.`,
          terminal: true,
        };
      }
      return {
        state: "ASK_DESIGN",
        data,
        reply:
          "디자인 시스템 이미지를 업로드하거나 `건너뛰기`를 입력해줘.",
        terminal: false,
      };
    }

    case "DONE":
    case "CANCELLED":
      return { state: current, data, reply: "", terminal: true };
  }
}

function deriveServiceId(data: BrandFlowData): string {
  if (data.npmName) {
    // Strip @scope/ prefix for directory-friendly id.
    const m = data.npmName.match(/^@([^/]+)\/(.+)$/);
    if (m?.[2]) return `${m[1] ?? ""}-${m[2]}`.replace(/[^A-Za-z0-9._-]/g, "-");
    return data.npmName.replace(/[^A-Za-z0-9._-]/g, "-");
  }
  if (data.playStorePackage) {
    const parts = data.playStorePackage.split(".");
    return parts[parts.length - 1] ?? data.playStorePackage;
  }
  if (data.appStoreId) return `app-${data.appStoreId}`;
  if (data.websiteUrl) {
    try {
      const host = new URL(data.websiteUrl).hostname;
      return host.replace(/^www\./, "").replace(/\./g, "-");
    } catch {
      return "web";
    }
  }
  return "unknown";
}

/** Exposed for tests. */
export const __test__ = { deriveServiceId };

/** Entry point for a brand new flow — returns the ASK_TYPE prompt. */
export function startBrandFlow(): BrandFlowTransition {
  return {
    state: "ASK_TYPE",
    data: {},
    reply:
      "어떤 서비스의 브랜드를 분석할까? `app` / `web` / `package` 중 골라줘. (취소: `취소`)",
    terminal: false,
  };
}
