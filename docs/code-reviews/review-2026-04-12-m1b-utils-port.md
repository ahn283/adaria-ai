# Code Review: M1b — src/utils/ Port from pilot-ai

**Date**: 2026-04-12
**Reviewer**: Senior Code Review Agent
**Scope**: `src/utils/{circuit-breaker,rate-limiter,retry,escape,errors,logger,parse-json}.ts` + `tests/utils/*.test.ts` (7 files) + `package.json` lint script
**Commit(s)**: uncommitted (working tree)

## Summary

M1b 포트는 전반적으로 충실하고 안전합니다. 6개 util은 pilot-ai에서 거의 verbatim으로 옮겼고, `errors.ts`/`logger.ts`의 `exactOptionalPropertyTypes` 대응과 `parse-json.ts`의 JS→TS 변환은 모두 타당합니다. `grep -i pilot`이 src/와 tests/에서 완전히 비어 있어 도메인 리네이밍 누락은 없습니다. 다만 `buildErrorOptions` 헬퍼의 적용 범위 불일치, `retry.ts`의 unreachable code, parse-json 추출의 시간복잡도 등 몇 가지 짚어둘 포인트가 있습니다.

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 0 |
| Medium   | 2 |
| Low      | 3 |
| Info     | 4 |

## Medium & Low Priority Findings

### M1. `buildErrorOptions` 헬퍼가 서브클래스 생성자에서는 적용되지 않음
- **Severity**: Medium
- **Category**: Code Quality / 일관성
- **File**: `src/utils/errors.ts:28-96`
- **Issue**: `AdariaError` 생성자만 `buildErrorOptions(options?.cause)`를 통과하고, `AuthError`/`ToolError`/`ConfigError`/`ExternalApiError`/`TimeoutError` 서브클래스는 모두 `super(message, { code: ..., userMessage: ..., cause: options?.cause })` 형태로 `cause: undefined`를 명시적으로 포함해 부모로 전달합니다. 런타임 동작은 부모 생성자의 `!== undefined` 체크가 다시 한 번 걸러주기 때문에 올바르지만, 헬퍼의 의도("cause 필드 자체를 생략")가 한 레이어에서만 작동하므로 패턴이 부분적으로만 적용된 상태입니다.
- **Impact**: 기능적으로는 문제 없음. 단 M1c 이후 누군가 `AuthError`를 리팩터하며 중간 경로에서 `{ cause }`를 로깅/직렬화할 경우 `cause: undefined` 키가 남을 수 있다는 점에서 잠재적 혼동 여지가 있습니다.
- **Recommendation**: 서브클래스에서도 동일 패턴을 사용하도록 통일.
```ts
export class AuthError extends AdariaError {
  constructor(message: string, options?: ErrorCtorOptions) {
    super(message, {
      code: options?.code ?? "AUTH_ERROR",
      userMessage:
        options?.userMessage ??
        "Authentication failed. Please check your credentials.",
      ...(options?.cause !== undefined ? { cause: options.cause } : {}),
    });
    this.name = "AuthError";
  }
}
```
또는 더 깔끔하게, 서브클래스가 `ErrorCtorOptions`를 그대로 받되 `cause`만 헬퍼로 spread하는 내부 빌더를 쓰면 한 곳에서 관리 가능합니다. 지금은 AdariaError 단일 게이트 덕분에 실제 JSON 직렬화(`JSON.stringify`)에서는 `undefined`가 drop되므로 CRITICAL은 아닙니다.

### M2. `parseJsonResponse` 추출 루프의 최악 시간복잡도 O(n²)
- **Severity**: Medium
- **Category**: Performance
- **File**: `src/utils/parse-json.ts:19-58`
- **Issue**: 바깥 루프가 모든 `{`/`[` 후보를 시작점으로 삼고, 내부 루프가 매번 끝까지 스캔하므로 "긴 텍스트 + 여러 개의 false-positive 여는 괄호"가 있는 입력에서 O(n²)입니다. Claude 응답은 보통 짧지만(≤10KB), 체인 내에서 여러 step의 transcript를 하나로 합쳐 parse-json에 던지는 패턴이 생기면 급격히 비싸질 수 있습니다. 또한 현재 내부 루프는 `depth === 0`에 도달해 `JSON.parse` 실패 시 `break`하여 다음 시작점으로 넘어가는데, 이 경우 이미 스캔한 문자열 구조 정보(inString/escape 상태)를 버리므로 불필요한 재스캔이 발생합니다.
- **Impact**: 현 시점 M1b 범위에서는 이슈 아님(테스트 모두 <1ms). M1e에서 agent loop가 생기고 긴 컨텍스트를 전달하기 시작하면 다시 봐야 함.
- **Recommendation**: 지금은 그대로 두되, 주석으로 "extraction path is O(n²) worst-case; safe for typical LLM responses ≤ ~100KB"라는 가드레일을 남기는 것을 권장.
```ts
// Note: the fallback extraction path below is O(n²) worst-case.
// Safe for typical Claude text responses (< ~100KB); revisit if
// used on larger transcripts or concatenated step outputs.
```

### L1. `retry.ts`의 `throw lastError`는 unreachable
- **Severity**: Low
- **Category**: Code Quality
- **File**: `src/utils/retry.ts:52`
- **Issue**: `for` 루프는 `attempt >= opts.maxAttempts`가 되기 전까지 성공 시 `return`, 실패 시 `continue`(또는 `throw`) 중 하나만 가능하므로 루프 종료 후의 `throw lastError`에는 도달할 수 없습니다. `lastError`가 선언만 되어 있는 이유 역시 이 한 줄 때문.
- **Impact**: 없음(원본 pilot과 동일). ESLint `no-unreachable-loop` 류 룰이 꺼져 있어 통과.
- **Recommendation**: M1b는 "verbatim 포트"가 원칙이므로 이번엔 건드리지 말 것. M1d/e 단계에서 util 정리할 때 `let lastError`와 trailing throw를 같이 제거해도 좋음.

### L2. `escape.ts`의 `escapeAppleScript`는 adaria-ai에서 데드 코드
- **Severity**: Low
- **Category**: 코드 품질 / 포팅 정책
- **File**: `src/utils/escape.ts:5-11`, `tests/utils/escape.test.ts:4-38`
- **Issue**: macOS personal-agent 툴 일체를 드랍한 adaria-ai에서는 `escapeAppleScript`를 호출하는 곳이 M1 종료 시점까지 등장하지 않습니다. 테스트 8개도 함께 데드 웨이트.
- **Impact**: 번들 크기 영향 무시 가능(dist ~200 bytes). 유지보수 혼란 가능성은 있음.
- **Recommendation**: porting-matrix.md의 "🟢 copy" 정책이 명시적으로 "지금 정리하지 말고 일괄 포트 후 M1h 정리 단계에서 제거"라면 **현재 유지가 정답**입니다. 그게 아니라면 지금 삭제하는 편이 simplify skill 가이드("certain that something is unused → delete") 관점에서 더 깔끔합니다. 결정 경로:
  - 유지하는 경우: 파일 상단에 `// TODO(M1h): remove after final cleanup pass — dead in adaria-ai` 한 줄 추가.
  - 삭제하는 경우: `escapeShellArg`만 남기고 테스트도 같이 정리. escape.ts 테스트 파일이 7→1개로 축소됨.

### L3. 로거가 모든 호출마다 `fs.mkdirSync` 호출
- **Severity**: Low
- **Category**: Performance
- **File**: `src/utils/logger.ts:63-65`
- **Issue**: `writeLog`마다 `fs.mkdirSync(LOGS_DIR, { recursive: true })` + `fs.appendFileSync` 두 번의 sync I/O. `mkdirSync`는 `recursive`이면 존재 시 no-op이지만 여전히 syscall 한 번 나갑니다. 원본 pilot과 동일하고, M1 단계 로그량(시간당 수백 줄)에서는 문제가 아닙니다.
- **Recommendation**: 이번 포트에서는 그대로 두기. M1e에서 agent loop가 수천 req/hr로 올라가면 `let dirEnsured = false;` 플래그로 한 번만 호출하도록 최적화 가능.

## Info / Observations

### I1. `exactOptionalPropertyTypes` 수정의 타당성 검증
- `errors.ts` `buildErrorOptions(cause)` 헬퍼: `cause !== undefined ? { cause } : {}`는 `Error.cause` semantics를 정확히 보존합니다. 테스트 `"omits cause cleanly when not provided"`(`errors.test.ts:36-39`)와 `"preserves cause"`가 둘 다 통과하는 것으로 확인됨. ✅
- `ExternalApiError.statusCode: number | undefined` (필수 필드): 필드를 항상 **대입**하지만 값은 `undefined` 허용 — `exactOptional`과 무관한 영역이라 올바른 선택. 테스트 `"allows statusCode to be undefined"`가 `new ExternalApiError("no status")` 시 `.statusCode === undefined`를 검증. ✅
- `LogEntry.correlationId?: string | undefined`: `log()`에서 `correlationId: currentCorrelationId`를 항상 spread해도 `JSON.stringify`가 `undefined` 키를 drop하므로 파일에는 `correlationId` 키가 아예 기록되지 않습니다. 테스트 `"includes correlation ID when set"`은 값이 설정된 경우만 검증하므로 "undefined일 때 키가 없다"는 케이스는 커버되지 않습니다. 일반적 JSON 로그 컨벤션상 문제 없지만, 향후 로그 파서가 `correlationId` 존재 여부로 필터한다면 명시적 테스트를 추가해두면 좋음.

### I2. 로거 테스트의 env 격리는 안전
- `tests/utils/logger.test.ts:8-12`에서 `process.env["ADARIA_HOME"] = TEST_HOME`을 **top-level sync**로 설정한 뒤 `await import("../../src/utils/logger.js")` → `await import("../../src/utils/paths.js")` 순서로 동적 import. ESM 평가 순서상 env 할당이 paths.ts 모듈 평가 전에 완료되므로 경쟁 조건 없음. ✅
- Vitest는 기본적으로 `isolate: true` + 파일당 별도 worker(forks/threads pool)이므로 타 테스트 파일이 자체 `ADARIA_HOME`을 설정해도 프로세스 단위로 격리되어 충돌하지 않음. ✅
- `afterAll`에서 `fs.rmSync(TEST_HOME, { recursive: true, force: true })`로 정리됨. ✅
- 주의: vitest 설정 파일(vitest.config.ts)이 아직 없으므로 기본값에 의존합니다. 향후 `pool: "threads"` + `isolate: false`로 바꾸면 이 패턴이 깨지므로 설정 변경 시 재검토 필요.

### I3. `parse-json.ts`의 `charAt(i)` vs `text[i]` 동작 동등성
- `text[i]`는 `noUncheckedIndexedAccess`에서 `string | undefined` 타입. `text.charAt(i)`는 항상 `string` 반환(범위 밖이면 `""`).
- 현 루프는 `i < text.length`, `j < text.length`로 엄격히 bounded되어 있어 범위 밖 접근 자체가 발생하지 않음. 따라서 런타임 동작은 완전히 동일. ✅
- 엣지 케이스 확인:
  - Unbalanced `{unbalanced: ` → 여는 `{` 발견 → 내부 루프가 끝까지 가며 `depth > 0` 유지 → 루프 탈출 → 다음 start char 없음 → fallback 반환. ✅
  - 중첩 이스케이프 `{"msg": "he said \"hi\""}` → inString 토글이 `\"` 이스케이프를 건너뜀. ✅
  - 복수 JSON 블록 `first: {"n": 1} and second: {"n": 2}` → 첫 번째 `{`에서 완성되어 즉시 `return`, 두 번째 블록은 평가 안 됨. 테스트와 일치. ✅

### I4. 마일스톤 범위 준수
- 변경 파일: `src/utils/*` 7개 + `tests/utils/*` 7개 + `package.json` (lint script만). ✅
- skill/collector/agent/MCP 코드 유입 없음. `src/`에는 `utils/`와 기존 `index.ts`만 존재. ✅
- `package.json` lint script 변경 `eslint src/` → `eslint src/ tests/`는 M1b 범위에 정확히 부합(테스트 코드에도 type-aware 룰 적용).

## Positive Observations

- **도메인 리네이밍이 깔끔**: `grep -i pilot`이 src/와 tests/에서 완전히 0건. error code, log file prefix, user-facing 메시지(`adaria-ai init`)까지 모두 교체됨.
- **테스트 포트 품질**: 68 tests / 7 files, 단순 re-run이 아니라 에러 메시지 검증이 `Authentication`, `adaria-ai init`, `timed out` 등 adaria 컨텍스트에 맞춰 업데이트됨(`errors.test.ts:45, 65, 88`).
- **logger 테스트 env 격리 패턴이 모범적**: `ADARIA_HOME`을 top-level에서 먼저 설정한 뒤 dynamic import로 `paths.ts`를 로드하는 순서가 정확하고, `beforeAll`/`afterAll`로 실제 파일시스템 정리까지 담당.
- **`exactOptionalPropertyTypes` 대응이 성실**: 단순히 `?` 붙이는 대신 `buildErrorOptions` 헬퍼로 semantic을 명시화했음. 이후 M1c~M1f에서 다른 파일도 같은 패턴 재사용 가능.
- **`parse-json.ts`의 TS 컨버전 완성도**: 반환 타입을 `unknown`으로 명시해 "caller must narrow" 계약을 강제. JS 원본의 느슨함을 의도적으로 좁혔음.
- **package.json의 `files` 필드**: `tests/`를 포함하지 않아 `npm pack --dry-run`에서 자동 제외됨. 별도 `.npmignore` 없이도 깔끔.
- **typecheck/lint/test/pack 전 단계 통과**: 검증된 상태에서의 리뷰라 회귀 리스크가 낮음.

## Action Items Checklist

- [ ] (Medium) M1. `AuthError`/`ToolError`/`ConfigError`/`ExternalApiError`/`TimeoutError` 서브클래스 생성자에 `buildErrorOptions` 패턴을 동일 적용(또는 M1c에서 일괄).
- [ ] (Medium) M2. `parse-json.ts` extraction path에 O(n²) worst-case 주석 추가.
- [ ] (Low) L2. `escapeAppleScript` 처리 방침 결정 — porting-matrix 정책대로 유지하려면 `// TODO(M1h):` 마커 한 줄 추가, 아니면 테스트와 함께 지금 삭제.
- [ ] (Info) I1. LogEntry `correlationId` undefined 케이스에 대한 assertion을 logger 테스트에 추가(JSON 키가 아예 없음을 검증).
- [ ] (Nice-to-have) M1h 단계에서 `retry.ts`의 unused `lastError` + unreachable `throw` 정리.

**Overall grade: A-.** 포트 자체는 깔끔하고 회귀 리스크가 거의 없음. 서브클래스의 `buildErrorOptions` 패턴 불일치 하나만 M1c 시작 전에 정리하면 M1b는 완료 기준을 충족합니다.
