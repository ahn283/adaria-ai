# Code Review: M1 port of `src/agent/claude.ts`

**Date**: 2026-04-12
**Scope**: `src/agent/claude.ts` (340 LOC), adapted from `/Users/ahnwoojin/Github/pilot-ai/src/agent/claude.ts`
**Milestone**: M1 (pilot-ai runtime import)
**Commit(s)**: uncommitted working tree (senior-code-reviewer stage of dev loop)

## Summary

포트 품질은 전반적으로 높다. pilot-ai의 런타임 본골 중 claude.ts는 가장 위험한 파일 중 하나인데 (spawn + stream-json + circuit breaker + session resume + thinking delta), 네 가지 의도적 변경이 모두 검증 가능한 근거를 가지고 있고 strict 컴파일러 플래그(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)에 맞춘 bracket-access 재작성도 미미한 허점 한 가지를 제외하면 깨끗하다. 다만 `claude.mode: 'api'` config 경로가 스키마에서는 여전히 허용되지만 런타임에서는 호출되지 않는 "죽은 분기"가 되어 있어, 사용자가 이 옵션을 켜면 baffling한 침묵/혼란을 일으킬 위험이 있다. 기본 타임아웃 120초는 M1의 ping/pong 용도로는 맞지만 M5.5 Mode B (MCP tool round-trip) 도달 시점에 재검토가 필요하다.

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 1 |
| MEDIUM | 3 |
| LOW | 4 |
| INFO | 3 |

**Overall Grade**: B+
**Milestone fit**: M1 scope에 정확히 부합. 스킬 로직, MCP 툴 구현, orchestrator 어느 것에도 손대지 않았고 `core.ts` 와이어링도 별도 커밋으로 미뤄 두었다.

---

## 네 가지 변경 각각에 대한 평가

### 변경 1 — 기본 타임아웃 15분 → 120초

**결론: M1/M4 범위에서는 적절. M5.5 Mode B 도입 시점에 재검토 필요 (HIGH로 추적).**

pilot-ai의 15분 디폴트는 "agentic sub-task가 Bash/Write를 수십 회 돌리는" 유스케이스에 맞춰진 값이다. adaria-ai의 두 모드를 놓고 보면:

- **Mode A (M4~M5)**: `@adaria-ai aso fridgify`는 스킬 내부에서 `runClaude`를 호출하되, 스킬 쪽에서 각 프롬프트마다 명시적 timeoutMs를 넘겨야 한다. 현재 `AsoSkill`이 없으니 문제는 드러나지 않지만, M4 PR이 `timeoutMs`를 누락하면 120초 안에 끝나야 한다. 스킬 하나당 4개 프롬프트를 시리얼로 돌리는 growth-agent 패턴에서 각 프롬프트가 30초를 넘기면 곧바로 타임아웃이 날 수 있다.
- **Mode B (M5.5)**: Claude가 `db-query` → `collector-fetch` → 합성 답변을 수행할 때, 각 tool 호출마다 stdio round-trip이 발생한다. Slack 응답형 채팅에서 1~2회 round-trip이면 보통 60초 내외지만, `collector-fetch` 가 `fresh: true`로 App Store Connect/ASOMobile을 히트하면 20~30초는 쉽게 소진된다. 2회 round-trip + 합성이 120초를 초과할 가능성이 있다.
- **Weekly orchestrator (M6)**: checklist 주석대로 `15 * 60 * 1000`을 명시적으로 패스한다면 OK.

120초 디폴트 자체는 합리적이지만, **M5.5 진입 시점에 Mode B 경로에서 평균/95퍼센타일 지연을 실측해 300초 또는 180초로 조정할 가능성**을 남겨두어야 한다. 지금은 이 파일에 `DEFAULT_TIMEOUT_MS` 상수가 하드코딩되어 있어서, 런타임에 `config.claude.timeoutMs` (schema.ts:27)가 있음에도 불구하고 `invokeClaudeCli` 호출부에서 명시적으로 패스하지 않으면 config 값이 반영되지 않는다. **이게 HIGH 항목 H1로 따로 적었다.** (→ Finding H1)

### 변경 2 — `cwd` 파라미터 드롭

**결론: 안전.**

pilot-ai의 `cwd`는 사용자가 "use project foo" 같은 명령으로 Claude를 해당 프로젝트 디렉터리에 바인드하는 용도였다 (pilot-ai의 core.ts는 `projectPath`를 세션에 저장한다). adaria-ai는:

1. 유저가 있을 프로젝트 개념이 없다 — `@adaria-ai aso fridgify`의 "fridgify"는 `apps.yaml` entry 키지, 파일시스템 경로가 아니다.
2. 헤드리스 launchd에서 실행되므로 cwd는 launchd가 지정하는 경로(실제로는 `/`)가 기본값이 된다. 어차피 Claude가 Bash 툴을 쓸 일도 거의 없고, 쓰더라도 `adaria-ai`의 marketing MCP 툴 host를 통해야 한다.
3. `getSession`에서 `projectPath` 필드 제거는 이미 M1 storage review (storage.md §I2)에서 검증됨.

단, `--cwd`는 Claude CLI가 MCP stdio 서버를 spawn할 때 working directory를 결정한다. M5.5에서 `mcp-launcher`가 tool host를 spawn하는 방식에 따라, tool host가 상대경로로 파일을 열면 예상 밖 디렉터리에서 열릴 수 있다. 지금 `mcp-launcher.buildToolHostServerConfig`를 안 봤지만, pilot-ai의 이전 설계처럼 절대경로를 쓰고 있으면 문제 없다. M5.5 review 때 `mcp-launcher`를 다시 볼 때 이 각주를 남긴다. (→ INFO I1)

### 변경 3 — `DEFAULT_ALLOWED_TOOLS` 드롭

**결론: 안전하고 정합적이다. 삭제 OK.**

검증한 사실:

- pilot-ai 본체에서 `DEFAULT_ALLOWED_TOOLS`는 **정의만 되고 한 번도 import되지 않는다**. `grep -r DEFAULT_ALLOWED_TOOLS /Users/ahnwoojin/Github/pilot-ai/src`는 `claude.ts:51` 한 줄만 찍는다. 즉 pilot-ai 안에서도 데드 코드였고, 본인의 주석 (L163-166)이 `--allowedTools`는 `--dangerously-skip-permissions`와 버그가 있어 안 쓴다고 명시한다.
- adaria-ai에도 어떤 파일도 해당 심볼을 참조하지 않는다 (`docs/` 검색 결과 없음, `src/` 검색 결과 이 파일 외 0개).
- `allowedTools?: string[]` 필드도 `ClaudeCliOptions`에서 같이 드롭되었는데, pilot-ai가 이를 내부에서조차 쓰지 않았으므로 API surface 축소로 깨끗한 정리다.

주석 L220-223에 `// NOTE: --allowedTools is intentionally NOT used.` 명시적 코멘트가 유지되어 있어 미래의 포터가 같은 삽질을 반복하지 않을 수 있다.

### 변경 4 — `invokeClaudeApi` + `@anthropic-ai/sdk` import 드롭

**결론: 기술적으로는 맞지만, 사용자-직면 UX가 baffling하게 실패한다. HIGH 항목 H1로 수정 필요.**

검증한 사실:

- `src/config/schema.ts:22`에서 `mode: z.enum(["cli", "api"]).default("cli")` 로 `'api'`가 여전히 유효한 입력.
- `tests/config/schema.test.ts:48-55`는 **`{ mode: "api", apiKey: "sk-ant-xxx" }`이 파싱을 통과해야 한다는 어서션을 실제로 걸고 있다**. 이 테스트는 현재 통과한다 (스키마 수준에서는).
- 그러나 `src/agent/claude.ts`는 `mode` 필드를 아예 읽지 않는다. `invokeClaudeCli`는 무조건 CLI를 spawn한다.
- `core.ts`가 아직 와이어되지 않아서 "`mode === 'api'` → `invokeClaudeApi` 분기" 코드가 존재하지 않는다. **사용자가 config.yaml에 `mode: api`를 적으면 경고 없이 CLI로 fall-through한다.** `apiKey`가 있건 없건 CLI 인증 상태에 따라 동작하는데, 이 시점에 Claude CLI가 로그아웃 상태라면 에러 메시지는 "Claude CLI error (exit 1): ..." 같은 CLI-레벨 메시지가 뜨고, 유저는 "mode: api로 설정했는데 왜 CLI를 찾느냐"라고 혼란에 빠진다.

이건 CRITICAL은 아니다 (v1에서 `mode: api`를 쓰는 사용자가 실제로는 없을 것이고, 데이터 유실도 아니다). 그러나 Stage 7 "milestone fit" 관점에서, config schema가 허용하는 값이 런타임에서 무음 오동작을 일으키는 것은 "defensive init" 방침에 반한다. **H1에 수정 권고.**

---

## HIGH Findings

### H1. `claude.mode: 'api'`가 런타임 죽은 분기 + `config.claude.timeoutMs`가 `invokeClaudeCli`에 전달되지 않음
- **Severity**: HIGH
- **Category**: Config-runtime divergence / Defensive init / UX
- **File**: `src/agent/claude.ts:70` + `src/config/schema.ts:22-27`
- **Issue**:
  1. `mode: 'api'`는 스키마가 허용하지만 런타임 코드가 `mode`를 읽지 않는다. `tests/config/schema.test.ts:48-55`는 이 구성이 valid라고 명시적으로 어서트하기까지 한다. 사용자가 `~/.adaria/config.yaml`에 `claude: { mode: api, apiKey: sk-ant-xxx }`를 쓰면 adaria-ai는 조용히 CLI로 fall-through한다.
  2. 별개로, `DEFAULT_TIMEOUT_MS = 120_000`이 하드코딩되어 있어 `config.claude.timeoutMs` (사용자가 config에서 튜닝 가능한 값)가 기본적으로 무시된다. 호출부에서 명시적으로 `timeoutMs: config.claude.timeoutMs` 를 넘기지 않으면 config 값이 반영되지 않는다. M6 weekly가 `15 * 60 * 1000`을 별도로 패스해도, 사용자가 config에서 180초로 올려도 반영이 안 된다.
- **Impact**:
  - (1)은 "왜 안 되지"로 30분 태운다. (2)는 튜닝 노브가 달려 있는데 돌아가지 않는다. 두 건 모두 M5.5 Mode B 응답이 평균 120초에 근접할 때 체감된다. 지금 안 고치면 `config.claude.timeoutMs`를 읽는 모든 호출부 (core.ts + 각 skill)가 반복적으로 같은 값을 패스하는 보일러플레이트가 된다.
- **Current code** (`src/agent/claude.ts:70`):
  ```typescript
  export const DEFAULT_TIMEOUT_MS = 120_000;
  ```
  그리고 `invokeClaudeCliInner` 라인 177에서 `timeoutMs = DEFAULT_TIMEOUT_MS`.
- **Recommended fix**:
  M1에서는 `claude.ts`가 config를 직접 보지 않는 원칙을 유지하되, (a) mode='api'를 식별 가능한 런타임 에러로 바꾸고, (b) config-driven timeout을 쉽게 주입할 수 있게 한다.

  ```typescript
  // src/agent/claude.ts
  /**
   * Fallback timeout when the caller passes no explicit value AND config
   * does not override. 120 s is tuned for reactive Slack calls. The
   * weekly orchestrator (M6) overrides this per-call.
   */
  export const DEFAULT_TIMEOUT_MS = 120_000;

  /**
   * Thrown when the caller asks for mode: 'api' — not supported in M1
   * through Mx (see docs/growth-agent/porting-matrix.md "invokeClaudeApi
   * dropped" row). Surfaced via doctor.ts so users get an actionable
   * message instead of a silent CLI fall-through.
   */
  export class ClaudeApiModeNotSupportedError extends Error {
    constructor() {
      super(
        "config.claude.mode = 'api' is not supported in adaria-ai v1. " +
        "Set mode: cli or remove the field. See docs/growth-agent/porting-matrix.md.",
      );
      this.name = "ClaudeApiModeNotSupportedError";
    }
  }
  ```

  Then wire the check into `doctor.ts` and `core.ts` at their load points (not in this PR — add a TODO note in the claude.ts header referencing the next PR). And update the failing schema test expectation:

  ```typescript
  // tests/config/schema.test.ts — replace the "accepts api mode" test
  it("accepts api mode at schema level but is rejected at runtime (M1)", () => {
    const parsed = configSchema.parse({
      ...BASE,
      claude: { mode: "api", apiKey: "sk-ant-xxx" },
    });
    // Schema remains permissive for forward compatibility with a
    // future API fallback. Runtime rejection is tested in
    // tests/agent/claude.test.ts (added in the core.ts wiring PR).
    expect(parsed.claude.mode).toBe("api");
  });
  ```

  또는 더 단순하게, **스키마 자체에서 `mode: 'api'`를 지금 당장은 거부하도록** 바꾸고 forward-compat 주석은 유지. 이쪽이 더 defensive하다:

  ```typescript
  // src/config/schema.ts
  export const claudeConfigSchema = z.object({
    // NOTE: 'api' enum value reserved for a future milestone when the
    // Anthropic SDK fallback is re-added. M1-M9 only support 'cli'.
    mode: z.literal("cli").default("cli"),
    // ...
  });
  ```
  그리고 `tests/config/schema.test.ts:48-55` 테스트는 `expect(result.success).toBe(false)` 로 바꾼다.

  어느 쪽이든 **스키마와 런타임이 합의해야 한다**. 지금 상태는 "schema says yes, runtime pretends nothing happened"라서 CLI/API 선택권이 사용자에게 있다는 환상을 만든다.

  Timeout propagation도 같이 처리: `core.ts` wiring PR에서 `const cfg = loadConfig(); invokeClaudeCli({ ..., timeoutMs: cfg.claude.timeoutMs })` 패턴을 모든 호출부에 적용하거나, claude.ts에 "config-aware" wrapper (`invokeClaudeCliWithConfig(config, opts)`)를 추가하는 것이 더 깔끔하다. M1 범위에서는 TODO 주석만 남기고 M1 core.ts PR에서 해결해도 된다.

---

## MEDIUM Findings

### M1. 1MB / 512KB 라인 버퍼 rollback이 `tool_use` 이벤트를 통째로 잘라낼 수 있음 (pilot-ai에도 있는 동일 결함)
- **Severity**: MEDIUM
- **Category**: Data flow / stream parsing robustness
- **File**: `src/agent/claude.ts:252-273`
- **Issue**: `lineBuffer.length > 1_048_576` 일 때 `lineBuffer = lineBuffer.slice(-524_288)`. 이는 버퍼가 NDJSON stream의 한가운데 있을 때 임의의 JSON object 중간에서 앞쪽 절반을 버린다는 뜻이다. rollback 이후 처음 나오는 `\n`을 찾아 split하는데, 그 `\n`이 어떤 JSON object 한가운데의 escaped newline (문자열 안) 혹은 중간 지점일 확률이 높다. 잘린 라인은 `JSON.parse`에서 실패 → `catch {}` 경로로 조용히 버려진다.
  - M1/M4 reactive path: 응답 크기가 작아서 절대 안 터진다.
  - **M6 weekly orchestrator**: 긴 분석 프롬프트는 수 MB의 thinking delta + tool_use 스트림을 낼 수 있다. 1MB를 넘기는 순간 tool_use 이벤트가 손실되면 `onToolUse` 콜백이 호출되지 않아 Slack status message가 "running…"에 멈춘 채로 유저는 뭐가 되고 있는지 모른다. 최종 결과 (`stdout` 누적) 자체는 영향을 받지 않는다 — 실시간 콜백만 손상된다.
- **Impact**: 파싱 실패는 silent (catch 블록이 로그도 안 남긴다). 유저 체감: "긴 분석 돌리면 진행 표시가 멈춘다."
- **Current code**:
  ```typescript
  if (lineBuffer.length > 1_048_576) {
    lineBuffer = lineBuffer.slice(-524_288);
  }
  const lines = lineBuffer.split("\n");
  lineBuffer = lines.pop() ?? "";
  ```
- **Recommended fix**: rollback 시점에 **마지막 `\n`까지만 자른다**. 그 뒤부터는 유효한 라인 경계에서 시작하는 것이 보장된다.
  ```typescript
  if (lineBuffer.length > 1_048_576) {
    // Truncate to last valid newline boundary to preserve parseability.
    // Dropping 512KB+ of stream is an acceptable trade to keep
    // onToolUse callbacks firing on the remaining events.
    const lastNewline = lineBuffer.lastIndexOf("\n", lineBuffer.length - 1);
    lineBuffer =
      lastNewline >= 0 ? lineBuffer.slice(lastNewline + 1) : "";
    logError(
      "[claude-cli] stream buffer exceeded 1MB; truncated at last line boundary",
    );
  }
  ```
  그리고 truncation 이벤트 자체를 `logError`로 남기는 것이 중요하다 — 지금은 silent drop이다. growth-agent와 pilot-ai 둘 다 같은 허점이 있었는데, M6가 오기 전에 고칠 수 있는 좋은 기회다.

### M2. `logError(stderr)` 경유로 MCP 서버 stderr가 secrets를 노출할 위험 + daily 로그 파일 0600 퍼미션 미보장
- **Severity**: MEDIUM
- **Category**: Security / A04 Cryptographic Failures / A09 Logging
- **File**: `src/agent/claude.ts:276-284`, `src/utils/logger.ts:63-68`
- **Issue**: stderr는 Claude CLI 및 spawn된 MCP 서버의 error output을 그대로 라인 단위로 `logError`로 내보낸다. MCP 서버가 auth 실패 에러를 "Authorization: Bearer sk-..." 혹은 "token=xxx" 형태로 stderr에 찍으면 그 문자열이 `$ADARIA_HOME/logs/adaria-YYYY-MM-DD.log`에 원문으로 저장된다. `logger.ts:63-68`은 `fs.appendFileSync(getLogFilePath(), line + "\n")`를 호출하지만 **파일 모드(0600)를 명시하지 않는다**. 로그 파일이 `0644`로 생성되면 같은 Mac의 다른 로컬 사용자가 읽을 수 있다.
  - pilot-ai는 `console.error`로만 찍어서 disk-at-rest 노출은 없었다. adaria-ai에서 파일 로깅으로 승격하면서 새 벡터가 생겼다 — M1은 **이 문제를 해결할 적기**다.
  - `security.auditLog.maskSecrets: true` 기본값이 있지만 이 플래그는 audit.jsonl을 위한 것이지 `adaria-YYYY-MM-DD.log`의 claude-cli stderr 라인에는 적용되지 않는다.
- **Impact**: 로그 파일 압류/탈취 시 MCP 서버 API 키, OAuth 토큰, Bearer 헤더가 원문으로 노출. 단일 사용자 Mac의 `0644`는 공격면이 작지만, `launchd`가 `UserName`을 키 root로 지정하지 않는 한 로컬 멀티유저 Mac에서 실제 위협이다.
- **Current code**:
  ```typescript
  // src/agent/claude.ts:276
  child.stderr.on("data", (data: Buffer) => {
    const chunk = data.toString();
    stderr += chunk;
    for (const line of chunk.split("\n")) {
      if (line.trim()) {
        logError(`[claude-cli] ${line}`);
      }
    }
  });
  ```
  ```typescript
  // src/utils/logger.ts:63-68
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(getLogFilePath(), line + "\n");
  } catch { ... }
  ```
- **Recommended fix**: **claude.ts 쪽**에서 최소한의 redaction을 한 뒤 `logError`로 보낸다. Stdlib 레벨에서는 Authorization/Bearer/sk-ant-/xoxb- 패턴 정도만 가리면 실사용 토큰 대부분을 커버한다.
  ```typescript
  // src/utils/redact.ts (new, or extend existing security/redact.ts if present)
  const SECRET_PATTERNS: Array<[RegExp, string]> = [
    [/Bearer\s+[A-Za-z0-9._\-]{16,}/gi, "Bearer [REDACTED]"],
    [/Authorization:\s*\S+/gi, "Authorization: [REDACTED]"],
    [/sk-ant-[A-Za-z0-9_\-]{16,}/g, "sk-ant-[REDACTED]"],
    [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "xox[REDACTED]"],
    [/(token|apiKey|api_key|secret)["'=:\s]+[A-Za-z0-9_\-]{8,}/gi,
      "$1=[REDACTED]"],
  ];

  export function redactSecrets(line: string): string {
    let out = line;
    for (const [re, repl] of SECRET_PATTERNS) {
      out = out.replace(re, repl);
    }
    return out;
  }
  ```
  ```typescript
  // src/agent/claude.ts — stderr handler
  import { redactSecrets } from "../utils/redact.js";
  // ...
  child.stderr.on("data", (data: Buffer) => {
    const chunk = data.toString();
    stderr += chunk;
    for (const line of chunk.split("\n")) {
      if (line.trim()) {
        logError(`[claude-cli] ${redactSecrets(line)}`);
      }
    }
  });
  ```
  그리고 **`logger.ts`에서 파일 생성 시 0600 강제**:
  ```typescript
  // src/utils/logger.ts:63-68
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
    // O_APPEND | O_CREAT with explicit mode, not relying on umask.
    const fd = fs.openSync(getLogFilePath(), "a", 0o600);
    try {
      fs.writeSync(fd, line + "\n");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // best-effort logging
  }
  ```
  이 두 변경은 logger.ts 리뷰가 이미 끝났다면 별도 mini-PR로 뽑는다. 지금 이 claude.ts 리뷰의 range 밖이지만 같은 지적을 M1b utils-port review에서 이미 했는지 확인할 가치가 있다. (→ Action items 하단)

  **변경 이유 재확인**: pilot-ai는 console.error만 썼기 때문에 기본적으로 "프로세스가 살아있을 때 터미널에서 사라짐"에 의존한 보안 가정이었다. 파일 로깅으로 승격하면 그 가정이 깨진다 — 이게 M1의 의도된 개선 포인트인지 확인해볼 여지가 있다.

### M3. `describeToolUse` `mcp__adaria__` 프리픽스 strip — 일관적 UX OK, 그러나 `🔧` 이모지만 나와서 "MCP vs built-in" 구분이 사라진다
- **Severity**: MEDIUM
- **Category**: UX / Observability
- **File**: `src/agent/claude.ts:146-148`
- **Issue**: `mcp__adaria__db-query` → `🔧 Using db-query...`로 렌더링된다. 이는 built-in `Read`/`Write`/`Glob`가 내는 `📖/✏️/🔍`와 시각적으로 섞여버린다. Slack 유저 입장에서 "이게 로컬 파일 읽는 중인지, DB 조회 중인지" 구분하기 어렵다. 그리고 `db-query`는 Mode B에서 가장 자주 불리는 MCP 툴이 될 것이므로 눈에 띌 이모지가 있는 편이 좋다.
- **Impact**: 기능적 버그는 아니다. UX 품질의 문제. 유저가 "`🔧 Using db-query`가 뜬 뒤 뭘 하는 건지 모르겠다"고 묻는 상황을 만든다.
- **Current code**:
  ```typescript
  default:
    if (toolName.startsWith("mcp__adaria__")) {
      return `🔧 Using ${toolName.slice("mcp__adaria__".length)}...`;
    }
    return `🔧 Using ${toolName}...`;
  ```
- **Recommended fix**: MCP 툴마다 최소한의 "어떤 종류 동작인지" 힌트 이모지를 붙인다. id별 switch로 하거나 prefix matching으로.
  ```typescript
  default:
    if (toolName.startsWith("mcp__adaria__")) {
      const mcpId = toolName.slice("mcp__adaria__".length);
      switch (mcpId) {
        case "db-query":
          return `🗄️ Querying DB...`;
        case "collector-fetch":
          return `📡 Fetching collector data...`;
        case "skill-result":
          return `📊 Reading prior analysis...`;
        case "app-info":
          return `📱 Reading apps.yaml...`;
        default:
          return `🔧 Using ${mcpId}...`;
      }
    }
    return `🔧 Using ${toolName}...`;
  ```
  이 4가지 MCP tool id는 이미 `docs/growth-agent/milestones.md:130-140` M5.5 섹션에 확정되어 있으므로 지금 하드코딩해도 안전하다. 향후 새 tool이 추가되면 default fall-through로 빠진다.

---

## LOW Findings

### L1. `parseStreamEvent`의 중첩 `msg.message.content` 경로가 pilot-ai의 null-coalesce 제스처와 정확히 동일하지 않다
- **Severity**: LOW
- **Category**: Type safety / Subtle semantics
- **File**: `src/agent/claude.ts:319-324`
- **Issue**: 원본 pilot-ai는 `(msg as ClaudeJsonMessage).content ?? ((msg.message as ...)?.content as ...)`로 **첫 번째가 falsy**일 때만 wrapped를 본다. adaria-ai 버전은:
  ```typescript
  const topContent = (msg as ClaudeJsonMessage).content;
  const wrapped = msg["message"] as Record<string, unknown> | undefined;
  const nestedContent = wrapped?.["content"] as ClaudeJsonMessage["content"] | undefined;
  const content = topContent ?? nestedContent;
  ```
  의미적으로 동일하다 (둘 다 nullish coalesce). **다만 `topContent`가 `undefined`가 아니고 빈 배열 `[]`이라면**, pilot-ai와 adaria-ai 모두 `[]`를 쓰고 `wrapped.content`를 보지 않는다 — 이는 양쪽 동일한 (올바른) 동작이다. 리팩터링 자체는 문제 없다.

  한 가지 미묘한 점: 원본 pilot-ai는 `(msg as ClaudeJsonMessage).content`를 사용했는데, 이 cast는 `msg` 타입이 `Record<string, unknown>`임에도 `ClaudeJsonMessage`로 간주하여 `content` 필드에 접근한다. adaria-ai 버전은 같은 cast를 쓰되 `wrapped?.["content"]`는 bracket-access로 더 보수적이다. `exactOptionalPropertyTypes` 하에서 이 혼용이 실수는 아니지만 일관성 면에서 둘 다 bracket-access로 통일할 수 있다.
- **Impact**: 런타임 동작 차이 없음. 스타일/일관성 문제.
- **Recommended fix**: 작은 것이지만 일관성을 원한다면:
  ```typescript
  const topContent = msg["content"] as ClaudeJsonMessage["content"] | undefined;
  ```
  이 자체로도 cast이므로 더 좋아진다고 말하기는 어렵다. **skip 가능 (LOW이므로).**

### L2. `parseClaudeJsonOutput`에서 같은 assistant 메시지의 top-level `content`와 nested `message.content`가 동시 존재하면 텍스트 중복 출력
- **Severity**: LOW
- **Category**: Correctness / Edge case
- **File**: `src/agent/claude.ts:365-386`
- **Issue**: 같은 라인에 대해 두 개의 `if (msg.type === "assistant" && ...)` 블록이 **else-if가 아니라 독립 if로 연결**되어 있다. 스트림 포맷 상 한 메시지가 top-level `content`와 nested `message.content`를 둘 다 가질 일은 일반적으로 없지만, Claude Code CLI가 legacy/stream-json을 mix해서 내보내는 드물고 개발중인 버전에서 실제로 목격된 적이 있다 (pilot-ai git log에서 언급된 적 있음). 그 경우 같은 텍스트가 두 번 push된다.
- **Impact**: 극히 드문 CLI 버전에서 응답 텍스트 duplication. 원본 pilot-ai에도 같은 패턴이 있으니 regression은 아니다.
- **Recommended fix** (옵션):
  ```typescript
  if (msg.type === "assistant") {
    const topContent = Array.isArray(msg.content) ? msg.content : undefined;
    const wrapped = msg["message"] as Record<string, unknown> | undefined;
    const nestedContent = Array.isArray(wrapped?.["content"])
      ? (wrapped?.["content"] as Array<{ type: string; text?: string }>)
      : undefined;
    const content = topContent ?? nestedContent;
    if (content) {
      for (const block of content) {
        if (block.type === "text" && block.text) {
          texts.push(block.text);
        }
      }
    }
  }
  ```
  `parseStreamEvent`가 이미 이 패턴을 쓰니 `parseClaudeJsonOutput`도 통일하는 것이 DRY에 맞다.

### L3. `getClaudeCircuitState`의 `ReturnType<CircuitBreaker["getState"]>` 리턴 타입
- **Severity**: LOW
- **Category**: Type design / API surface
- **File**: `src/agent/claude.ts:154`
- **Issue**: `ReturnType<CircuitBreaker["getState"]>`는 기술적으로 `CircuitState` 타입과 동일하다 (`utils/circuit-breaker.ts:1`). **단순히 `CircuitState`를 import해서 쓰면 된다.** `ReturnType<>`은 함수 시그니처를 추적하기 위한 메커니즘인데 여기서는 concrete type alias가 이미 존재하므로 추상화가 과하다. 또한 `doctor.ts`(M1 후반에 포팅 예정)에서 이 리턴값을 소비할 때, IDE의 "go to definition"이 `circuit-breaker.ts`가 아니라 `claude.ts:154`로 튄다.
- **Impact**: 가독성/IDE navigation 경미한 저해. 동작 차이 없음.
- **Recommended fix**:
  ```typescript
  import type { CircuitState } from "../utils/circuit-breaker.js";
  // ...
  export function getClaudeCircuitState(): CircuitState {
    return claudeCircuit.getState();
  }
  ```

### L4. `Prompt goes via stdin to avoid OS arg-length limits` 주석이 문법이 없는 단독 문장으로 남아있음
- **Severity**: LOW
- **Category**: Style
- **File**: `src/agent/claude.ts:233`
- **Issue**: 한 줄짜리 주석 `// Prompt goes via stdin to avoid OS arg-length limits.`가 빈 줄로 띄워진 채 Promise 블록 앞에 있다. pilot-ai에도 있는 orphan 주석이지만, 지금 리팩터 기회에 관련 코드(`child.stdin.write(prompt)` 라인 245) 바로 위로 옮기는 것이 낫다.
- **Recommended fix**: 주석을 `child.stdin.write(prompt);` 바로 위로 이동.

---

## INFO Notes

### I1. `cwd` 드롭 관련, M5.5 `mcp-launcher` 리뷰에서 재확인할 것
(변경 2 섹션에서 언급) MCP stdio tool host가 spawn될 때 `cwd`가 launchd 기본값(`/`)이 되면, tool host 코드가 `require.resolve` 아닌 `import.meta.url` 기반으로 번들 에셋을 찾는지 M5.5 review에서 확인한다.

### I2. Circuit breaker 모듈 레벨 상태 공유
`const claudeCircuit = new CircuitBreaker(...)`가 모듈 탑레벨에 있어 **프로세스 내 모든 `invokeClaudeCli` 호출이 동일한 breaker 상태를 공유한다**. 프로덕션(daemon)에서는 정확히 원하는 동작 — 진짜로 Claude CLI가 죽었다면 모든 호출자가 빨리 실패해야 하니까. 반면 vitest 테스트에서는:
- 테스트 A가 circuit을 OPEN으로 뒤집은 뒤 clean-up 없이 끝나면, 테스트 B가 import된 `claudeCircuit`을 공유하여 실패한다.
- vitest는 module cache를 테스트 파일별로 분리하지만 **한 파일 안에서 여러 `it()`가 `invokeClaudeCli`를 fake-spawn하는 경우** 상태가 누수된다.

해결책은 exposing `resetClaudeCircuit()` 헬퍼. 지금 `CircuitBreaker.reset()`이 `utils/circuit-breaker.ts:81`에 이미 public으로 있으니 래퍼만 추가하면 된다:
```typescript
/** Test hook: reset the module-level breaker. Do not call from daemon code. */
export function resetClaudeCircuit(): void {
  claudeCircuit.reset();
}
```
지금은 필요 없다 (M1에 테스트 없음). M1c 테스트 작성 단계 직전에 추가하라.

### I3. `mode: 'api'` forward-compat 재도입 시 체크리스트
(변경 4 관련) 미래에 API mode를 재추가할 때 고려할 것:
- `@anthropic-ai/sdk` 의존성은 ~200KB이고 pilot-ai의 `invokeClaudeApi`(L333-357)는 고작 20 줄이었다. 의존성 추가 비용에 비해 얻는 이득이 적다. **그 대신 `fetch` 기반 얇은 클라이언트를 직접 쓰는 것이 npm 패키지 크기 관점에서 낫다.**
- API mode는 MCP 툴 지원이 없다 (Anthropic Messages API는 툴을 지원하지만 CLI의 `--mcp-config` stdio 서버와는 호환되지 않는다). 즉 API mode에서는 Mode B가 동작하지 않는다. 이 제약을 schema.ts 주석 + doctor.ts 경고에 명시해야 한다.
- **"forward-compat"를 위해 허용된 config 값은 defensive init 관점에서 안티패턴**이다. Schema.ts는 지금 지원 가능한 것만 허용하는 것이 철학에 맞다 (→ H1 recommended fix).

---

## Data Flow Issues

아직 `core.ts`가 와이어링되지 않아 `claude.ts` 단독으로는 data flow를 추적할 수 없다. 두 가지만 체크:

1. **`parseClaudeJsonOutput`의 return값이 최종 Slack 메시지 텍스트**: CLAUDECODE env 제거 후 `claude -p --output-format stream-json --verbose --dangerously-skip-permissions`의 stdout이 NDJSON으로 들어오고, 마지막 `result` 메시지 + assistant content를 `\n`으로 join. Mode A 스킬에서 Block Kit으로 감쌀 때 이 join된 텍스트 전체를 `section.text.text`에 넣으면 3000자 제한 걸릴 수 있다. Slack splitter는 이미 `src/messenger/split.ts`에 있으니 OK.
2. **`onToolUse` 콜백이 Slack status message 업데이트로 전달되는 경로**: M1에서 `core.ts`가 이 콜백을 Slack reaction/status 업데이트로 연결해야 한다. 이 리뷰 범위 밖이지만 claude.ts가 콜백을 정확한 시점에 호출하는지 검증은 M1c 테스트에서 한다.

---

## Positive Observations

1. **네 가지 의도적 변경이 모두 주석에 명시적으로 적혀 있음** (L4-20). 미래의 리뷰어/포터가 왜 이렇게 되어 있는지 추적할 수 있다. `DEFAULT_ALLOWED_TOOLS` 드롭 이유 (L163-166의 버그 주석 참조)도 유지되어 최악의 `--allowedTools + bypass` 조합을 다시 시도하지 않도록 방어선이 있다.
2. **`noUncheckedIndexedAccess` 대응 품질이 높다**. `parseStreamEvent`에서 `msg["type"]` / `wrapped?.["content"]` / `b["type"] === "tool_use" && typeof b["name"] === "string"` 순서로 narrow한 뒤 사용하는 패턴은 교과서적이고, M1b utils-port 리뷰에서 확인된 스타일과 일관적이다.
3. **CLAUDECODE env 제거가 `checkClaudeCliAuth`(L85-86)와 `invokeClaudeCliInner`(L236-237) 두 곳 모두에 적용되어 있다**. pilot-ai의 실전 검증 경로를 그대로 유지.
4. **세션 관리의 `--resume` 우선순위 주석**(L188-192)이 업데이트되어 "adaria-ai runs headless from launchd"라는 명시적 근거를 달고 있다 — pilot-ai의 일반적 문구보다 이쪽이 더 실행 컨텍스트를 드러낸다.
5. **`parseStreamEvent`와 `parseClaudeJsonOutput`이 export되어 단위 테스트 가능**. pilot-ai와 동일하지만 향후 M1c 테스트 작성 시 이 설계가 곧바로 값을 한다.
6. **circuit breaker 파라미터(failureThreshold: 3, resetTimeout: 120000) 유지**. 120초 circuit reset + 120초 default timeout가 일치하도록 우연히 정렬되어 있어 한 번 실패 burst가 나면 대략 같은 윈도에서 회복을 시도한다 — 의도하지 않았을 수 있지만 합리적 튜닝이다.

---

## Two-mode routing integrity

이 PR은 `core.ts`를 건드리지 않았으므로 Mode A/Mode B 라우팅 검증은 M1 core.ts wiring PR의 책임이다. **단, 이 PR이 라우팅에 영향을 줄 수 있는 지점**:

- `ClaudeCliOptions.mcpConfigPath?: string`이 존재하고 (L38), `invokeClaudeCliInner` 라인 229-231에서 값이 있을 때만 `--mcp-config`를 추가한다. Mode A (스킬 실행) 호출부는 `mcpConfigPath`를 넘기지 **않아야** 한다 — 스킬은 자기 프롬프트를 직접 구성하고 MCP 툴 없이 돌아간다. Mode B 호출부만 `mcpManager.writeMcpConfig()`의 결과를 여기에 패스한다. 이 invariant는 core.ts PR에서 검증.
- M1에서 `mcpManager.buildMcpConfig()`는 `{ mcpServers: {} }` 빈 객체를 반환한다 (mcp-manager.ts:144-148). 즉 config 파일이 존재하지만 서버가 없다. 이 상태에서 `--mcp-config`를 주면 Claude CLI가 어떻게 반응하는지는 M1 smoke test에서 확인해야 한다. 이 PR 범위 밖.

---

## Action Items

- [ ] **[H1]** `config.claude.mode = 'api'`의 런타임 처리 결정: **스키마를 `z.literal('cli')`로 좁히거나**, 런타임에 `ClaudeApiModeNotSupportedError`를 던진다. 동시에 `tests/config/schema.test.ts:48-55` 테스트를 결정에 맞게 수정. + `config.claude.timeoutMs`를 `invokeClaudeCli` 호출부에서 명시적으로 전달할지, 또는 `invokeClaudeCliWithConfig(config, opts)` wrapper를 claude.ts에 추가할지 결정. (M1 core.ts wiring PR에서 동시 처리 가능)
- [ ] **[M1]** `lineBuffer` rollback을 마지막 `\n` 경계까지만 자르도록 수정 + truncation 이벤트 로깅 추가. growth-agent/pilot-ai 공통 결함이므로 M6 weekly 전에 반드시 해결.
- [ ] **[M2]** `stderr` 라인에 secret redaction 적용 (`src/utils/redact.ts` 신규 또는 기존 security 모듈 확장) + `src/utils/logger.ts`의 `appendFileSync` 경로를 `fs.openSync(..., 0o600)`로 교체. 이 두 변경은 M1b utils-port review와 겹치는 영역이므로 거기서 아직 안 고쳐졌는지 먼저 확인.
- [ ] **[M3]** `describeToolUse` MCP 프리픽스 분기에 `db-query`/`collector-fetch`/`skill-result`/`app-info` id별 이모지를 붙인다.
- [ ] **[L2]** `parseClaudeJsonOutput`의 top-level vs nested content 경로를 `??`로 통일. `parseStreamEvent`와 동일 패턴.
- [ ] **[L3]** `getClaudeCircuitState` 리턴 타입을 `CircuitState`로 교체하고 `ReturnType<...>` 제거.
- [ ] **[L4]** L233 주석을 `child.stdin.write(prompt);` 바로 위로 이동.
- [ ] **[I2]** M1c 테스트 작성 직전에 `export function resetClaudeCircuit(): void` 추가.
- [ ] **[I1]** M5.5 mcp-launcher 리뷰 시 `cwd` 드롭의 tool host 영향 재확인.
