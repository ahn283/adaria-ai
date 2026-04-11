# Code Review: M1 — Messenger Port (split + slack + factory)

**Date**: 2026-04-12
**Scope**: `src/messenger/split.ts`, `src/messenger/slack.ts`, `src/messenger/factory.ts`, `tests/messenger/{split,slack,factory}.test.ts`
**Milestone**: M1 (runtime bones port from pilot-ai)
**Commit(s)**: uncommitted working tree, pre-commit review

## Summary

포트 자체는 잘 되었다. `eventTs` 회귀 수정(H3)의 두 site(`message` + `app_mention`)는 의도대로 반영되었고, structured logger 치환, 토큰 stashing 축소, Telegram 제거는 깔끔하다. 그러나 **per-change 개발 루프의 stage 2(build+lint)가 빨간불이다** — `npm run lint`가 `tests/messenger/slack.test.ts`에서 `no-redundant-type-constituents` 에러로 실패한다. CLAUDE.md 규정에 따라 이 상태로는 commit으로 넘어갈 수 없다. 그 외에는 중간 크기의 설계 공백 몇 개(PDF-only 파일 공유가 빈 mention으로 새는 문제, `sendApproval` 짧은 경로에서 rate limiter 생략, reaction warn 로그 스팸 가능성)와 테스트 커버리지 갭이 있다.

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 1 |
| MEDIUM | 4 |
| LOW | 4 |
| INFO | 2 |

**Overall Grade**: B
**Milestone fit**: M1 messenger port 범위 내. skill/tool/orchestrator 혼입 없음. pilot-ai 원본과의 diff도 README/포팅 매트릭스에 명시된 4개 항목(eventTs, telegram drop, logger, botToken stash)으로 잘 국한되어 있다.

---

## Critical & High Findings

### H1. Lint 실패로 개발 루프 stage 2가 막혀 있다
- **Severity**: HIGH
- **Category**: Dev loop compliance / TypeScript strictness
- **File**: `tests/messenger/slack.test.ts:12`
- **Issue**: `Handler` 타입이 `(args: unknown) => Promise<unknown> | unknown`으로 선언되어 있는데, `unknown`은 TypeScript에서 top type이라 `Promise<unknown>`을 흡수한다. eslint rule `@typescript-eslint/no-redundant-type-constituents`가 이를 에러로 잡는다. 또한 `factory.test.ts:7`과 `slack.test.ts:40`에 더 이상 필요 없는 `eslint-disable-next-line @typescript-eslint/no-unused-vars` 주석이 남아 있어 warning 2건이 추가로 발생한다 (eslint config의 `argsIgnorePattern: "^_"` 때문에 `_opts` 파라미터는 애초에 룰 발동 대상이 아님).
- **Impact**: CLAUDE.md의 per-change development loop는 "Build must pass. Fix all errors before moving on; do not proceed with a dirty typecheck"라고 명시한다 (stage 2). `npm run lint`가 실패 상태인 채로 stage 3(review)에 진입했기 때문에 그 다음 stage 6(commit) 역시 막힌다. lint error 1건, warning 2건.
- **Current code**:
  ```typescript
  // tests/messenger/slack.test.ts:12
  type Handler = (args: unknown) => Promise<unknown> | unknown;
  ```
  ```typescript
  // tests/messenger/slack.test.ts:39-41, factory.test.ts:6-8
  class App {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_opts: unknown) {}
  ```
- **Recommended fix**:
  ```typescript
  // tests/messenger/slack.test.ts:12
  // `unknown` absorbs Promise<unknown> in a union, so express the
  // sync/async shape as a single Promise<void> | void return and
  // use `unknown` only for the argument (Bolt hands us typed payloads
  // but the mock only cares about forwarding them).
  type Handler = (args: unknown) => Promise<void> | void;
  ```
  ```typescript
  // both test files — drop the unused disable directive
  class App {
    constructor(_opts: unknown) {}
  ```
  `_opts`는 eslint config의 `argsIgnorePattern`이 이미 커버하므로 주석은 불필요하다. 이 변경 후 `npm run lint` 클린. 참고: `Handler`의 반환 타입을 `void | Promise<void>`로 바꾸면 `mockState.messageHandler?.(payload)`가 `Promise<void> | void`를 돌려주고, 테스트에서 `await`해도 문제없다 (await on void → undefined).

---

## Medium Findings

### M1. PDF-only 파일 공유가 빈 mention으로 core.ts에 흘러간다
- **Severity**: MEDIUM
- **Category**: Data flow / Two-mode routing
- **File**: `src/messenger/slack.ts:113`
- **Issue**: `message` handler의 guard는 `if (!msg.text && !msg.files?.length) return`이다. 사용자가 PDF/zip을 텍스트 없이 드롭하면 `msg.text === ''`이고 `msg.files.length === 1`이므로 이 가드를 **통과한다**. 그 다음 `extractImages`가 non-image 파일을 모두 필터링해 `[]`를 반환하고, 결국 `{ text: '', images: undefined }`가 `messageHandler`로 전달된다. `src/agent/core.ts:139`의 `handleMessage`는 빈 텍스트 가드가 없어서 auth → audit → 🤔 reaction → "Thinking..." 메시지 → Claude CLI 빈 프롬프트 호출 순으로 전체 파이프라인을 돈다.
- **Impact**: (a) 아무 의도 없이 드롭한 PDF 한 장이 Claude API 토큰을 태우고, (b) 조용히 무시했어야 할 이벤트가 Slack 채널에 "🤔 Thinking..." → "✅" 잔여 노이즈를 남기고, (c) audit log에 빈 command 항목이 쌓인다. 개발자 한 명 사용 환경에서는 실제 페이징 문제는 안 나지만 UX 노이즈는 확실하다. M1 core 리뷰에서 빈 텍스트 가드가 처리되었어야 했는데 messenger 쪽에서도 좀 더 방어적으로 막을 수 있다.
- **Current code**:
  ```typescript
  if (!msg.text && !msg.files?.length) return Promise.resolve();
  // ...
  const images = this.extractImages(msg.files);
  ```
- **Recommended fix**:
  ```typescript
  if (!msg.text && !msg.files?.length) return Promise.resolve();

  const eventTs = msg.ts ?? "";
  if (this.isDuplicate(eventTs)) return Promise.resolve();

  const images = this.extractImages(msg.files);
  // If the only thing in this event is a non-image file attachment,
  // there's nothing actionable for the agent yet (no vision support for
  // PDFs/zips in v1). Drop it at the messenger layer rather than booting
  // a Claude call with an empty prompt.
  if (!msg.text && images.length === 0) return Promise.resolve();
  ```
  이 가드는 core.ts의 빈 텍스트 핸들링과 이중 방어 관계로, messenger 레이어에서 "nothing actionable" 이벤트를 조기에 drop하는 편이 감사 로그와 reaction 노이즈를 줄인다. 더불어 `tests/messenger/slack.test.ts`에 PDF-only 케이스를 추가해 회귀를 막는다.

### M2. `sendApproval`의 짧은 경로에서 rate limiter가 생략된다
- **Severity**: MEDIUM
- **Category**: Rate limiting / API correctness
- **File**: `src/messenger/slack.ts:300`
- **Issue**: `sendApproval`의 `text.length <= BLOCK_TEXT_LIMIT` 경로(line 299–311)는 `postMessage` 호출 전에 `rateLimiter.acquire()`를 부르지 않는다. 긴 경로(line 287–298)는 `sendText`(내부에서 acquire)와 명시적 `acquire`를 모두 호출한다. 일관성이 깨져 있다.
- **Impact**: 단일 사용자 Slack 봇이 한 번에 다섯 개 승인을 쏘는 시나리오(M4–M6의 weekly orchestrator가 여러 skill의 `blog_publish`/`metadata_change`/`review_reply`를 연속 제출하는 경우)에서 burst 5 예산을 쓰지 않고 곧장 `postMessage`가 나가면 Slack Tier 2 rate limit(~1/sec)을 초과할 수 있다. 실전 확률은 낮지만 M6 orchestrator가 돌기 시작하면 노출 가능성이 올라간다.
- **Current code**:
  ```typescript
  } else {
    await this.app.client.chat.postMessage({
      channel: channelId,
      text,
      ...(threadId ? { thread_ts: threadId } : {}),
      blocks: [ /* ... */ ],
    });
  }
  ```
- **Recommended fix**:
  ```typescript
  } else {
    await this.rateLimiter.acquire();
    await this.app.client.chat.postMessage({
      channel: channelId,
      text,
      ...(threadId ? { thread_ts: threadId } : {}),
      blocks: [ /* ... */ ],
    });
  }
  ```
  `updateText`의 첫 `chat.update` 호출(line 243)에도 같은 불일치가 있지만 `chat.update`는 Tier 3(~50/min)라 우선순위는 낮다. 별도 LOW 항목으로 남김.

### M3. Reaction 실패 warn 로그가 정상 운영 환경에서 디스크 로그 스팸이 될 수 있다
- **Severity**: MEDIUM
- **Category**: Observability / Disk usage
- **File**: `src/messenger/slack.ts:326-331, 345-349`
- **Issue**: pilot-ai의 `catch {}`를 `catch (err) { logWarn(...) }`로 바꾼 것 자체는 옳다 (silent swallow는 디버그 시 미궁). 그러나 Slack reactions API는 정상 동작 중에도 `already_reacted`, `invalid_name`, 채널 권한 문제 등으로 **일상적으로 실패한다**. `core.ts`의 handleMessage가 매 메시지마다 `thinking_face` → `removeReaction('thinking_face')` → `addReaction('gear')` → `removeReaction('gear')` → `addReaction('white_check_mark')` 순으로 5회 reaction을 호출하는데, 스레드에서 이미 동일 emoji가 붙어 있거나 race condition이 발생하면 매 메시지마다 warn 로그가 2–3개씩 쌓인다. 일주일간 하루 50개 메시지면 ~1000줄 추가. 그 자체로 `~/.adaria/logs/`를 터뜨리진 않지만 **신호 대 노이즈 비율이 나빠서 실제 문제가 있을 때 warn 검색이 괴로워진다.**
- **Impact**: 운영 중 warn 레벨 로그가 "false alarm"으로 오염되어 진짜 문제 조기 탐지를 방해. M8 rollback 훈련 등에서 로그 읽는 시간이 증가.
- **Recommended fix**:
  ```typescript
  import {
    info as logInfo,
    warn as logWarn,
    error as logError,
    debug as logDebug,
  } from "../utils/logger.js";

  async addReaction(
    channelId: string,
    messageTs: string,
    emoji: string,
  ): Promise<void> {
    try {
      await this.app.client.reactions.add({
        channel: channelId,
        timestamp: messageTs,
        name: emoji,
      });
    } catch (err) {
      // Reaction failures are routine (already_reacted, race conditions,
      // missing scope during bootstrap). Log at debug so they're
      // discoverable with ADARIA_LOG_LEVEL=debug but don't pollute
      // the default warn stream.
      logDebug(
        `addReaction(${emoji}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  ```
  같은 패턴을 `removeReaction`에도 적용. 정말 drop해선 안 되는 실패(예: invalid_auth, token_revoked)는 `app.error` 핸들러가 잡아주므로 이 reaction path에서 굳이 warn을 올릴 필요는 없다.

### M4. 테스트 커버리지 갭: `sendApproval`, dedup 트림, file-share 경로
- **Severity**: MEDIUM
- **Category**: Test gaps
- **Files**: `tests/messenger/slack.test.ts`
- **Issue**: 15개 테스트가 있지만 다음이 빠져 있다:
  1. `sendApproval` — Block Kit approve/reject 페이로드 생성이 한 번도 검증되지 않는다. 이 메서드는 M1 safety.ts 포트와 M4 이후 모든 skill write path의 공통 진입점이다.
  2. dedup high-water-mark 트림(1000→500) — `isDuplicate`의 Set → array → slice → Set 사이클이 insertion order를 유지한다는 사실을 증명하는 테스트가 없다. 나는 `node -e`로 수동 검증했지만(Set iteration order는 ECMAScript 명세상 insertion order라 OK), 회귀 방어선이 없다.
  3. PDF-only file-share 이벤트가 `messageHandler`에 도달하는지 여부 — M1의 실제 버그(M1)를 고정화하려면 이 케이스가 필요.
  4. `isDuplicate(ts: "")` — 빈 ts가 dedup을 bypass하는 현재 동작이 **의도된** 것인지 (synthetic-message 지원 때문)를 테스트가 문서화해야 한다.
  5. `app.error` 핸들러가 `logError`로 routing되는지 — 현재 `errorHandler` 필드는 mockState에 있지만 assert하는 테스트가 없다.
- **Impact**: `safety.ts`(M1 이미 포트됨)가 `sendApproval`을 호출하는 경로가 계약으로 굳어지지 않아서 M4 이후 skill 포트에서 silent breakage 위험.
- **Recommended fix**: 아래 테스트 추가.
  ```typescript
  describe("sendApproval", () => {
    it("posts a single message with section + actions blocks under the limit", async () => {
      const adapter = newAdapter();
      await adapter.sendApproval("C1", "publish this blog?", "task-1", "t-root");
      expect(mockState.postedMessages).toHaveLength(1);
      const posted = mockState.postedMessages[0];
      expect(posted?.thread_ts).toBe("t-root");
      expect(posted?.blocks).toHaveLength(2);
      const actions = (posted?.blocks?.[1] as { elements: Array<{ action_id: string; value: string }> });
      expect(actions.elements.map((e) => e.action_id)).toEqual(["approve_task", "reject_task"]);
      expect(actions.elements[0]?.value).toBe("task-1");
    });

    it("falls back to plain text + buttons-only message when text exceeds block limit", async () => {
      const adapter = newAdapter();
      const long = "a".repeat(3500);
      await adapter.sendApproval("C1", long, "task-2", "t-root");
      // One or more sendText chunks + one buttons-only post.
      expect(mockState.postedMessages.length).toBeGreaterThanOrEqual(2);
      const last = mockState.postedMessages.at(-1);
      expect(last?.text).toBe("Approve or reject?");
      expect(last?.blocks).toHaveLength(1);
    });
  });

  describe("dedup", () => {
    it("trims the processed-message set to 500 when it hits 1000 while keeping the newest entries", async () => {
      const adapter = newAdapter();
      adapter.onMessage(() => {});
      // Send 1005 unique ts values, then re-send #5 and #1005.
      for (let i = 0; i < 1005; i++) {
        await mockState.messageHandler?.({
          message: { user: "U1", channel: "C1", ts: `ts-${i}`, text: "hi" },
        });
      }
      const capturedBefore: IncomingMessage[] = [];
      adapter.onMessage((msg) => capturedBefore.push(msg));
      // ts-5 was evicted (was in the first 505 entries); should be accepted.
      await mockState.messageHandler?.({
        message: { user: "U1", channel: "C1", ts: "ts-5", text: "hi" },
      });
      // ts-1004 should still be in the trimmed set; should be deduped.
      await mockState.messageHandler?.({
        message: { user: "U1", channel: "C1", ts: "ts-1004", text: "hi" },
      });
      expect(capturedBefore).toHaveLength(1);
      expect(capturedBefore[0]?.eventTs).toBe("ts-5");
    });
  });

  it("drops file_share events that contain no images and no text", async () => {
    const adapter = newAdapter();
    const captured: IncomingMessage[] = [];
    adapter.onMessage((msg) => captured.push(msg));

    await mockState.messageHandler?.({
      message: {
        user: "U1",
        channel: "C1",
        ts: "1700000333.444",
        subtype: "file_share",
        text: "",
        files: [{ url_private: "https://x", mimetype: "application/pdf", name: "report.pdf" }],
      },
    });

    expect(captured).toHaveLength(0);
  });
  ```

---

## Low Findings

### L1. `updateText`의 첫 `chat.update` 호출이 rate limiter를 건너뛴다
- **Severity**: LOW
- **Category**: Rate limiting
- **File**: `src/messenger/slack.ts:243`
- **Issue**: M2와 동일한 패턴. `chat.update`는 Tier 3(~50/min)라서 실전 문제 가능성은 낮지만 일관성 차원에서 `await this.rateLimiter.acquire()` 추가를 권한다.
- **Fix**: line 242와 243 사이에 `await this.rateLimiter.acquire();` 한 줄 추가.

### L2. `splitMessage` 반환 배열에 의존한 `chunks[0] ?? ""` fallback이 데드 코드에 가깝다
- **Severity**: LOW
- **Category**: Code clarity
- **File**: `src/messenger/slack.ts:242`
- **Issue**: `splitMessage`는 빈 문자열 `""`에도 `[""]`를 돌려준다(`text.length <= maxLength` 분기로 즉시 return). 따라서 `chunks[0]`은 항상 정의되어 있고, `?? ""` fallback은 noUncheckedIndexedAccess를 달래기 위한 의례적 패턴일 뿐이다. 250 라인의 `chunks[i] ?? ""`도 마찬가지. 동작상 문제는 없지만 독자에게 "chunks가 sparse할 수 있나?"는 오해를 줄 수 있다.
- **Fix**: 선택 사항. 가독성을 우선시한다면 `const head = chunks[0]; if (!head) return;`처럼 명시적 early-return으로 바꾸거나, JSDoc에 "splitMessage never returns an empty array or sparse entries"를 명기하고 `?? ""` 제거.

### L3. `parseFloat(eventTs || "0")` vs `parseFloat(eventTs)`의 비대칭
- **Severity**: LOW
- **Category**: Defensive coding consistency
- **File**: `src/messenger/slack.ts:126, 152`
- **Issue**: `message` 핸들러는 `msg.ts ?? ""` 후 `parseFloat(eventTs || "0")`로 이중 방어한다. `app_mention` 핸들러는 `event.ts`를 바로 받아 `parseFloat(eventTs)`로 처리한다. Bolt의 `app_mention` 이벤트 타입 정의상 `event.ts`는 항상 string이긴 하지만 message 경로에서 보여준 방어성과 일관성이 어긋난다. 어느 한 쪽으로 통일하면 코드 리뷰 부담이 줄어든다.
- **Fix**: 둘 다 동일 패턴으로:
  ```typescript
  const eventTs = event.ts ?? "";
  // ... later ...
  timestamp: new Date(parseFloat(eventTs || "0") * 1000),
  ```

### L4. `logError` 핸들러는 `Promise.resolve()`를 명시적으로 반환할 필요가 없다
- **Severity**: LOW
- **Category**: Code style
- **File**: `src/messenger/slack.ts:66-71`
- **Issue**: Bolt의 `app.error` 시그니처는 `(err) => Promise<unknown> | unknown`을 받는다. 여기서는 sync 핸들러라 `return Promise.resolve()` 대신 아무 것도 반환하지 않는 arrow function이어도 괜찮다. `no-misused-promises` 룰과 싸우려고 넣은 게 아니라면 (지금 구조에서 그 룰은 트리거되지 않음) 제거 가능.
- **Fix**:
  ```typescript
  this.app.error((err) => {
    logError(
      `Slack unhandled error: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  ```

---

## Informational

### I1. H3 회귀 수정은 두 핸들러 모두에 정확히 반영되었다
- **File**: `src/messenger/slack.ts:115-129` (`message`), `src/messenger/slack.ts:145-155` (`app_mention`)
- 두 경로 모두 `const eventTs = ...` 선언 후 `incoming.eventTs = eventTs`를 필수 필드로 설정한다 (growth-agent Phase 1의 reaction-on-thread-root 회귀를 막는 원래 목적). `exactOptionalPropertyTypes` 때문에 `threadId`와 `images`는 conditional 할당(`if (threadId)` / `if (images.length > 0)`)으로 처리됐고, 어디에도 `undefined`가 명시적으로 대입되지 않는다. 정확하다.
- `core.ts`(M1 이미 포트됨)가 `msg.eventTs`를 reaction의 단일 소스로 쓰고 있어(line 174–180) end-to-end 흐름이 닫힌다.
- 단 한 가지 짚을 점: `message` 핸들러의 `eventTs || "0"` fallback(line 126)은 `msg.ts`가 undefined인 경우 빈 문자열을 IncomingMessage.eventTs로 할당한다. core.ts의 `if (eventTs)`는 빈 문자열을 falsy로 처리하므로 reaction은 정상 skip되지만, audit/log가 `eventTs: ""`를 보게 된다. 클린하진 않다 — M6/M1e synthetic-message path에서 `eventTs`가 아예 없는 케이스와 혼동할 수 있다. `if (msg.ts) incoming.eventTs = msg.ts;` 쪽이 더 명확하지만 M1 테스트가 항상 `ts`를 넣어주기 때문에 회귀 증거는 없다. 리팩토링 시 검토.

### I2. pilot-ai diff는 명시된 4가지 변경 이상을 넘지 않는다
- `eventTs` 추가, Telegram 삭제, structured logger 치환, `botToken` 인스턴스 stash 축소 — 주석에 명시된 4가지만 diff에 나타난다.
- `botToken`은 여전히 `this.botToken`으로 저장되어 `extractImages`의 `Authorization: Bearer`에 쓰이는데(line 190), 커밋 메시지/주석의 "no longer re-stashed on the instance for general use"는 "general use"의 정의가 애매하다. `files.url_private` 인증 헤더 용도는 유지되어야 하므로 현 구현이 맞다 — 주석이 정확한 그림을 전달하는지만 재확인 권장.

---

## Data Flow Issues

| Path | Status |
|---|---|
| Slack `message` event → `setupListeners` → `messageHandler` → core.ts `handleMessage` | ✅ `eventTs` 세팅 확인, auth 체크는 core.ts 소관 |
| Slack `app_mention` event → (same) | ✅ 동일 |
| `app_mention` 메시지와 `message` 이벤트의 중복 전달 | ✅ `isDuplicate(ts)`로 순서 무관 dedup 검증됨 (test line 237) |
| PDF-only file_share → messageHandler 도달 | ⚠️ M1 (messenger에서 조기 drop 권장) |
| sendApproval → Slack Block Kit → approve/reject action → approvalHandler → safety.ts | ⚠️ Block Kit 생성 로직 테스트 없음 (M4) |
| `chat.update` + 초과 chunk `postMessage` 를 통한 in-place 메시지 업데이트 | ✅ 로직 OK, rate limiter 첫 호출 생략 미세 문제 (L1) |
| 1005개 연속 이벤트 → dedup set 트림 | ✅ Set iteration order 유지 (ECMAScript spec) — 회귀 테스트 없음 (M4) |

---

## Two-mode routing integrity

이 리뷰 범위는 messenger 레이어(`src/messenger/*`)로 한정되어 core.ts의 Mode A/B 분기에는 직접 영향이 없다. 다만 messenger가 전달하는 `IncomingMessage`가 core.ts `handleMessage`의 입력 전제라서 다음 두 가지만 확인:

1. **`text` 필드 일관성**: 두 핸들러 모두 `text: msg.text ?? ""` 또는 strip 후 `text`를 설정한다. Mode A skill registry의 prefix 매칭은 빈 문자열을 skill 매치 실패로 처리하므로 Mode B(conversational)로 fall through한다. PDF-only 드롭(M1) 시 빈 텍스트가 Mode B로 넘어가 Claude CLI 호출 → 의미 없는 응답. messenger 레이어에서 drop하는 것이 Mode A/B 분기 건강에도 맞다.

2. **`eventTs` 일관성**: reaction은 `eventTs`에 의존하고, 이 값은 Mode A/B 공통. H3 고정 이후 두 mode 모두 정상.

Skill이 MCP tool로 노출되는 변경 없음. Write path는 여전히 `safety.ts`만 통과.

---

## Positive Observations

1. **H3 회귀 수정이 두 핸들러 모두에 적용되었다** — 2개 site 중 하나만 고치는 건 쉬운 실수인데 둘 다 `eventTs` 필드를 설정한다. 테스트도 `message`와 `app_mention` 각각에 대해 `expect(captured[0]?.eventTs).toBe(...)`로 검증한다.
2. **`exactOptionalPropertyTypes` 준수** — `threadId?`, `images?` 모두 `if (value)` 가드 후 할당하는 패턴으로 `undefined` 명시적 대입을 피한다. `sendText`/`updateText`/`sendApproval`의 `...(threadId ? { thread_ts: threadId } : {})` spread 패턴도 일관적이다.
3. **`botToken` stash 축소의 의도는 옳다** — instance-level 필드로 남긴 것은 `files.url_private` auth header 용도이고, 그 외 경로는 모두 `this.app.client`에만 위임. Token을 instance에서 읽는 코드 경로는 `extractImages` 한 곳뿐이라 공격 표면이 최소화되어 있다.
4. **Structured logger 치환이 노이즈 억제에 맞게 동작** — pilot-ai의 `console.log(JSON.stringify(event))`가 전부 `logInfo`/`logWarn`/`logError`로 치환되었다. launchd가 stderr를 `~/.adaria/logs/`에 덤프하는 환경에서 JSON 한 줄 로그만 남는다.
5. **factory.ts의 scope가 정확** — `AdariaConfig`의 top-level `config.slack` 구조 변화를 흡수하고, 그 이상(logger 주입, DB 주입 등)으로 확장되지 않았다. 향후 두 번째 platform이 생기면 여기 한 파일만 `switch`로 확장하면 된다.
6. **dedup 로직이 `message`↔`app_mention` 순서 무관성을 정확히 보장** — test line 237("dedupes a mention if the corresponding message event was already handled")이 그걸 고정화한다. `isDuplicate`가 ts만 키로 쓰기 때문에 순서는 무관.
7. **Telegram 제거 완결** — src 내 `telegram` 등장은 주석 3건뿐이고 모두 "dropped"를 문서화하는 맥락. 코드 경로에는 남아 있지 않다.

---

## Action Items

- [ ] **H1**: `tests/messenger/slack.test.ts:12`의 `Handler` 타입을 `(args: unknown) => Promise<void> | void`로 수정. `factory.test.ts:7`, `slack.test.ts:40`의 사용되지 않는 `eslint-disable-next-line` 주석 제거. `npm run lint` 클린 확인 후 stage 3(review)→4(test)→5(checklist)→6(commit) 재진행.
- [ ] **M1**: `src/messenger/slack.ts` message 핸들러에 `if (!msg.text && images.length === 0) return` 가드 추가. `tests/messenger/slack.test.ts`에 PDF-only file_share 회귀 테스트 추가.
- [ ] **M2**: `src/messenger/slack.ts:300` 직전에 `await this.rateLimiter.acquire();` 추가.
- [ ] **M3**: `logWarn` → `logDebug`로 reaction 실패 로깅 레벨 강등. (정말 유의미한 auth 실패는 `app.error` 핸들러가 잡는다.)
- [ ] **M4**: 테스트 추가 — `sendApproval` short/long path, dedup trim의 insertion-order 유지, PDF-only file_share drop, `isDuplicate("")` 동작 문서화.
- [ ] **L1**: `updateText`의 첫 `chat.update` 직전 `rateLimiter.acquire()` 추가 (일관성).
- [ ] **L2**: `chunks[0] ?? ""` / `chunks[i] ?? ""`를 명시적 early-return으로 교체하거나 splitMessage invariant를 JSDoc에 명기.
- [ ] **L3**: `app_mention` 핸들러의 `parseFloat` 전처리를 `message` 핸들러와 동일하게 정렬.
- [ ] **L4**: `app.error` 콜백에서 명시적 `return Promise.resolve()` 제거.
- [ ] **I1** (optional): `message` 핸들러에서 `msg.ts`가 없는 경우 `eventTs: ""` 설정 대신 `if (msg.ts)` conditional 할당으로 바꾸는 것을 다음 리팩토링에서 검토.
