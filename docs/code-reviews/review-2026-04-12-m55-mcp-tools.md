# Code Review: M5.5 MCP Tools -- Mode B Conversational Tool Surface

**Date**: 2026-04-12
**Scope**: `src/tools/db-query.ts`, `src/tools/collector-fetch.ts`, `src/tools/skill-result.ts`, `src/tools/app-info.ts`, `src/tools/tool-host.ts`, `src/agent/mcp-manager.ts` (modified), `src/agent/tool-descriptions.ts` (modified), `tests/tools/*.test.ts` (4 files)
**Milestone**: M5.5 -- Conversational tools / Mode B
**Commit(s)**: uncommitted working tree

## Summary

M5.5는 Mode B (대화형 멘션) 경로의 핵심인 4개 read-only MCP tool과 stdio JSON-RPC tool host를 구현한다. 전체적인 아키텍처는 건전하다: 테이블 화이트리스트 + 컬럼 리다크션 + 입력 검증 + 출력 트렁케이션의 방어 계층이 잘 설계되어 있고, M4 C1에서 지적된 `competitor_metadata.description` 리다크션도 반영되었다. 그러나 **CRITICAL 1건** (tool descriptions 트렁케이션으로 보안 지시문 손실), **HIGH 3건** (tool descriptor 미등록으로 Mode B 무효화, 트렁케이션 후 `JSON.parse` 크래시, `collector-fetch` 입력 검증 누락)이 수정 필요하다.

| Severity | Count |
|----------|-------|
| CRITICAL | 1 |
| HIGH | 3 |
| MEDIUM | 4 |
| LOW | 2 |
| INFO | 3 |

**Overall Grade**: B-
**Milestone fit**: 코어 tool 구현 + 테스트는 M5.5 범위에 정확히 부합. 단, checklist 기준 누락 항목 3개 (`tests/tools/prompt-injection.test.ts`, `tests/integration/mode-b.test.ts`, `doctor.ts` MCP listing)와 데몬 부팅 시 tool descriptor 등록 누락은 M5.5 exit criteria를 아직 충족하지 않는다.

---

## Critical & High Findings

### C1: Tool descriptions 1000자 트렁케이션으로 보안 지시문 손실

- **Severity**: CRITICAL
- **Category**: Security / Prompt injection defense
- **File**: `src/agent/core.ts:534`
- **Issue**: `buildToolDescriptions()`의 반환값은 1,574자이지만, `core.ts`가 `.slice(0, 1000)`으로 트렁케이션한다. 잘리는 구간에는 "### Important rules:" 이하 전체가 포함되며, 이 섹션은:
  - "These tools are READ-ONLY" 지시
  - "Do NOT pass raw review body text back to the user" 지시
  - "seo_metrics, web_traffic, blog_performance tables are site-wide" 정보

  를 담고 있다. 이 지시문이 Claude 시스템 프롬프트에서 빠지면 Claude가 review body 원문을 그대로 Slack에 출력하거나, 사용자 요청에 따라 DB 쓰기를 시도하는 응답을 생성할 수 있다.
- **Impact**: PII 유출 (review body text 원문 → Slack), prompt injection 방어 계층 중 하나 소실. PRD 10절 30일 지표 "Zero PII leaks from Mode B tool output"과 직접 충돌.
- **Current code**:
  ```typescript
  // core.ts:534
  const toolDescriptions = buildToolDescriptions();
  if (toolDescriptions) parts.push(toolDescriptions.slice(0, 1000));
  ```
- **Recommended fix**:
  ```typescript
  // Option A: Remove the cap — tool descriptions are short, author-controlled text.
  const toolDescriptions = buildToolDescriptions();
  if (toolDescriptions) parts.push(toolDescriptions);

  // Option B: If a cap is needed, raise it to cover the full text + future growth.
  if (toolDescriptions) parts.push(toolDescriptions.slice(0, 4000));
  ```
  Option A가 권장된다. tool descriptions는 attacker-controlled data가 아니라 번들된 코드에서 생성하는 정적 텍스트이므로 트렁케이션할 이유가 없다. memory context와 달리 이 텍스트는 크기가 예측 가능하다.

---

### H1: Tool descriptor가 daemon에 등록되지 않아 Mode B 비활성

- **Severity**: HIGH
- **Category**: Architecture / Two-mode routing
- **File**: `src/cli/daemon.ts:40`, `src/agent/mcp-manager.ts:97`
- **Issue**: `McpManager.registerTool()`은 정의되어 있지만 코드베이스 어디에서도 호출되지 않는다. `daemon.ts`는 `AgentCore`를 생성할 때 `mcpManager` 옵션을 전달하지 않으므로 기본 빈 `McpManager`가 사용된다. 결과적으로:
  1. `buildMcpConfig()` → `null` → `--mcp-config` 플래그 미전달
  2. `buildMcpContext()` → `""` → 시스템 프롬프트에 tool 정보 없음
  3. Claude CLI가 tool 없이 실행되어 Mode B 대화에서 데이터 기반 답변 불가
- **Impact**: M5.5 전체 기능이 동작하지 않는다. 사용자가 `@adaria-ai 이번 주 리뷰 어때?`를 보내면 Claude가 tool 없이 hallucinate.
- **Current code**:
  ```typescript
  // daemon.ts:40
  const agent = new AgentCore(messenger, config);
  // McpManager, db, apps 모두 전달되지 않음
  ```
- **Recommended fix**:
  ```typescript
  // daemon.ts — after loadConfig, before AgentCore construction
  import { initDatabase } from "../db/schema.js";
  import { loadApps } from "../config/load-apps.js";
  import { McpManager } from "../agent/mcp-manager.js";
  import { getToolDescriptors } from "../tools/descriptors.js"; // new file, or inline

  const db = initDatabase();
  const { apps } = await loadApps();
  const mcpManager = new McpManager();

  // Register the 4 tool descriptors (metadata only — handlers live in tool-host)
  for (const descriptor of getToolDescriptors()) {
    mcpManager.registerTool(descriptor);
  }

  const agent = new AgentCore(messenger, config, { mcpManager, db, apps });
  ```
  `getToolDescriptors()`는 4개 tool의 `{ id, name, description, inputSchema }`만 반환하는 thin helper다. `createDbQueryTool` 등에서 descriptor 부분만 추출하거나 별도 상수로 빼면 된다. tool handler는 tool-host subprocess에서만 실행되므로 daemon process에 handler를 등록하면 안 된다 (McpToolDescriptor vs McpToolImplementation 분리 원칙).

---

### H2: `truncateOutput` + `JSON.parse` 조합이 대용량 결과에서 크래시

- **Severity**: HIGH
- **Category**: Data flow / Error handling
- **Files**: `src/tools/db-query.ts:168`, `src/tools/collector-fetch.ts:115`, `src/tools/skill-result.ts:59`
- **Issue**: `truncateOutput()`은 JSON 문자열을 10KB에서 바이트 단위로 자른다. 잘린 결과는 유효하지 않은 JSON이다. 이를 `JSON.parse()`에 넘기면 `SyntaxError`가 발생한다.
  - `db-query.ts`: try/catch 내부이므로 에러 메시지로 반환 → 기능 저하
  - `collector-fetch.ts`: try/catch 없음 → `tool-host.ts`의 외부 try/catch가 잡으나 "Unexpected token" 에러 반환
  - `skill-result.ts`: try/catch 없음 → 동일
- **Impact**: 50행 * 컬럼 많은 테이블 쿼리 시 사용자에게 "Error: Unexpected token" 반환. 디버깅이 어렵고 UX가 나쁘다.
- **Current code (db-query.ts:168)**:
  ```typescript
  return Promise.resolve({
    rowCount: redactedRows.length,
    rows: JSON.parse(truncateOutput(redactedRows)) as unknown
  });
  ```
- **Recommended fix**:
  ```typescript
  // Option A: truncateOutput returns the original object when under limit,
  // truncated string (NOT parsed) when over limit.
  function truncateOutput(data: unknown): { value: unknown; truncated: boolean } {
    const json = JSON.stringify(data, null, 2);
    if (json.length <= MAX_OUTPUT_BYTES) return { value: data, truncated: false };
    // Return the raw data but sliced to fewer items
    if (Array.isArray(data)) {
      // Binary search for the number of items that fit in MAX_OUTPUT_BYTES
      let lo = 0, hi = data.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (JSON.stringify(data.slice(0, mid), null, 2).length <= MAX_OUTPUT_BYTES) lo = mid;
        else hi = mid - 1;
      }
      return { value: data.slice(0, lo), truncated: lo < data.length };
    }
    return { value: json.slice(0, MAX_OUTPUT_BYTES), truncated: true };
  }

  // Option B (simpler): Just return data directly, no JSON roundtrip.
  // The tool-host already JSON.stringify's the result for the MCP response.
  return Promise.resolve({
    rowCount: redactedRows.length,
    rows: redactedRows,  // no truncateOutput + JSON.parse roundtrip
    truncated: redactedRows.length > MAX_ROWS,
  });
  ```
  Option B가 훨씬 간단하다. `MAX_ROWS`(50)가 이미 행 수를 제한하고 있고, `tool-host.ts`가 `JSON.stringify(result)`를 하므로 tool 내부에서 JSON 직렬화→역직렬화를 반복할 필요가 없다.

---

### H3: `collector-fetch` 입력 검증 누락 -- `app`과 `collector` 필수 필드 미검증

- **Severity**: HIGH
- **Category**: Security / Input validation
- **File**: `src/tools/collector-fetch.ts:104-108`
- **Issue**: handler가 `input`을 `as Record<string, unknown>`으로 캐스팅한 뒤 `obj["collector"]`와 `obj["app"]`을 `as string`으로 캐스팅한다. 입력이 `{}`, `null`, 또는 `{ collector: 123, app: true }` 같은 비정상 형태일 때:
  - `collector`가 undefined → `ALLOWED_COLLECTORS.includes(undefined as CollectorName)` → false → 에러 반환 (우연히 안전)
  - `app`이 undefined → `fetchCollectorData`의 `appId` 파라미터가 `undefined`로 전달 → SQLite에서 `app_id = undefined`는 아무 결과도 반환하지 않지만, 시맨틱이 잘못됨
  - `app`이 숫자나 boolean이면 → `toString()`이 암묵적으로 호출되어 예상치 못한 쿼리 실행
- **Impact**: 잘못된 입력에 대한 에러 메시지가 불명확하거나, undefined가 쿼리 파라미터로 전달되어 혼란스러운 빈 결과 반환.
- **Current code**:
  ```typescript
  const obj = input as Record<string, unknown>;
  const collector = obj["collector"] as string;
  const appId = obj["app"] as string;
  ```
- **Recommended fix**:
  ```typescript
  handler: (input: unknown): Promise<unknown> => {
    if (!input || typeof input !== "object") {
      return Promise.resolve({ error: "Input must be an object with `collector` and `app` fields." });
    }
    const obj = input as Record<string, unknown>;
    const collector = typeof obj["collector"] === "string" ? obj["collector"] : undefined;
    const appId = typeof obj["app"] === "string" ? obj["app"] : undefined;

    if (!collector) {
      return Promise.resolve({ error: "Missing required field: `collector`." });
    }
    if (!appId) {
      return Promise.resolve({ error: "Missing required field: `app`." });
    }

    if (!ALLOWED_COLLECTORS.includes(collector as CollectorName)) {
      return Promise.resolve({ error: `Unknown collector: "${collector}". Allowed: ${ALLOWED_COLLECTORS.join(", ")}` });
    }
    // ...
  }
  ```
  `skill-result.ts:47-50`에도 동일한 패턴이 존재한다 (`skill`과 `app` 필드). 동일하게 수정 필요.

---

## Medium & Low Findings

### M1: `collector-fetch`의 `seo-metrics`와 `web-traffic`가 `appId`를 무시하는데 `app`이 required

- **Severity**: MEDIUM
- **Category**: Data flow / UX
- **File**: `src/tools/collector-fetch.ts:65-69`
- **Issue**: `seo-metrics`와 `web-traffic`는 site-wide 테이블이라 `appId` 파라미터를 사용하지 않는다 (`getSeoMetricsByRange`와 `getWebTrafficByRange`는 `appId`를 받지 않음). 하지만 inputSchema에서 `app`이 required로 선언되어 있어 Claude가 반드시 `app` 값을 넘겨야 한다. 의미 없는 값을 강제하는 것은 혼란을 야기한다.
- **Impact**: Claude가 site-wide 데이터를 가져올 때 의미 없는 `app` 파라미터를 추측해야 한다.
- **Recommended fix**:
  ```typescript
  // inputSchema에서 app을 optional로 변경하거나,
  // tool description에서 seo-metrics/web-traffic는 app이 불필요하다고 명시
  // (현재 tool description에 이미 언급되어 있지만, schema와 불일치)
  inputSchema: {
    type: "object",
    required: ["collector"],  // app을 required에서 제거
    properties: { /* ... */ },
  },
  ```
  또는 handler에서 `seo-metrics`/`web-traffic` 선택 시 `app`이 없어도 동작하도록 분기 처리.

### M2: `tool-host.ts`가 MCP `ping` 메서드를 핸들링하지 않음

- **Severity**: MEDIUM
- **Category**: MCP protocol compliance
- **File**: `src/tools/tool-host.ts:140`
- **Issue**: MCP 스펙에는 `ping` 메서드가 있고, `doctor.ts`의 health check가 이를 호출할 예정이다 (checklist 참조). 현재 `tool-host.ts`는 `initialize`, `notifications/initialized`, `tools/list`, `tools/call` 4가지만 처리하고 나머지는 -32601 Unknown method 에러를 반환한다. `ping`도 거부된다.
- **Impact**: `doctor.ts`에서 tool-host health check를 구현할 때 `ping` 핸들러를 추가해야 한다. 지금 추가하면 M5.5 exit criteria ("verify they start") 충족에 도움.
- **Recommended fix**:
  ```typescript
  if (request.method === "ping") {
    respond({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  ```

### M3: `db-query`의 `selectClause` 계산이 무효 — 항상 `*`

- **Severity**: MEDIUM
- **Category**: Code quality / Dead code
- **File**: `src/tools/db-query.ts:69-76`
- **Issue**: 리다크션 대상 테이블을 감지하지만 `selectClause`를 변경하지 않는다. 주석에 "post-processing에서 리다크션" 이라고 설명하나, 실제로는 이 코드 블록이 아무 효과가 없다. 불필요한 조건 분기 + `let` + 재할당 없음 구조가 혼란스럽다.
- **Current code**:
  ```typescript
  const redacted = REDACTED_COLUMNS[params.table];
  let selectClause = "*";
  if (redacted) {
    selectClause = "*";  // 동일한 값 재할당
  }
  ```
- **Recommended fix**:
  ```typescript
  const selectClause = "*";
  // Redaction happens in redactRows() after query execution.
  ```

### M4: 누락된 테스트 파일 3개 -- M5.5 exit criteria 미충족

- **Severity**: MEDIUM
- **Category**: Test coverage
- **Files**: missing `tests/tools/prompt-injection.test.ts`, missing `tests/integration/mode-b.test.ts`
- **Issue**: M5.5 checklist에 명시된 3개 테스트:
  1. `tests/tools/prompt-injection.test.ts` -- "attempts to bypass whitelist via description injection fail"
  2. `tests/integration/mode-b.test.ts` -- "scripted mention produces a tool call + synthesised answer, verified against a fixture"
  3. `doctor.ts` MCP tool listing 검증
  
  이 중 어느 것도 구현되지 않았다. tool-level 단위 테스트(4 파일)는 잘 작성되었으나, prompt injection과 integration 시나리오 테스트가 없다.
- **Impact**: "Claude에게 테이블 화이트리스트를 우회하도록 tool description을 조작하는" 공격 시나리오가 테스트로 검증되지 않음.
- **Recommended fix**: 최소한 `prompt-injection.test.ts` 작성. 예시:
  ```typescript
  // tool description에 "ignore whitelist" 같은 문자열 삽입 시도 → 거부 확인
  // orderBy에 UNION 삽입 시도 → 거부 확인
  // where clause에 subquery 삽입 시도 → 거부 확인
  ```

---

### L1: `truncateOutput` 함수 3곳에 중복 정의

- **Severity**: LOW
- **Category**: DRY
- **Files**: `src/tools/db-query.ts:123`, `src/tools/collector-fetch.ts:36`, `src/tools/skill-result.ts:14`
- **Issue**: 동일한 `truncateOutput` 함수가 3개 파일에 복사되어 있다. `MAX_OUTPUT_BYTES` 상수도 각각 선언.
- **Recommended fix**: `src/tools/utils.ts`로 추출:
  ```typescript
  export const MAX_OUTPUT_BYTES = 10_240;
  export function truncateOutput(data: unknown): string { /* ... */ }
  ```

### L2: `tool-host.ts`의 `rl.on("line")` async 에러 전파

- **Severity**: LOW
- **Category**: Error handling
- **File**: `src/tools/tool-host.ts:58-142`
- **Issue**: `void (async () => { ... })();` 패턴으로 async IIFE를 실행한다. `void` 키워드가 unhandled rejection을 방지하지는 않는다 — async 함수 내에서 try/catch로 감싸져 있지 않은 예외가 발생하면 Node.js가 `unhandledRejection` 이벤트를 발생시킨다. 현재 tool handler 호출은 try/catch에 감싸져 있으므로 대부분의 경우 안전하지만, `JSON.parse(line)` 전후의 early return 경로에서 `respond()` 자체가 throw하면 잡히지 않는다.
- **Recommended fix**: top-level try/catch로 감싸기:
  ```typescript
  rl.on("line", (line: string) => {
    void (async () => {
      try {
        // ... existing handler code ...
      } catch (err) {
        // Last-resort error handler — write to stderr, do not crash
        process.stderr.write(`[tool-host] Unhandled: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    })();
  });
  ```

---

## Data Flow Issues

### `tool-host.ts`가 별도 프로세스에서 DB 연결을 여는 구조적 정합성

tool-host는 `initDatabase()`를 호출해 자체 SQLite 연결을 연다. daemon process와 별도의 연결이므로:
- WAL 모드에서는 읽기-읽기 동시 접근이 안전하다 (OK)
- tool-host가 쓰기를 시도하면 WAL lock contention이 발생할 수 있지만, 모든 tool이 read-only이므로 문제 없다 (OK)
- `loadApps()`도 별도 호출하므로, daemon 부팅 후 apps.yaml이 변경되면 tool-host를 재시작해야 반영된다. Claude CLI가 MCP 서버를 요청마다 spawn하는지 한번만 spawn하는지에 따라 stale 문제가 결정된다. Claude CLI가 conversation 단위로 spawn한다면 문제 없고, 장기 유지한다면 stale 가능. (INFO 수준, 현재 CLI 동작으로는 안전)

### Review body → Slack 데이터 경로

```
reviews.body (DB) → db-query tool (redacted to "[redacted]")
                  → collector-fetch "reviews" (redacted to "[redacted]")
                  → Claude response → Slack
```

리다크션은 tool 레벨에서 수행된다. 그러나 C1에서 지적한 대로, `buildToolDescriptions()`의 "Do NOT pass raw review body text" 지시문이 트렁케이션되면 Claude가 "body" 컬럼이 리다크션되지 않는 다른 쿼리 방식(예: 잘못된 column alias)을 시도할 수 있다. 실제로는 리다크션이 코드에서 강제되므로 데이터 유출은 차단되지만, Claude가 "이 정보를 가져올 수 없다"고 정확히 답변하도록 description 지시문을 온전히 전달하는 것이 중요하다.

---

## Two-mode routing integrity

### Mode A dispatch (explicit command)

M5.5 변경사항은 Mode A 경로에 영향을 주지 않는다. `skills/index.ts` dispatch와 `core.ts` 명령어 매칭 로직은 수정되지 않았다. OK.

### Mode B fall-through (conversational mention)

H1에서 지적한 대로, tool descriptor 등록이 누락되어 Mode B가 실질적으로 비활성 상태이다. 등록 후의 경로:

```
core.ts → buildMcpConfig() → writeMcpConfig() → mcp-config.json path
       → invokeClaudeCli({ mcpConfigPath }) → Claude CLI spawns tool-host.js
       → tool-host reads stdin JSON-RPC → dispatches to handler → responds stdout
```

이 경로의 구조적 설계는 올바르다. `mcp-manager.ts`의 `buildMcpConfig`가 `mcp-launcher.ts`의 `buildToolHostServerConfig`를 사용해 `process.execPath + tool-host.js` 커맨드를 생성하는 방식도 launchd PATH 문제를 정확히 우회한다.

### MCP tool → skill 경계 검증

`src/tools/` 디렉토리에는 read-only tool만 존재하며, 어떤 tool도 `src/skills/`를 import하지 않는다. skill이 MCP tool로 노출되지 않는 critical invariant는 유지된다. OK.

---

## Positive Observations

1. **M4 C1 후속 조치 반영**: `competitor_metadata.description` 리다크션이 `REDACTED_COLUMNS`에 포함되었다. 이전 리뷰에서 지적한 attacker-controllable 필드 유출 경로가 차단됨.

2. **`McpToolDescriptor` vs `McpToolImplementation` 타입 분리**: daemon process에서 handler를 호출할 수 없도록 타입 시스템으로 강제하는 설계가 우수하다. `McpManager.registerTool()`은 `McpToolDescriptor`만 받으므로 실수로 handler를 daemon에 등록할 수 없다.

3. **Column name / orderBy regex 검증**: SQL injection 방어가 정규식으로 견고하게 구현되었다. `1=1; DROP TABLE`, `UNION SELECT`, `CASE WHEN` 등의 공격 벡터를 테스트로 확인했으며 모두 차단됨.

4. **테이블 화이트리스트 + 컬럼 리다크션의 이중 방어**: 테이블 접근을 제한하고, 허용된 테이블 내에서도 민감 컬럼을 redact하는 2중 방어 계층이 잘 설계됨.

5. **테스트 커버리지**: 4개 tool 모두 단위 테스트가 작성되었으며, whitelist rejection, redaction 검증, limit cap, invalid input 케이스를 포함한다. `db-query.test.ts`가 8개 케이스로 가장 포괄적이다.

6. **`process.execPath` 사용**: `mcp-launcher.ts`에서 `npx` 대신 `process.execPath`를 사용해 launchd의 빈 PATH 환경에서도 Node.js 바이너리를 정확히 참조한다. M9 global install에서도 안전한 설계.

7. **`buildToolDescriptions()` 내용**: tool 사용 규칙, 읽기 전용 제약, 데이터 요약 지시 등이 명확하게 작성됨. (C1의 트렁케이션 문제만 해결하면 완벽)

---

## Action Items

- [ ] **C1** (CRITICAL): `core.ts:534`에서 `toolDescriptions.slice(0, 1000)` 제거하거나 충분한 limit(4000+)으로 변경
- [ ] **H1** (HIGH): `daemon.ts`에서 4개 tool descriptor를 `McpManager`에 등록 + `db`, `apps`를 `AgentCore`에 전달
- [ ] **H2** (HIGH): `truncateOutput` + `JSON.parse` 패턴을 수정 -- 행 수 기반 truncation으로 변경하거나, JSON roundtrip 제거
- [ ] **H3** (HIGH): `collector-fetch.ts`와 `skill-result.ts`의 handler에 `db-query.ts`와 동일한 수준의 입력 검증 추가
- [ ] **M1** (MEDIUM): `collector-fetch`의 `app` 필드를 site-wide collector에서 optional로 처리
- [ ] **M2** (MEDIUM): `tool-host.ts`에 `ping` 메서드 핸들러 추가
- [ ] **M3** (MEDIUM): `db-query.ts`의 dead code (`selectClause` 분기) 제거
- [ ] **M4** (MEDIUM): `tests/tools/prompt-injection.test.ts` 작성 — M5.5 exit criteria
- [ ] `doctor.ts`에 MCP tool listing + health check 추가 — M5.5 exit criteria
- [ ] (Deferred) `tests/integration/mode-b.test.ts` — Claude CLI mock이 필요하므로 M6 이후로 defer 가능
