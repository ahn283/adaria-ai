# Code Review: M1 port of `src/agent/safety.ts`

**Date**: 2026-04-12
**Scope**: `src/agent/safety.ts` (~77 lines, newly ported)
**Milestone**: M1 (runtime bones port from pilot-ai)
**Commit(s)**: uncommitted working tree (latest commit on main: `1b25c2b feat(m1): port security + config + messenger interface`)

## Summary

M1 port는 pilot-ai의 `ApprovalManager` skeleton을 작게, 정확하게 가져왔다. 의도된 세 가지 변경 (`classifySafety`/패턴 제거, `ApprovalGate` 타입 추가, `shutdown()` 메서드 추가) 모두 문서화된 이유대로 반영되어 있고 타입은 strict 모드에서 깔끔하다. 다만 `requestApproval`의 실행자 패턴에서 **같은 taskId가 이미 pending 상태일 때 이전 entry가 조용히 덮어써지는 구조적 결함**이 하나 남아있고, 이 결함은 M5에서 도메인 gate가 올라타는 순간 실제 버그로 터진다. 이 한 건이 HIGH이며 나머지는 전부 관측성/위생 관련이다.

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 1 |
| MEDIUM | 1 |
| LOW | 3 |
| INFO | 1 |

**Overall Grade**: B+
**Milestone fit**: M1 범위에 정확히 맞음. 도메인 gate 배선은 M5로 의도적으로 미뤄져 있으며, `ApprovalGate` 타입만 미리 export하여 후속 작업의 계약을 고정한 것은 좋은 설계 결정이다.

## Critical & High Findings

### Duplicate-taskId로 `requestApproval`을 다시 호출하면 이전 pending이 영구적으로 leak되고, 이어서 NEW entry도 깨진다
- **Severity**: HIGH
- **Category**: Re-entrancy / State integrity / Approval flow
- **File**: `src/agent/safety.ts:35-48`
- **Issue**: `requestApproval(taskId, ...)`이 호출될 때, 같은 `taskId`가 이미 `pending` Map에 존재하는 경우를 전혀 감지하지 않는다. 실행 흐름은 다음과 같다:
  1. 첫 호출: `pending.set('t1', { timer: T1, resolve: R1 })`
  2. 두 번째 호출 (race 또는 재시도): 새 `timer T2`와 `resolver R2`가 생성되고, `pending.set('t1', { timer: T2, resolve: R2 })`가 이전 entry를 **조용히 덮어쓴다**.
  3. 이 시점에서 `T1`은 여전히 살아있다. `R1`을 호출할 참조는 아무 곳에도 남아있지 않다 — **promise 1은 절대 resolve되지 않는다** (caller의 `await`가 영원히 hang).
  4. `timeoutMs`가 지나 `T1`이 발화한다. 콜백은 `this.pending.delete('t1')`을 실행하는데, 이때 지워지는 것은 **NEW entry** (`T2`/`R2`)이고, 호출되는 `resolve(false)`는 **OLD resolver (`R1`)**이다 (closure가 `R1`을 캡처했기 때문). 결과: old promise는 `false`로 늦게 resolve되고, **new promise는 map에서 사라져서 `handleResponse`로도 도달할 수 없고, 자기 자신의 `T2` 타이머가 발화할 때까지 hang한다**. `T2`가 발화하면 `pending.delete('t1')`은 no-op (이미 지워진 상태)이지만 `resolve(false)`는 정상 호출되어 promise 2가 `false`로 resolve된다.

  요약하면 단일 duplicate 호출 한 번만으로:
  - Promise 1: 전체 `timeoutMs`만큼 hang → 그다음 `false`
  - Promise 2: 전체 `timeoutMs`만큼 hang → 그다음 `false`
  - 사용자가 Slack에서 해당 taskId의 승인 버튼을 누르면 `handleResponse`는 NEW entry가 이미 삭제된 상태라 `false`를 반환 — 버튼 클릭이 아무 동작도 하지 않는 유령 상태가 된다.

- **Impact**: M5에서 `blog_publish` / `metadata_change` / `review_reply` / `sdk_request` gate가 이 base 위에 올라탄다. taskId 생성 전략이 예를 들어 `${gate}-${appId}-${YYYYMMDD}` 형태라면 (growth-agent의 원래 패턴), 같은 앱에 같은 날 블로그를 두 번 publish 시도하거나 재시도 로직이 동작했을 때 즉시 이 결함이 재현된다. 승인 플로우가 조용히 죽고 launchd가 process를 kill할 때까지 skill은 hang한다. M7 parallel run 중에 이런 상황이 발생하면 growth-agent 쪽만 작동하는 것처럼 보여서 원인 파악이 늦어진다.

- **Current code**:
  ```typescript
  requestApproval(
    taskId: string,
    action: string,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(taskId);
        resolve(false);
      }, timeoutMs);

      this.pending.set(taskId, { taskId, action, resolve, timer });
    });
  }
  ```

- **Recommended fix**: Duplicate taskId를 fail-fast로 거절하거나, 의도적 덮어쓰기일 경우 이전 entry를 명시적으로 resolve하고 타이머를 정리한다. Fail-fast가 base layer에서는 더 안전하다 — caller가 중복 taskId를 생성하는 것은 거의 항상 버그이기 때문이다:
  ```typescript
  requestApproval(
    taskId: string,
    action: string,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.pending.has(taskId)) {
      return Promise.reject(
        new Error(
          `ApprovalManager: duplicate taskId "${taskId}" — previous approval still pending`,
        ),
      );
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(taskId);
        resolve(false);
      }, timeoutMs);

      this.pending.set(taskId, { taskId, action, resolve, timer });
    });
  }
  ```
  만약 M5에서 "같은 gate 재요청은 이전 요청을 취소한다"는 시맨틱이 필요하다고 판명되면, 위 대신 아래처럼 명시적 승계 패턴을 쓴다:
  ```typescript
  const existing = this.pending.get(taskId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.resolve(false); // 이전 호출자에게 cancelled 통지
    this.pending.delete(taskId);
  }
  ```
  어느 쪽이든 **현재의 조용한 덮어쓰기는 허용하면 안 된다**. 이 결정은 M5에서 gate 시맨틱이 확정될 때까지 미루지 말고 M1 base에서 닫아두는 것이 좋다. 기본 정책은 fail-fast, 필요하면 M5에서 승계로 완화하는 순서를 권장한다.

## Medium & Low Findings

### `shutdown()` 이후에도 `requestApproval`이 계속 동작한다 — shutdown 상태 표시자가 없다
- **Severity**: MEDIUM
- **Category**: Lifecycle / Daemon shutdown semantics
- **File**: `src/agent/safety.ts:69-76`
- **Issue**: `shutdown()`은 pending을 전부 비우지만 내부적으로 "이제 이 manager는 닫혔다"는 flag를 설정하지 않는다. 따라서 `shutdown()` 이후에 `requestApproval`이 호출되면 새 pending entry가 생성되고, 아무도 응답하지 않는 promise가 map에 쌓인다. SIGTERM → `shutdown()` → 진행 중이던 skill이 그 사이에 `ctx.approvals.requestApproval()`을 호출하는 타이밍 race가 실제로 존재한다 (특히 `Promise.allSettled`로 분산 실행되는 M6 orchestrator에서).
- **Impact**: 프로세스가 곧 종료되므로 실질적 data loss는 없지만, 종료 시점에 hang하는 skill이 생기고 launchd가 SIGKILL로 승격시킬 때까지 로그가 지저분해진다. Base layer의 lifecycle 계약이 약해지면 M5/M6에서 디버깅 난이도가 올라간다.
- **Current code**:
  ```typescript
  shutdown(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(false);
    }
    this.pending.clear();
  }
  ```
- **Recommended fix**:
  ```typescript
  private shuttingDown = false;

  requestApproval(
    taskId: string,
    action: string,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.shuttingDown) {
      return Promise.resolve(false);
    }
    // ... existing duplicate-taskId guard + executor
  }

  shutdown(): void {
    this.shuttingDown = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(false);
    }
    this.pending.clear();
  }
  ```
  `Promise.resolve(false)`를 반환하는 것은 승인 거절과 동일한 의미라 기존 skill 코드가 그대로 동작한다. 거절 사유를 구분하고 싶어지면 M5에서 `ApprovalResult` 타입을 도입하면 된다.

### `PendingApproval.action` 필드가 저장만 되고 어디에서도 읽히지 않는다
- **Severity**: LOW
- **Category**: Observability / Dead field
- **File**: `src/agent/safety.ts:20-25`, `src/agent/safety.ts:46`
- **Issue**: `action` 문자열은 생성자에서 값을 받아 Map에 저장되지만 `handleResponse`/`shutdown`/로깅 어느 곳에서도 사용되지 않는다. 이 상태 그대로 M5에 들어가면 shutdown 시 "어떤 gate가 canceled 되었는지"를 로그에 남길 수 없다.
- **Impact**: 현재는 낭비만 하지만, M5 audit log 통합 시점에 다시 이 자리에 돌아와야 한다. 지금 바로 쓰는 편이 적은 노력으로 끝난다.
- **Recommended fix**: `shutdown()`과 timeout 콜백, `handleResponse`에서 action을 인자에 실어 logger 호출을 추가한다. Logger가 아직 배선되지 않은 단계라면 최소한 TODO 주석 하나라도 남겨서 M5에서 놓치지 않도록 한다:
  ```typescript
  shutdown(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      // TODO(M5): log entry.taskId + entry.action as "cancelled-on-shutdown"
      entry.resolve(false);
    }
    this.pending.clear();
  }
  ```

### Timeout 경로에 관측 포인트가 없다
- **Severity**: LOW
- **Category**: Observability
- **File**: `src/agent/safety.ts:41-44`
- **Issue**: Timeout으로 rejected된 approval은 로그를 남기지 않는다. M5에서 블로그 publish가 timeout으로 실패하면 "왜 올라가지 않았는가"를 추적하기 위해 `audit.jsonl`을 파싱해야 하는데, 그 audit entry를 쓰는 책임이 어느 layer에 있는지가 불분명해진다.
- **Impact**: 디버깅 비용. M5 exit criteria 확인 시 timeout 동작을 수동으로 재현해보기 어렵다.
- **Recommended fix**: Base layer는 logger 의존성을 가지지 않는 것이 맞으므로, 콜백 형태로 노출하거나 M5에서 `audit.ts`가 `requestApproval`을 wrap하는 형태를 취한다. 현재 파일에서는 주석으로만 훅 포인트를 남기는 것이 최소 개입이다:
  ```typescript
  const timer = setTimeout(() => {
    this.pending.delete(taskId);
    // NOTE(M5): audit.jsonl에 {taskId, action, outcome: "timeout"} 기록
    resolve(false);
  }, timeoutMs);
  ```

### `classifySafety` 제거 근거는 docstring에 있지만 `porting-matrix.md`에는 없다
- **Severity**: LOW
- **Category**: Documentation / Porting traceability
- **File**: `src/agent/safety.ts:9-12` (+ 미갱신 `docs/growth-agent/porting-matrix.md`)
- **Issue**: Module docstring에 "shell tool 없음 → classifySafety 불필요"가 명시되어 있는 것은 좋다. 다만 이 결정은 `docs/growth-agent/porting-matrix.md`의 `agent/safety.ts` row에도 "dropped: classifySafety + pattern lists"로 남겨져야 한다. 같은 결정을 두 번 내리지 않으려면 matrix가 single source of truth여야 한다.
- **Impact**: M5에서 다른 작업자가 "패턴 기반 classifier가 왜 없지?"를 다시 물을 수 있다. 현재 porting-matrix를 읽어도 답이 없다.
- **Recommended fix**: `docs/growth-agent/porting-matrix.md`의 safety.ts 행에 "DROPPED: classifySafety + DANGEROUS/MODERATE patterns — shell tool 부재로 불필요, 도메인 gate만 사용" 한 줄 추가.

### `handleResponse`의 반환값이 "unknown" vs "already resolved"를 구분하지 못한다
- **Severity**: INFO
- **Category**: API shape (future concern)
- **File**: `src/agent/safety.ts:51-59`
- **Issue**: 현재 `handleResponse`는 entry가 없을 때 `false`를 반환한다. 하지만 호출자 입장에서는 "모르는 taskId" (버그 또는 위조된 payload)와 "이미 timeout 되어 사라진 taskId" (정상적인 동시성) 둘 다 `false`로 관측된다. M5 messenger에서 Slack 버튼을 중복 클릭했을 때 사용자에게 "이미 처리되었습니다" vs "알 수 없는 요청"을 다르게 보여주고 싶을 수 있다.
- **Impact**: 현 단계에서는 영향 없음. M5 messenger 배선 시 UX 결정이 필요해지면 돌아올 자리.
- **Recommended fix**: M1에서는 수정하지 말고, M5 safety 도메인 확장 시점에 `enum ApprovalResult { HANDLED, UNKNOWN, ALREADY_RESOLVED }`를 고민한다. 이 파일에는 손대지 않는 것을 권장 — API shape는 M5에서 쓰임새를 본 뒤에 정하는 편이 낫다.

## Data Flow Issues

해당 없음. `safety.ts`는 pure in-memory state holder이며 collector → skill → approval → messenger 경로 중 "pending registry" 위치만 담당한다. DB, Claude, Slack과의 배선은 전혀 하지 않으므로 cross-module data flow 검사는 M5로 자연스럽게 미뤄진다.

## Two-mode routing integrity

해당 없음. `core.ts` / `skills/index.ts` / `tools/`는 이번 PR에 포함되지 않는다. 다만 한 가지 invariant를 미리 확인해둔다: `ApprovalManager`는 `src/tools/`의 어느 MCP tool에서도 호출되지 않아야 한다 — MCP tool은 read-only여야 하므로 approval gate 자체가 tool 경로에 존재해서는 안 된다. M5에서 tool 파일을 추가할 때 이 경계를 지키고 있는지 재검토가 필요하다. 현재 `safety.ts`는 이 invariant를 위반할 수 있는 export shape를 가지고 있지 않다 (`ApprovalGate` 타입은 중립이고, `ApprovalManager`는 base class이므로 호출자 통제는 caller layer의 몫).

## Positive Observations

- **의도된 drop과 변경이 docstring에 명확히 기록되어 있다.** "shell tool 없음 → classifySafety 제거"는 리뷰어가 바로 이해할 수 있는 형태로 쓰여 있다. 포팅된 파일은 이 형태로 원본과의 차이를 설명하는 것이 이상적이다.
- **`ApprovalGate` 타입을 M1에서 미리 export한 것은 좋은 설계 결정이다.** M5에서 `skills/*`가 이 타입을 import하게 되면 IDE autocomplete + compile-time 검증이 걸린다. Union literal로 쓴 것도 exhaustive check에 유리하다.
- **`shutdown()`의 구현 자체는 올바르다.** `clearTimeout` → `resolve(false)` → `pending.clear()` 순서가 re-entrancy에 안전하다 (Promise resolution이 microtask이므로 iteration 중 map mutation이 발생하지 않는다).
- **`handleResponse`의 순서 (`clearTimeout` → `delete` → `resolve`) 도 re-entrancy 안전.** `entry.resolve`가 동기적으로 실행되더라도 해당 promise를 await하던 코드는 다음 microtask에서 돌기 때문에, 같은 synchronous turn 내에서 `requestApproval`이 재호출되어 충돌할 가능성은 없다. 단, duplicate taskId 가드가 없는 HIGH 항목은 이와 별개의 문제다.
- **TypeScript strict / `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes`에 깨끗이 대응한다.** Map `.get()` 결과를 narrow 체크 없이 바로 쓰는 실수가 없고 (`if (!entry) return false;`), 선택적 필드도 없다.
- **변경 surface가 70줄짜리에 딱 맞게 작다.** M1 milestone fit이 정확하다 — skill 로직이나 logger 의존성을 여기 섞어넣지 않은 절제가 보인다.

## Action Items

- [ ] **(HIGH)** `requestApproval`에 duplicate taskId 가드 추가. 권장: fail-fast 버전 (`Promise.reject` with 명시적 에러 메시지). M5에서 시맨틱이 바뀌면 그때 승계 패턴으로 전환.
- [ ] **(MEDIUM)** `shuttingDown` flag 추가. `shutdown()` 이후 `requestApproval`은 `Promise.resolve(false)`를 즉시 반환.
- [ ] **(LOW)** `PendingApproval.action` 사용 예정 지점에 TODO 주석 혹은 최소 로깅 훅 추가 (M5 audit 배선 대비).
- [ ] **(LOW)** Timeout 콜백과 shutdown 경로에 `NOTE(M5): audit.jsonl 기록 지점` 주석 1줄씩.
- [ ] **(LOW)** `docs/growth-agent/porting-matrix.md`의 `agent/safety.ts` 행에 "classifySafety + patterns DROPPED" 명시.
- [ ] **(INFO)** `handleResponse`의 2-값 반환 → 3-값 결과 enum 전환은 M5까지 defer. 이 PR에서 건드리지 말 것.
