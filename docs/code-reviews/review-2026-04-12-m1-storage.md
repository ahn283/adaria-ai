# Code Review: M1 — Storage-layer Port (session / audit / memory / conversation-summary)

**Date**: 2026-04-12
**Reviewer**: Senior Code Review Agent
**Scope**:
- `src/agent/session.ts` (new, ported from `pilot-ai/src/agent/session.ts`)
- `src/agent/audit.ts` (new, ported from `pilot-ai/src/security/audit.ts`)
- `src/agent/memory.ts` (new, ported from `pilot-ai/src/agent/memory.ts` with project-scoped paths dropped)
- `src/agent/conversation-summary.ts` (new, ported from `pilot-ai/src/agent/conversation-summary.ts` with `projectPath` field dropped)
- `src/utils/paths.ts` (extended with `MEMORY_DIR`, `CONVERSATIONS_DIR`)
**Milestone**: M1 (pilot-ai runtime import)
**Commit(s)**: uncommitted (working tree)

## Summary

M1 스토리지 레이어 포트는 전반적으로 충실하고 깔끔합니다. `projectPath` 필드와 project-scoped memory 경로는 완전히 제거되었고(유일한 잔존은 주석에서 "drop 했다"는 설명뿐), `ADARIA_HOME`/`MEMORY_DIR`/`CONVERSATIONS_DIR` 리디렉션도 정확합니다. 경로는 `paths.ts`의 top-level 상수를 직접 import하므로 `logger.test.ts` 패턴("ADARIA_HOME 세팅 후 `await import()`")과 호환됩니다 — 모듈 내부에 지연 경로 재평가 로직이 없고, `SESSIONS_PATH` 등을 함수 호출 시점이 아닌 import 시점에 해소하므로 vitest의 파일-단위 워커 격리와 맞물려 테스트 간 간섭 없이 작동합니다.

다만 다음 몇 가지를 짚어야 합니다:

1. **MEDIUM** `memory.ts`와 `conversation-summary.ts`가 `MEMORY_DIR`/`CONVERSATIONS_DIR`을 **mode 인자 없이** `fs.mkdir`로 만들어 0700 보장이 깨집니다. `config/store.ts:ensureAdariaDir`의 `ADARIA_SUBDIRS`가 두 디렉터리를 누락하고 있어 이중 방어선 중 하나가 비어 있는 상태입니다.
2. **MEDIUM** `conversation-summary.ts`와 `memory.ts`는 사용자 메시지/에이전트 응답을 디스크에 저장한 뒤 Claude 프롬프트에 주입합니다. 그런데 `audit.ts`의 `maskSecrets`가 적용되지 않아, 만약 사용자 메시지나 에이전트 출력에 토큰이 섞이면 파일과 외부 Anthropic API 양쪽으로 누설됩니다. `audit.ts`와의 대칭이 깨져 있습니다.
3. **MEDIUM** `audit.ts`의 `bot\d+:...` 텔레그램 봇 토큰 패턴이 삭제되면서 일반 정규식만 남았는데, 드롭 자체는 맞지만 Google service account JSON / AppStore Connect JWT / ASO Mobile API key 등 adaria-ai 도메인 시크릿 패턴이 *아직* 추가되지 않았습니다. M1 스코프로는 괜찮지만 M2 collector 포트에서 반드시 확장되어야 한다는 점을 기록해둡니다.
4. **LOW** `audit.ts`/`session.ts`는 부모 디렉터리 존재를 `ensureAdariaDir`에 전적으로 의존합니다. 코멘트로 문서화되어 있긴 하나 유닛테스트에서 `ensureAdariaDir`을 호출하지 않고 해당 함수들을 바로 부르면 ENOENT로 터집니다.

CRITICAL, HIGH는 0건입니다. M1 진행에 블로커는 없고, 스테이지 4 유닛테스트 작성으로 바로 넘어가도 됩니다.

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH     | 0 |
| MEDIUM   | 3 |
| LOW      | 3 |
| INFO     | 3 |

**Overall Grade**: B+
**Milestone fit**: 적절. M1 스코프 내(storage 4파일 + paths 상수 2개). 스코프 크리프 없음.

## Medium Findings

### M1. `MEMORY_DIR`/`CONVERSATIONS_DIR`이 0700이 아니라 umask 기본값으로 생성됨

- **Severity**: MEDIUM
- **Category**: Security / 방어선 일관성
- **File**:
  - `src/agent/memory.ts:38` `await fs.mkdir(MEMORY_DIR, { recursive: true });`
  - `src/agent/memory.ts:52` `await fs.mkdir(path.dirname(histPath), { recursive: true });`
  - `src/agent/memory.ts:109` `await fs.mkdir(path.join(MEMORY_DIR, "history"), { recursive: true });`
  - `src/agent/conversation-summary.ts:75` `await fs.mkdir(CONVERSATIONS_DIR, { recursive: true });`
  - `src/config/store.ts:17` `const ADARIA_SUBDIRS = [LOGS_DIR, DATA_DIR];` ← `MEMORY_DIR`, `CONVERSATIONS_DIR` 누락
- **Issue**: `fs.mkdir` 호출에 `mode` 인자가 없어, 프로세스 umask(보통 022)에 따라 0755로 생성됩니다. `config/store.ts:ensureAdariaDir`은 `ADARIA_SUBDIRS`에 있는 것만 0700으로 강제 chmod하는데 `MEMORY_DIR`과 `CONVERSATIONS_DIR`은 거기 빠져 있습니다. 그리고 memory/conversation-summary 모듈이 "내가 직접 만든다"는 접근을 취하는 바람에 이중 방어선(두 곳에서 0700을 보장)이 한쪽은 비어 있는 상태입니다.
- **Impact**:
  - 부모 `$ADARIA_HOME`이 0700이므로 *다른 유닉스 사용자*에게는 여전히 닫혀 있음 — 즉시 CRITICAL/HIGH는 아님.
  - 그러나 유저가 어떤 이유로 `chmod 755 ~/.adaria`를 하면 히스토리와 대화 요약이 다른 로컬 유저에게 열림. audit.jsonl, sessions.json은 0600이지만 디렉터리만 0755로 남아 목록이 드러남.
  - `config/store.ts`가 의도한 "모든 adaria-owned 디렉터리는 0700" 불변식과 비대칭.
  - CLAUDE.md의 "ADARIA_HOME tightening to 0700 happens in `config/store.ts:ensureAdariaDir`" 계약이 스토리지 레이어로 전이되지 않음.
- **Current code**:
```ts
// src/config/store.ts:17
const ADARIA_SUBDIRS = [LOGS_DIR, DATA_DIR];
```
```ts
// src/agent/memory.ts:38
await fs.mkdir(MEMORY_DIR, { recursive: true });
await fs.writeFile(getMemoryFilePath(), trimmed);
```
```ts
// src/agent/conversation-summary.ts:75
await fs.mkdir(CONVERSATIONS_DIR, { recursive: true });
await fs.writeFile(filePath, JSON.stringify(summary, null, 2), { mode: 0o600 });
```
- **Recommended fix**: `ADARIA_SUBDIRS`에 `MEMORY_DIR`, `CONVERSATIONS_DIR`을 추가해서 ensureAdariaDir이 첫 daemon 부팅 때 한 번에 0700으로 만들고 tighten하도록 합니다. 그리고 memory/conversation-summary 쪽은 명시적으로 mode 0o700을 넣어 두 번째 방어선을 유지합니다.
```ts
// src/utils/paths.ts — no change
export const MEMORY_DIR = path.join(ADARIA_HOME, "memory");
export const CONVERSATIONS_DIR = path.join(ADARIA_HOME, "conversations");
export const MEMORY_HISTORY_DIR = path.join(MEMORY_DIR, "history");
```
```ts
// src/config/store.ts:17
import {
  ADARIA_HOME,
  CONFIG_PATH,
  CONVERSATIONS_DIR,
  DATA_DIR,
  LOGS_DIR,
  MEMORY_DIR,
  MEMORY_HISTORY_DIR,
} from "../utils/paths.js";

const ADARIA_SUBDIRS = [
  LOGS_DIR,
  DATA_DIR,
  MEMORY_DIR,
  MEMORY_HISTORY_DIR,
  CONVERSATIONS_DIR,
];
```
```ts
// src/agent/memory.ts:35-40
export async function writeUserMemory(content: string): Promise<void> {
  const lines = content.split("\n");
  const trimmed = lines.slice(0, MAX_MEMORY_LINES).join("\n");
  await fs.mkdir(MEMORY_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(getMemoryFilePath(), trimmed, { mode: 0o600 });
}
```
```ts
// src/agent/memory.ts:50-61
export async function appendHistory(entry: string): Promise<void> {
  const histPath = getHistoryPath();
  await fs.mkdir(path.dirname(histPath), { recursive: true, mode: 0o700 });

  const timestamp = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const line = `- ${timestamp}: ${entry}\n`;

  await fs.appendFile(histPath, line, { mode: 0o600 });
}
```
```ts
// src/agent/memory.ts:107-110 (resetMemory)
export async function resetMemory(): Promise<void> {
  await fs.rm(MEMORY_DIR, { recursive: true, force: true });
  await fs.mkdir(path.join(MEMORY_DIR, "history"), {
    recursive: true,
    mode: 0o700,
  });
}
```
```ts
// src/agent/conversation-summary.ts:71-79
export async function saveSummary(
  summary: ConversationSummary,
): Promise<void> {
  const filePath = getSummaryPath(summary.threadKey);
  await fs.mkdir(CONVERSATIONS_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, JSON.stringify(summary, null, 2), {
    mode: 0o600,
  });
}
```
참고: `writeUserMemory`는 현재 기존 파일을 **mode 인자 없이** 덮어쓰는데(`fs.writeFile(getMemoryFilePath(), trimmed)`), 기존 파일이 이미 0600이면 모드가 유지되지만 신규 생성 시 umask대로 0644로 떨어집니다. 위 fix에 `mode: 0o600`을 명시하여 생성 경로도 0600으로 막았습니다.

---

### M2. 대화 요약/메모리에 토큰 마스킹이 없어 `audit.ts`와 대칭이 깨짐

- **Severity**: MEDIUM
- **Category**: Security / Prompt injection & secret handling
- **File**:
  - `src/agent/conversation-summary.ts:174-178` (TurnSummary 저장 시)
  - `src/agent/memory.ts:58` (appendHistory)
- **Issue**: `audit.ts`는 `maskSecrets()`를 디폴트로 적용해 Slack/Anthropic 토큰이 로그에 들어가지 않도록 합니다. 그런데 `conversation-summary.ts`의 `updateConversationSummary`는 `userMessage`와 `agentResponse`를 **마스킹 없이** 그대로 `turns[].userMessage`와 `extractActionSummary(agentResponse)` 출력에 저장합니다. 두 가지 경로로 새어 나갑니다:
  1. 디스크에 있는 `~/.adaria/conversations/*.json`으로 (파일은 0600이므로 파일시스템 레벨 노출은 없음)
  2. `getConversationSummaryText`가 이 요약을 **Claude 프롬프트에 주입**하므로 secrets가 Anthropic API로 송신됨
- **Impact**:
  - adaria-ai는 single-user local이므로 Slack 메시지에 `xoxb-...`가 들어올 일은 드뭅니다. 단 사용자가 onboarding 도중 `@adaria-ai doctor` 같은 요청을 하며 config 문자열을 복붙해 오는 시나리오는 현실적으로 존재.
  - Claude CLI가 응답 내부에서 masked되지 않은 토큰을 reflect 하는 경우(그럴 수 있음 — 에이전트가 "I see your slack token xoxb-...는 이러이러합니다"라고 말할 때) 해당 응답이 다시 summary로 저장되고 다음 턴에 다시 Claude로 돌아갑니다. 루프 형태로 secrets가 고착됨.
  - pilot-ai도 동일 버그를 가지고 있지만 CLAUDE.md 규약상 "Bugs discovered post-fork are fixed in adaria-ai directly, not backported"이므로 지금 잡는 게 맞습니다.
- **Current code**:
```ts
// src/agent/conversation-summary.ts:174-182
const turn: TurnSummary = {
  userMessage: userMessage.slice(0, MAX_USER_MSG_LEN),
  agentAction: extractActionSummary(agentResponse),
  timestamp: new Date().toISOString(),
};
summary.turns.push(turn);
```
- **Recommended fix**: `maskSecrets`를 `audit.ts`에서 export해 단일 소스로 재사용하고, `conversation-summary.ts` 저장 시점에 적용합니다. `memory.ts:appendHistory`에도 동일하게 적용.
```ts
// src/agent/audit.ts — maskSecrets is already exported ✓
export function maskSecrets(text: string): string { ... }
```
```ts
// src/agent/conversation-summary.ts — top of file
import { maskSecrets } from "./audit.js";
```
```ts
// src/agent/conversation-summary.ts:174-179
const turn: TurnSummary = {
  userMessage: maskSecrets(userMessage.slice(0, MAX_USER_MSG_LEN)),
  agentAction: maskSecrets(extractActionSummary(agentResponse)),
  timestamp: new Date().toISOString(),
};
```
```ts
// src/agent/memory.ts — top
import { maskSecrets } from "./audit.js";
```
```ts
// src/agent/memory.ts:50-61
export async function appendHistory(entry: string): Promise<void> {
  const histPath = getHistoryPath();
  await fs.mkdir(path.dirname(histPath), { recursive: true, mode: 0o700 });

  const timestamp = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const line = `- ${timestamp}: ${maskSecrets(entry)}\n`;

  await fs.appendFile(histPath, line, { mode: 0o600 });
}
```
대안적으로 `maskSecrets`를 `src/security/secrets.ts`로 이동시켜 `audit.ts`가 그것을 re-export하는 구조도 가능합니다. M1 범위에서는 그냥 `agent/audit.ts`에서 가져오는 걸로 충분.

---

### M3. `SECRET_PATTERNS`에 adaria-ai 도메인 secrets 누락 (텔레그램 드롭은 OK)

- **Severity**: MEDIUM (deferrable to M2)
- **Category**: Security / Secret redaction coverage
- **File**: `src/agent/audit.ts:19-25`
- **Issue**: 포트하면서 텔레그램 패턴 `/bot\d+:[a-zA-Z0-9_-]+/g`을 삭제한 건 올바른 결정입니다(adaria-ai는 Slack 전용). 문제는 **adaria-ai가 곧 다루게 될 도메인 secrets**가 아직 리스트에 없다는 것입니다:
  - Google Service Account private keys: `-----BEGIN PRIVATE KEY-----`로 시작
  - App Store Connect JWT (ES256): `eyJ...`로 시작하는 3-part 토큰 (JWT 일반)
  - Google OAuth access tokens: `ya29.`으로 시작
  - ASO Mobile API key: 프로젝트 문서 확인 필요
  - Search Console 키 등
- **Impact**: M1 스코프에서는 OK — Slack/Anthropic 토큰만 다뤄집니다. M2 이후 collector가 붙기 시작하면 각 collector가 HTTP 에러를 `writeAuditLog(error.message)` 형태로 기록할 때 에러 바디 안에 JWT/Bearer 토큰이 포함될 수 있습니다.
- **Current code**:
```ts
const SECRET_PATTERNS: RegExp[] = [
  /xoxb-[a-zA-Z0-9-]+/g, // Slack bot token
  /xapp-[a-zA-Z0-9-]+/g, // Slack app token
  /ntn_[a-zA-Z0-9]+/g, // Notion API key
  /sk-ant-[a-zA-Z0-9-]+/g, // Anthropic API key
  /sk-[a-zA-Z0-9]{20,}/g, // Generic API key
];
```
- **Recommended fix**: M1에서는 **TODO 주석**만 남기고, 실제 확장은 M2 collector 포트 PR에서 처리합니다. 지금 투기적으로 정규식을 추가하면 collector가 필요로 하는 실제 포맷과 어긋날 위험.
```ts
const SECRET_PATTERNS: RegExp[] = [
  /xoxb-[a-zA-Z0-9-]+/g, // Slack bot token
  /xapp-[a-zA-Z0-9-]+/g, // Slack app token
  /ntn_[a-zA-Z0-9]+/g, // Notion API key
  /sk-ant-[a-zA-Z0-9-]+/g, // Anthropic API key
  /sk-[a-zA-Z0-9]{20,}/g, // Generic API key
  // TODO(M2): extend with Google service account keys, App Store Connect
  // JWTs (ES256, 3-part), Google OAuth ya29.* tokens, and any ASO Mobile /
  // Search Console keys once collectors are ported in M2.
];
```
체크리스트 M2 섹션에 "extend `audit.ts:SECRET_PATTERNS`" 항목을 추가해 놓으면 잊어버릴 위험이 줄어듭니다.

---

## Low Findings

### L1. `audit.ts`와 `session.ts`가 `ensureAdariaDir` 없이 불릴 때 ENOENT

- **Severity**: LOW
- **Category**: Robustness / Test ergonomics
- **File**:
  - `src/agent/audit.ts:52` `await fs.appendFile(AUDIT_PATH, ...)`
  - `src/agent/session.ts:59` `await fs.writeFile(SESSIONS_PATH, ...)`
- **Issue**: pilot-ai 원본의 `audit.ts`는 `fs.mkdir(logDir, { recursive: true })`로 방어선을 쳤는데 adaria-ai 포트에서 이 mkdir이 빠졌습니다(경로가 `$ADARIA_HOME` 바로 아래이기 때문에 타당한 단순화). `session.ts`도 동일 — save()는 바로 `fs.writeFile(SESSIONS_PATH, ...)`. 런타임 상 daemon 부팅 시 `loadConfig()` → `ensureAdariaDir()`가 먼저 돌아 문제없지만:
  - **단위 테스트**에서 `audit.ts`/`session.ts`를 직접 돌릴 때 `ensureAdariaDir`을 호출해 주는 것을 잊으면 ENOENT
  - **`adaria-ai doctor`** 같은 진단 커맨드가 `writeAuditLog`를 먼저 호출한 뒤 `ensureAdariaDir`을 부르면 첫 실행에서 실패. 실제로는 doctor가 `loadConfig`를 먼저 호출할 가능성이 높지만 계약으로 강제되지는 않음.
- **Impact**: 기능상 버그는 아님. 테스트 ergonomics와 defensive-coding 관점의 lint.
- **Recommended fix**: 두 모듈 모두 "parent dir은 ensureAdariaDir이 만든다"는 계약을 유지하되, 테스트 헬퍼가 해당 계약을 만족시킬 수 있도록 **`ensureAdariaDir`을 `config/store.ts`에서만 export하지 말고 `src/utils/paths.ts` 혹은 독립 모듈로 빼서 storage 레이어가 import해 쓸 수 있게** 고려. 지금 M1 범위에서는 테스트 세팅에서 `await fs.mkdir(TEST_HOME, { recursive: true, mode: 0o700 })` 한 줄로 해결하고 넘어가도 무방. 추가로 `audit.ts:43-55`의 JSDoc에 전제조건을 더 명확히 적어둡니다.
```ts
/**
 * Appends one JSON line to $ADARIA_HOME/audit.jsonl.
 *
 * **Preconditions:** `ensureAdariaDir()` must have been called earlier in
 * process startup so that $ADARIA_HOME exists and is chmod 0700. In tests,
 * ensure the temp ADARIA_HOME is mkdir'd before invoking this function.
 *
 * Creates the file with 0600 on first write.
 */
```

---

### L2. `extractActionSummary`의 반환 길이가 문서화된 `MAX_ACTION_LEN`을 최대 3자 초과

- **Severity**: LOW
- **Category**: Code Quality / 주석 정확성
- **File**: `src/agent/conversation-summary.ts:103-112`
- **Issue**: `MAX_ACTION_LEN = 800`이고 인터페이스 주석은 `"agentAction: truncated to ~800 chars"`로 수정되어 있는데, 실제 경로는:
  1. `const truncated = result.slice(0, MAX_ACTION_LEN);` → 정확히 800자
  2. `return truncated + "...";` → 803자
  이 정도 오차는 허용 가능하지만 `MAX_ACTION_LEN` 정의를 그대로 믿고 DB 컬럼 크기를 맞추는 호출부가 생기면 경계 조건에서 한 글자씩 넘칩니다. pilot-ai에서도 같은 동작이라 이전 코드 호환은 유지됨.
- **Impact**: 현재 turn은 JSON 파일에 쓰이므로 길이 초과의 실질적 피해 없음.
- **Recommended fix**: 800을 hard cap으로 쓰고 싶다면 `"..."`를 넣기 전에 `MAX_ACTION_LEN - 3` slice.
```ts
if (lastSep > MAX_ACTION_LEN * 0.5) {
  return truncated.slice(0, lastSep);
}
return truncated.slice(0, MAX_ACTION_LEN - 3) + "...";
```
또는 주석을 `"soft cap, may exceed by 3 for '...' suffix"`로 문서화.

---

### L3. `extractKeyDecisions`의 `(.{10,100}?)[.!\n]` 패턴이 입력 모양에 따라 O(n·m) 스캔

- **Severity**: LOW
- **Category**: Performance / ReDoS 리스크 (현재 실제 위협 없음)
- **File**: `src/agent/conversation-summary.ts:137-138`
- **Issue**: ReDoS 패턴 분석:
  - `/(?:❌|✅|⚠️|Error:|Success:|Failed:|Warning:).*/g` — 선형, 안전
  - `/commit [0-9a-f]{7,}.*/gi` — 선형, 안전
  - `/(?:Writing|...)\s+([\w./-]+\.\w+)/gi` — 인접 문자클래스 `[\w./-]` vs `\w`는 overlap 있지만 선형 bounded, 안전
  - `/commit\s+[0-9a-f]+\s*[—–-]\s*(.+)/gi` — 선형, 안전
  - `/(?:Created|Deleted|...|Refactored)\s+(.{10,100}?)[.!\n]/g` — **여기가 유일한 관심사**. lazy quantifier + terminator 조합이라 각 매칭 실패 시 다음 시작점으로 이동해야 하는데, verb 접두사(`Created` 등)가 없는 위치에서는 즉시 실패하므로 실전 위험 없음. 다만 verb가 많이 반복되는 인풋(예: LLM이 "Created X. Created Y. Created Z. ..."를 길게 뿜어낸 응답)에서는 quadratic 경향이 있음.
- **Impact**: Claude 응답은 보통 <10KB. M6 이후 에이전트 루프로 긴 transcript가 전달되는 경로가 생겨도 실무 위험 없음. Pilot-ai가 이미 프로덕션에서 쓰고 있는 regex set이라 베이스라인 검증 완료.
- **Recommended fix**: 지금은 건드리지 말고 주석만 남김. M6 agent loop 단계에서 long-context 경로가 생기면 벤치.
```ts
// Note: action-verb pattern uses lazy `.{10,100}?` + terminator. Linear
// per successful match, but can become O(n·m) if the input contains many
// verb prefixes with no sentence terminator within 100 chars. Safe for
// typical (<100KB) Claude text; revisit if used on concatenated transcripts.
```

---

## Info / Observations

### I1. `extractActionSummary`의 인터페이스 JSDoc가 이미 수정됨

`TurnSummary.agentAction` 주석이 `"truncated to 300 chars"`(pilot-ai) → `"truncated to ~800 chars"`(adaria)로 업데이트되어 있습니다. 놓치기 쉬운 디테일인데 정확히 반영했습니다. 좋은 포트.

### I2. `session.ts`가 `exactOptionalPropertyTypes`와 잘 맞음

원본에 있던 `projectPath?: string`이 제거되면서 `SessionEntry`의 모든 필드가 required가 되었습니다. `exactOptionalPropertyTypes: true` 하에서 optional 필드 제거는 생성자 호출부의 분기 로직을 없애는 좋은 단순화입니다. `createSession(platform, channelId, threadId)`도 파라미터가 3개로 줄었고 타입이 `platform: "slack"` 리터럴로 좁혀져 M1 정책과 일치.

### I3. `conversation-summary.ts:225`의 `noUncheckedIndexedAccess` 대응

```ts
for (let i = 0; i < summary.turns.length; i++) {
  const turn = summary.turns[i];
  if (!turn) continue;
  // ...
}
```
`summary.turns[i]`가 `TurnSummary | undefined`로 타이핑되는 것에 대해 `if (!turn) continue;` 가드를 추가했습니다. pilot-ai 원본에는 이 가드가 없었으므로 해당 방향의 포팅 적응은 올바릅니다.

---

## Positive Observations

1. **Project-scoped 제거가 깔끔함**: `projectPath`, `readProjectMemory`, `writeProjectMemory`, `buildMemoryContext(projectName?)` 등 project-concept가 완전히 사라졌습니다. `grep -i project src/agent`가 주석 3줄("project-scoped memory from pilot-ai is dropped" 설명)만 찾는 상태로 이상적.
2. **텔레그램 제거가 일관됨**: `session.ts`의 `platform: "slack" | "telegram"` → `"slack"`, `audit.ts`의 텔레그램 bot token 정규식 삭제. Mode B에서도 slack-only.
3. **경로 해소의 일관성**: 네 모듈 모두 `src/utils/paths.ts`의 top-level 상수를 import하며, runtime에 `ADARIA_HOME`을 재조회하지 않습니다. 이는 `tests/utils/logger.test.ts`의 "set env → dynamic import" 패턴과 완벽히 호환됩니다(vitest의 파일-단위 워커 격리 덕분). 내부에 lazy path getter(예: `getMemoryDir()` 함수 호출)가 없어서 `resetSessionStore()`가 필요한 상황도 명확합니다.
4. **세션의 TTL + turnCount 이중 만료**: pilot-ai의 24h TTL과 10턴 한계를 그대로 유지. context overflow 방어 의도가 명확하고 주석도 유지.
5. **`resetSessionStore()` 테스트 훅**: 모듈 레벨 `loadPromise` 캐싱이 있음에도 테스트에서 깨끗하게 리셋할 수 있도록 test-only export가 보존됨.
6. **`saveSummary`의 0600 모드**: `fs.writeFile`의 `{ mode: 0o600 }` 명시. (다만 M1의 `fs.mkdir` 빠짐은 M1 참조.)
7. **경로 추가의 적합성**: `paths.ts`에 `MEMORY_DIR`, `CONVERSATIONS_DIR`만 추가하고 그 외는 건드리지 않았음. 최소 변경 원칙 준수.

---

## Data Flow Integrity Check

M1 스코프이므로 core.ts 연동은 평가 대상 아님. 다만 세 storage 경로가 M5/M6에서 다음과 같이 물릴 예정임을 기억해야 합니다:

```
session.ts         ← core.handleMessage (Mode B session lookup, turn increment)
                   ← claude.ts (session ID 전달)
conversation-summary.ts ← core.handleMessage (msg_too_long fallback 시점에 읽기)
                        ← claude.ts (에러 후 fresh session 복구)
memory.ts          ← core.handleMessage (system prompt builder)
audit.ts           ← 거의 모든 쓰기 경로 (command, execution, result, error, approval)
```

M2 이후 각 collector가 외부 API 에러를 던질 때 `writeAuditLog(error.message)`를 호출하면 **M3 findings**(도메인 secret redaction)가 구체적 이슈로 드러나므로 M2 PR 리뷰에서 반드시 확인이 필요합니다.

---

## Two-mode Routing Integrity

N/A — `src/agent/core.ts`, `src/skills/`, `src/tools/`가 이 PR 스코프에 없음. M1 이후 core.ts 포트 PR에서 다시 검증.

---

## Action Items

- [ ] **M1 (MEDIUM)** `src/config/store.ts:ADARIA_SUBDIRS`에 `MEMORY_DIR`, `CONVERSATIONS_DIR`(+ `MEMORY_HISTORY_DIR`) 추가. memory.ts와 conversation-summary.ts의 모든 `fs.mkdir` 호출에 `mode: 0o700` 명시. `writeUserMemory`와 `appendHistory`의 `fs.writeFile`/`fs.appendFile`에 `mode: 0o600` 명시.
- [ ] **M2 (MEDIUM)** `audit.ts`에서 `maskSecrets`를 재사용. `conversation-summary.ts:updateConversationSummary`에서 `userMessage`와 `extractActionSummary(agentResponse)` 결과에 적용. `memory.ts:appendHistory`에도 적용.
- [ ] **M3 (MEDIUM, deferrable to M2 milestone)** `audit.ts:SECRET_PATTERNS`에 `TODO(M2)` 코멘트 추가하고 `docs/growth-agent/checklist.md`의 M2 섹션에 "extend SECRET_PATTERNS with Google SA keys / App Store Connect JWTs / Google OAuth tokens" 체크 아이템 추가.
- [ ] **L1 (LOW)** `audit.ts`와 `session.ts`의 JSDoc에 "precondition: ensureAdariaDir()" 명시 확장.
- [ ] **L2 (LOW)** `extractActionSummary`의 `return truncated + "..."`를 `truncated.slice(0, MAX_ACTION_LEN - 3) + "..."`로 바꾸거나 주석 보강.
- [ ] **L3 (LOW)** `extractKeyDecisions`의 action-verb 정규식 위 주석으로 "quadratic-ish under adversarial input, safe for <100KB" 주석 추가.

---

**Critical: 0, High: 0** — M1 진행 가능. 위 MEDIUM 3건을 같은 PR 또는 follow-up 커밋에서 처리한 뒤 스테이지 4(유닛테스트 작성)로 넘어가면 됩니다.
