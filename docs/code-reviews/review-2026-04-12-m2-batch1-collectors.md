# Code Review: M2 Batch 1 — App Store / Play Store Collector Port

**Date**: 2026-04-12
**Scope**: `src/collectors/appstore.ts`, `src/collectors/playstore.ts`, `src/types/collectors.ts`, `src/utils/errors.ts` (RateLimitError 추가), `tests/collectors/appstore.test.ts`, `tests/collectors/playstore.test.ts`, `package.json` (+jose)
**Milestone**: M2 — Collector port (첫 배치 2/8)
**Commit(s)**: uncommitted working tree (`git status`: untracked `src/collectors/`, `src/types/`, `tests/collectors/`; modified `src/utils/errors.ts`, `package.json`)
**Reference sources**: `/Users/ahnwoojin/growth-agent/src/collectors/{appstore,playstore,errors,retry}.js`

## Summary

growth-agent JS 컬렉터 2종을 adaria-ai의 strict TS + `exactOptionalPropertyTypes` 규약에 맞게 포팅한 깔끔한 첫 배치. 원본의 동작(토큰 캐시, 429 처리, 길이 리밋, 리뷰 매핑)을 빠짐없이 옮겼고, 오히려 JS 버전의 몇 가지 허점(`NaN` retry-after, `body.data` 방어)을 무해하게 보강했다. 레거시 필드명 `review_id`/`created_at`을 `reviewId`/`createdAt`으로 의식적으로 통일한 판단도 적절하다. CRITICAL은 없으며 HIGH 1건(원본 대비 필드명/에러 타입 계약 변경을 milestone 문서에 명시 필요), MEDIUM/LOW 몇 건으로 정리된다.

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 1 |
| MEDIUM | 4 |
| LOW | 4 |
| INFO | 3 |

**Overall Grade**: A-
**Milestone fit**: M2 스코프 정확히 일치. 스킬/오케스트레이터/DB 레이어 건드리지 않았고, M5에서 Approval 게이트 뒤에 붙을 write 경로는 "length validation만 책임" 계약을 지켰다.

---

## Critical & High Findings

### H1. 원본 대비 리턴 스키마·에러 필드명 변경이 문서화되지 않음 (breaking for M4+ 스킬)

- **Severity**: HIGH
- **Category**: Architecture / Porting parity
- **Files**:
  - `src/collectors/appstore.ts:242-247` (`getReviews` 반환)
  - `src/collectors/appstore.ts:152-161` (`getAppLocalizations` 반환 쉐입)
  - `src/utils/errors.ts:108-121` (`RateLimitError.retryAfterSeconds`)
- **Issue**: 포팅 브리프는 "원본의 함수 시그니처/행동을 유지"라고 명시했는데, 실제로는 4개 지점에서 **wire 쉐입이 바뀌었다**:
  1. `AppStoreCollector.getReviews` → `{review_id, body, rating, created_at}` → `{reviewId, rating, body, createdAt}` (snake → camel)
  2. `PlayStoreCollector.getReviews` → 동일한 snake→camel 전환
  3. `AppStoreCollector.getAppLocalizations` → 원본은 App Store Connect API의 raw `{id, attributes: {...}}` JSON:API 쉐입을 그대로 반환했지만, 포팅본은 **flat** `AppStoreLocalization` ({id, locale, name, subtitle, keywords, description})로 펼쳐서 반환한다
  4. `RateLimitError.retryAfter` (JS) → `RateLimitError.retryAfterSeconds` (TS)
- **Impact**: M4에서 `AsoSkill`·`ReviewSkill`을 포팅할 때 growth-agent의 `src/agents/*-agent.js`가 `review.review_id`, `localizations.attributes.name`, `err.retryAfter`에 직접 접근하는 코드라면 전부 깨진다. 특히 `getAppLocalizations`의 flatten은 가장 침투적인 변경인데 (`match.attributes.name` → `loc.name`), 스킬 포터가 원본 growth-agent 코드를 기계적으로 옮기다가 런타임에만 잡히는 타입 미스매치를 일으키기 쉽다. 지금 잡지 않으면 M4~M5에서 디버깅 비용이 될 사안이다.
- **Current code** (appstore.ts):
  ```typescript
  return (data.data ?? []).map((r) => ({
    reviewId: r.id,
    rating: r.attributes.rating,
    body: r.attributes.body,
    createdAt: r.attributes.createdDate,
  }));
  ```
  그리고 `AppStoreLocalization`은 raw가 아니라 펼친 shape.
- **Recommended fix**: 코드는 그대로 두되 (camelCase·flat이 타입 안전성 측면에서 더 낫다), **스키마 변경을 명시적으로 기록**해야 한다. 두 가지 조합을 권장:

  1. `docs/growth-agent/porting-matrix.md` 의 appstore/playstore row에 "Wire shape delta" 섹션을 추가:
     ```markdown
     **Wire shape delta (M2 batch 1):**
     - `StoreReview` uses camelCase (`reviewId`, `createdAt`) — DB insert sites
       in M3 must map accordingly.
     - `getAppLocalizations` returns flattened `AppStoreLocalization`, not the
       raw `{id, attributes}` JSON:API object. Downstream ASO prompt builders
       in M4 should read `loc.name` directly, not `loc.attributes.name`.
     - `RateLimitError` field renamed `retryAfter` → `retryAfterSeconds` and
       moved from `src/collectors/errors.js` to `src/utils/errors.ts`.
     ```
  2. `src/types/collectors.ts`의 JSDoc에 한 줄 추가 (이미 "wire format" 언급이 있으니 확장):
     ```typescript
     /**
      * Unified customer review shape across App Store and Google Play.
      *
      * NOTE: fields are camelCase. growth-agent (JS) returned snake_case
      * (`review_id`, `created_at`); skills ported in M4+ must use the new names.
      */
     export interface StoreReview { ... }
     ```

  이건 코드 결함이 아니라 **계약 변경 누락**이다. 명시만 해 두면 HIGH에서 INFO로 떨어뜨릴 수 있다.

---

## Medium & Low Findings

### M1. App Store `updateLocalization` / `replyToReview` 해피패스 테스트 부재

- **Severity**: MEDIUM
- **Category**: Test coverage
- **Files**: `tests/collectors/appstore.test.ts:194-216`
- **Issue**: 두 함수 모두 length/empty 검증 rejection만 테스트하고, 성공 경로(`PATCH /appInfoLocalizations/{id}` 요청이 실제로 어떤 URL·body로 나가는지, `POST /customerReviewResponses`에 review relationship이 올바르게 박히는지)를 전혀 검증하지 않는다. Play Store쪽은 `replyToReview` 해피패스 테스트(라인 207-231)가 있는데 비대칭이다. App Store Connect의 JSON:API 래핑은 사람이 실수하기 쉬운 포맷이라(특히 `data.type`, `relationships.review.data.type`) 회귀 가드가 필요하다.
- **Impact**: M5에서 `metadata_change` / `review_reply` approval 경로가 생겼는데 바디 포맷이 잘못 빠져나가도 이 레이어에서는 잡히지 않는다. 실제 승인된 변경이 400으로 튕기는 증상이 프로덕션에서 처음 관찰될 수 있다.
- **Recommended fix**: Play Store 테스트의 `replyToReview posts to the reply endpoint with JSON body` 패턴을 그대로 복사해서 두 테스트 추가:
  ```typescript
  it("updateLocalization sends PATCH with JSON:API envelope", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ ok: true, status: 200, json: () => Promise.resolve({}) })
    );
    await collector.updateLocalization("loc-1", {
      name: "신제품",
      keywords: "레시피,냉장고",
    });
    const call = mockFetch.mock.calls[0];
    expect(call?.[0]).toContain("/appInfoLocalizations/loc-1");
    const init = call?.[1] as { method: string; body: string };
    expect(init.method).toBe("PATCH");
    const parsed = JSON.parse(init.body) as {
      data: { type: string; id: string; attributes: Record<string, string> };
    };
    expect(parsed.data.type).toBe("appInfoLocalizations");
    expect(parsed.data.id).toBe("loc-1");
    expect(parsed.data.attributes.name).toBe("신제품");
    expect(parsed.data.attributes.keywords).toBe("레시피,냉장고");
    // subtitle/description not provided → must not be echoed
    expect(parsed.data.attributes.subtitle).toBeUndefined();
  });

  it("replyToReview sends POST with customerReviewResponses envelope", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ ok: true, status: 201, json: () => Promise.resolve({}) })
    );
    await collector.replyToReview("review-99", "감사합니다");
    const call = mockFetch.mock.calls[0];
    expect(call?.[0]).toContain("/customerReviewResponses");
    const init = call?.[1] as { method: string; body: string };
    expect(init.method).toBe("POST");
    const parsed = JSON.parse(init.body) as {
      data: {
        type: string;
        attributes: { responseBody: string };
        relationships: { review: { data: { type: string; id: string } } };
      };
    };
    expect(parsed.data.type).toBe("customerReviewResponses");
    expect(parsed.data.attributes.responseBody).toBe("감사합니다");
    expect(parsed.data.relationships.review.data).toEqual({
      type: "customerReviews",
      id: "review-99",
    });
  });
  ```
  또 마지막 어서션(`subtitle undefined`)은 `exactOptionalPropertyTypes` 환경에서 conditional attribute assembly를 회귀 없이 잡아주는 핵심 가드다.

### M2. `Retry-After` HTTP-date 포맷을 무시 (동작 파리티 이슈)

- **Severity**: MEDIUM
- **Category**: External API robustness
- **Files**: `src/collectors/appstore.ts:112-118`, `src/collectors/playstore.ts:126-132`
- **Issue**: `parseInt(header ?? "60", 10)`는 `Retry-After`가 초 단위 정수일 때만 올바르다. RFC 7231은 `Retry-After: Fri, 31 Dec 2026 23:59:59 GMT` 같은 HTTP-date 포맷도 허용하며 양쪽 API가 실제로 (특히 429 under heavy load에서) 이 포맷을 보낼 가능성이 있다. 현재 코드는 `parseInt("Fri...")` → `NaN` → `Number.isFinite(NaN) === false` → 60초 고정으로 떨어진다(원본 JS는 `NaN`을 그대로 저장해서 더 나쁨 — 이건 **포팅본이 무해하게 개선한 지점**이지만 정답은 아님).
- **Impact**: API가 실제로는 "2시간 후에 오세요"라고 말했는데 60초 후 폭주 재시도. App Store Connect는 분당 레이트 리밋이 꽤 빡빡해서 M5+ orchestrator 파이프라인에서 이 차이가 체감된다.
- **Recommended fix**: 공용 파서를 `src/utils/errors.ts` 근처나 `src/utils/retry.ts`에 추가하고 양쪽에서 호출:
  ```typescript
  export function parseRetryAfter(header: string | null, fallback = 60): number {
    if (!header) return fallback;
    const asSeconds = Number(header);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds;
    const asDate = Date.parse(header);
    if (Number.isFinite(asDate)) {
      return Math.max(0, Math.ceil((asDate - Date.now()) / 1000));
    }
    return fallback;
  }
  ```
  그리고 양쪽 collector에서:
  ```typescript
  throw new RateLimitError("App Store API rate limited", {
    retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After")),
  });
  ```
  이 고칠 때 파리티가 깨지지만, 문서화된 개선 (M2 review 결과)으로 두면 된다. 지금 안 하면 정확히 같은 버그를 8개 컬렉터에 복제하게 된다 — M2 배치 끝나기 전에 해결하는 게 best.

### M3. `request()` 헤더 머지가 `HeadersInit`의 비-plain-object 변종을 소리 없이 삼킴

- **Severity**: MEDIUM
- **Category**: TypeScript correctness / API robustness
- **Files**: `src/collectors/appstore.ts:104-108`, `src/collectors/playstore.ts:118-122`
- **Issue**: `...init?.headers`는 `HeadersInit` (DOM 타입)을 object-spread한다. 그런데 `HeadersInit`은 union `Headers | string[][] | Record<string, string>`이며, 이 중 `Headers` 인스턴스나 `[["k","v"], ...]` 배열을 받으면 spread로는 **아무 키도 안 나온다** (객체로 iteration 가능한 키가 없기 때문). TS 타입 시그니처는 `RequestInit`을 통째로 받아들이므로 호출자가 `headers: new Headers(...)`를 넘기면 컴파일은 통과하지만 런타임에 Authorization 헤더만 남는다.
- **Impact**: 당장은 내부 호출자만 `request()`를 쓰므로 (모두 `undefined` 또는 plain object) 실해는 없다. 하지만 M4+ 스킬이나 M5.5 Mode-B `collector-fetch` 툴에서 이 컬렉터를 감싸면서 `RequestInit`을 wire-through할 여지가 있고, 그때 진단 비용이 크다.
- **Recommended fix**: `init` 타입을 좁혀서 애매함을 제거한다:
  ```typescript
  private async request<T>(
    path: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> }
  ): Promise<T> {
    const token = await this.generateToken();
    const url = `${this.baseUrl}${path}`;
    const baseHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    const mergedHeaders = init?.headers
      ? { ...baseHeaders, ...init.headers }
      : baseHeaders;
    const response = await fetch(url, {
      method: init?.method,
      body: init?.body,
      headers: mergedHeaders,
    });
    // ...
  }
  ```
  이렇게 해두면 호출자가 `Headers` 인스턴스를 넘기는 것도 컴파일 타임에 막힌다. Play Store는 같은 방식으로 바꾸되 "body 없을 때 Content-Type 생략" 로직은 유지. 한 번에 전 컬렉터 통일하면 M2 배치 2/3에서 반복 코멘트 불필요.

### M4. Play Store `baseUrl`/`tokenUrl` 생성자 노출 — 보안보다 "테스트 한정 의도"를 타입으로 못 박는 문제

- **Severity**: MEDIUM
- **Category**: Security / API surface hygiene
- **Files**: `src/collectors/appstore.ts:15-22`, `src/collectors/playstore.ts:17-23`
- **Issue**: SSRF 관점에서는 **OK** — 이 컬렉터는 Slack/apps.yaml이 아닌 adaria-ai 코드에서만 `new`되고, config 로더가 생성자를 호출할 때 `baseUrl`/`tokenUrl`을 전달할 경로는 없다 (`src/config/schema.ts`에 해당 필드가 없기를 확인해야 하지만 M2 스코프에선 아직 없다). 따라서 사용자 입력이 이 필드를 오염시킬 표면이 없다. CRITICAL 아님.

  그러나 "테스트에서만 override한다"는 의도가 JSDoc 코멘트 `/** Override the API base URL (tests). */`에만 있고, 타입 시스템으로 강제되지 않는다. 향후 누가 `config.yaml`에서 base URL을 받게 만들 수 있고(→ SSRF 표면 생성), 테스트-only 오버라이드는 일반적으로 타입으로 구분하는 게 낫다.
- **Impact**: 지금은 없음. 미래의 잘못된 리팩터링 방지용.
- **Recommended fix**: (선택 1) test-only 방식으로 명확히 분리 — `options`에서 빼고 `protected` 정적 상수를 `Object.defineProperty`로 덮어쓰거나, internal-only `__testOverrides` 필드로 분리. 경량 버전:
  ```typescript
  export interface AppStoreCollectorOptions {
    keyId: string;
    issuerId: string;
    privateKey: string;
  }

  export interface AppStoreCollectorTestHooks {
    baseUrl?: string;
  }

  export class AppStoreCollector {
    constructor(
      options: AppStoreCollectorOptions,
      testHooks?: AppStoreCollectorTestHooks
    ) {
      // ...
      this.baseUrl = testHooks?.baseUrl ?? DEFAULT_BASE_URL;
    }
  }
  ```
  프로덕션 config 로더는 첫 인자만 넘기므로 base URL을 오염시킬 길이 사라진다. 8개 컬렉터에 반복되기 전에 M2 배치 1에서 패턴을 굳히는 게 좋다.

  (선택 2) 현 구조 유지하되 `src/config/schema.ts`에 "collector base URL override는 절대 스키마에 넣지 말라"는 CODEOWNERS 수준의 주석을 남기는 것으로 대체.

### L1. `parseInt` → `Number.parseInt` 일관성

- **Severity**: LOW
- **Category**: Style / ESLint
- **Files**: `src/collectors/appstore.ts:112`, `src/collectors/playstore.ts:126,158`
- **Issue**: 글로벌 `parseInt` 대신 `Number.parseInt`를 쓰는 게 type-aware ESLint 기본 권장. `src/cli/status.ts`도 이미 `parseInt`를 쓰고 있어 기존 불일치긴 하지만, 새 파일은 원칙대로 가는 게 낫다.
- **Recommended fix**: `Number.parseInt(...)` 로 바꾸고, 원하면 별도 커밋에서 `src/cli/status.ts`도 정리.

### L2. `private cachedToken` / `accessToken`은 `readonly` 불가하지만 `#private` 채택 여부는 정책 이슈로 명시 필요

- **Severity**: LOW
- **Category**: Style consistency
- **Files**: 전반
- **Issue**: 리뷰 요청 4번 포인트(`private readonly` vs `#private`). 코드베이스 전반(`core.ts`, `slack.ts`, `circuit-breaker.ts`, `rate-limiter.ts`, `safety.ts`, `mcp-manager.ts`)이 이미 `private readonly` / `private`으로 통일되어 있다 — 컬렉터가 이 관례를 따른 판단은 **정답**. 추가로 할 일 없음. 단, growth-agent 원본의 `#private` ergo를 쓰고 싶다면 M2 배치 1에서 통일 방침을 세우고 기존 파일까지 마이그레이션해야 하는데, 그건 M2 스코프 아님. 현 선택 유지 권장.
- **Recommended fix**: 없음. INFO로 다뤄도 됨.

### L3. camelCase 리턴 shape 통일에 대한 결정 — 명시만 있으면 OK

- **Severity**: LOW
- **Category**: Style consistency
- **Files**: `src/types/collectors.ts`, `src/collectors/appstore.ts:242`, `src/collectors/playstore.ts:166`
- **Issue**: 리뷰 요청 4번 포인트. DB 스키마(M3)는 아직 없으므로, M3에서 `reviews` 테이블 컬럼을 `review_id TEXT` / `created_at TEXT`로 만들고 insert 시 `reviewId` → `review_id` 매핑만 한 곳에서 하면 된다. 한국어 camelCase가 TS 규약과 맞고 DB 레이어에서 매핑하는 게 여러 layer mix보다 깔끔하다. 결정 자체는 정답이고, M3에서 `src/db/queries.ts` 포팅 시 매핑 함수를 명시하면 끝.
- **Recommended fix**: M3 포팅 시 `src/db/queries.ts` 상단에 `function toReviewRow(r: StoreReview)` 헬퍼로 매핑 지점 단일화.

### L4. `updateLocalization` 빈 업데이트 (`{}`) 방어 없음

- **Severity**: LOW
- **Category**: Input validation
- **Files**: `src/collectors/appstore.ts:168-207`
- **Issue**: `collector.updateLocalization("loc-1", {})`를 호출하면 아무 attribute 없이 PATCH가 나간다. App Store Connect API가 어떻게 응답할지 불명확(400 혹은 no-op). 원본 JS도 같은 허점.
- **Impact**: 실제로는 approval manager에서 "무슨 변경을 승인했는지" 검증하므로 도달 가능성 낮음. 방어는 싸다.
- **Recommended fix**:
  ```typescript
  if (
    update.name === undefined &&
    update.subtitle === undefined &&
    update.keywords === undefined &&
    update.description === undefined
  ) {
    throw new Error("updateLocalization: at least one field must be provided");
  }
  ```

---

## Data Flow Issues

없음. 이 배치는 collectors만 건드렸고, skills/orchestrator/core는 이 클래스들을 아직 import조차 안 한다 (`grep`으로 확인). M4에서 `ctx.collectors` 경유로 붙일 때 별도 리뷰.

## Two-mode routing integrity

N/A — `core.ts` / `src/skills/index.ts` / `src/tools/` 미변경. 다만 **M5.5에서 `collector-fetch` MCP 툴이 이 컬렉터를 감싸게 되면**, Mode B에서 사용자가 자연어로 넘긴 `appId`가 그대로 `getReviews(appStoreId)`에 들어갈 텐데, 현재 `appStoreId`는 path segment로 `/apps/${appStoreId}/...`에 interpolate되어 (`encodeURIComponent` 없음) path traversal 가능성이 있다. Trust boundary가 아직 없으므로 M2에서는 INFO로만 남기고, M5.5 `collector-fetch` 리뷰에서 다시 올리면 된다.

## Security analysis summary

| OWASP | 결과 |
|-------|------|
| A01 Access control | N/A — MCP 툴 노출 없음 |
| A02 Misconfig | private key / service account JSON이 에러 메시지에 누설될 경로 없음. 다만 `JSON.parse(serviceAccountJson)` 실패 시 jose 또는 JSON 파서가 throw하는 에러 메시지에 일부 키가 포함될 수 있음 → **L1 follow-up**: 생성자에서 `try { JSON.parse } catch { throw new AuthError("invalid service account JSON") }`로 감싸기 권장 (아래 INFO 1). |
| A03 Supply chain | `jose ^6.2.2` 추가 — pilot-ai에서도 쓰이던 프로젝트로 신뢰 OK. `package-lock.json` diff 확인 필요. |
| A04 Crypto | ES256 (App Store), RS256 (Play Store), 토큰 캐시 TTL 모두 원본과 동일. 18분(AppStore) / `expires_in - 60s`(Play) 안전 마진 유지. |
| A05 Injection | **SQL**: 이 레이어엔 SQL 없음. **Prompt**: 이 레이어엔 Claude 호출 없음. **Path**: 위의 Two-mode 섹션 참조 (INFO only at M2). **Command**: spawn 없음. **URL**: path interpolation은 apps.yaml trust boundary에서만 발생. |
| A07 Auth | jose 기반 JWT 생성 정확. `private_key`가 메모리에 체류하는 시간은 `importPKCS8` 호출 직후로 제한됨 — 개선 여지 작음. |
| A09 Logging | 위에서 언급. 현재 스코프에서 문제 아님. |

## Positive Observations

- **NaN retry-after 방어**가 원본보다 엄격하다 (`Number.isFinite` 가드). 원본은 `NaN`을 그대로 `this.retryAfter`에 저장해 retry 계산기가 망가질 수 있었는데, 포팅본은 60초로 안전하게 떨어진다.
- **토큰 캐시 테스트**가 "두 번째 호출에서 OAuth 엔드포인트를 다시 치지 않는다"를 URL 필터링으로 검증 — 실수로 `beforeEach`에서 캐시가 리셋되면 명확히 깨지는 정확한 assertion.
- **`exactOptionalPropertyTypes` 대응 방식**이 좋다 — `ExternalApiErrorOptions`를 받을 때 `statusCode: response.status`를 조건 없이 넘기는데, `response.status`는 항상 `number`라서 `undefined` 경고가 발생하지 않는다. Spread-with-conditional 패턴 (`errors.ts:withDefaults`)도 일관.
- **`getAppLocalizations` flatten**이 TS 소비자에게 훨씬 편하다 (optional chain 지옥 제거). 다만 H1에서 언급한 대로 **문서화만** 보강하면 된다.
- **Play Store `request()`의 Content-Type 조건부 세팅** (`init?.body ? { ... } : {}`) — GET 리뷰 호출에 불필요한 Content-Type을 보내지 않아 Google 측이 까다롭게 구는 경우를 피함. 원본도 같은 방식이지만 TS로 옮기면서 실수 없이 유지된 점 좋다.
- **에러 계층 참여**가 기존 `AdariaError` / `withDefaults` 규약에 잘 맞춰 들어갔고, `RateLimitError`만 얇게 추가 — 레이어 오염 없음.
- **`PlayStoreCollector` 생성자에서 `client_email`/`private_key` 존재 검증**을 명시적으로 한 것 (원본 JS는 미검증)이 fail-fast 측면에서 개선.

## Informational notes

- **INFO 1 (A02 follow-up)**: Play Store 생성자의 `JSON.parse(options.serviceAccountJson)`은 유효하지 않은 JSON이 들어오면 `SyntaxError: Unexpected token ...at position N`을 throw하며, 메시지에 잘린 JSON 파편이 포함된다. 보통은 문제 없지만 `config.yaml`에 직접 키 전문을 붙여 넣는 사용자의 경우 로그/audit에 private key의 앞부분이 남을 위험. M3 config 로딩 시점에서 감싸는 편이 낫다:
  ```typescript
  try {
    parsed = JSON.parse(options.serviceAccountJson) as PlayStoreServiceAccount;
  } catch {
    throw new AuthError(
      "PlayStoreCollector: serviceAccountJson is not valid JSON"
    );
  }
  ```
- **INFO 2**: `getReviews` 매개변수 순서가 AppStore `(appStoreId, limit = 50)`와 Play Store `(packageName)`(limit 없음)으로 대칭이 깨졌는데, Google Play Developer API의 reviews 엔드포인트가 기본 페이징이고 `maxResults` 쿼리 파라미터는 문서상 존재한다. 원본 JS 파리티 유지로 OK지만 M4에서 Review skill이 N=100+ 필요할 경우 누락 이슈로 잡힐 수 있음.
- **INFO 3**: `ADARIA_DRY_RUN` 체크가 없는데, 이 레이어에 체크를 넣는 건 아키텍처적으로 잘못 — 올바른 위치는 M5의 `src/agent/safety.ts` ApprovalManager (write 행동을 실행하지 않고 log만). 이 레이어는 "low-level API 래퍼"로 유지하고 DRY_RUN 게이트 책임을 지우지 않은 판단이 옳다.

---

## Action Items

- [ ] **H1** — `porting-matrix.md`와 `src/types/collectors.ts` JSDoc에 wire shape delta (camelCase 리턴, flatten `AppStoreLocalization`, `RateLimitError.retryAfter` → `retryAfterSeconds`) 문서화. M4 포터가 읽을 한 곳.
- [ ] **M1** — `updateLocalization` / `replyToReview` 해피패스 테스트 2개 추가 (JSON:API envelope 검증).
- [ ] **M2** — `parseRetryAfter(header, fallback)` 공용 헬퍼를 `src/utils/retry.ts`에 추가하고 양 컬렉터에서 사용. M2 배치 2/3 시작 전에 처리.
- [ ] **M3** — `request()` 헤더 머지를 `Record<string, string>`으로 타입 제한. 전 컬렉터 통일 패턴 결정.
- [ ] **M4** — `baseUrl`/`tokenUrl` 오버라이드를 별도 `testHooks` 인자로 분리 (또는 "스키마에 넣지 말 것" 주석). M2 배치 2/3 시작 전에 패턴 결정.
- [ ] **L1** — `parseInt` → `Number.parseInt` 치환 (새 코드).
- [ ] **L4** — `updateLocalization` 빈 업데이트 가드.
- [ ] **INFO 1** — `JSON.parse` try/catch wrap + `AuthError` 변환 (Play Store).
- [ ] CLAUDE.md 루프 5단계: `checklist.md`의 `Port src/collectors/appstore.ts + test`, `Port src/collectors/playstore.ts + test` 체크.
- [ ] CLAUDE.md 루프 6단계: `feat(m2): port appstore + playstore collectors`로 커밋 (두 파일은 서로 독립이므로 분리 커밋해도 됨).

---

## Re-review 2026-04-12

**Scope**: 직전 리뷰 피드백 반영분 빠른 확인 (전체 재검토 아님). uncommitted working tree.

**판정: PASS. 새 CRITICAL/HIGH 없음. 커밋 진행 OK.**

| 항목 | 결과 | 검증 위치 |
|------|------|-----------|
| **H1** wire shape delta 문서화 | ✅ 해결 | `src/types/collectors.ts:10-26` 파일 헤더에 3가지 delta JSDoc, `docs/growth-agent/porting-matrix.md:144,152`에 appstore/RateLimitError row delta 노트 병기 |
| **M1** AppStore write 해피패스 테스트 | ✅ 해결 | `tests/collectors/appstore.test.ts:218` (`updateLocalization sends PATCH with JSON:API envelope`), `:252` (`replyToReview posts customerReviewResponses envelope`) 2개 추가 |
| **M2** `parseRetryAfter` 공용 헬퍼 | ✅ 해결 | `src/utils/retry.ts:81-98` 신규 export, HTTP-date / 음수 delta / 과거 date 처리. `appstore.ts:4,133` + `playstore.ts:4,157` 양쪽 호출 경로 확인 |
| **M3** 헤더 머지 타입 좁히기 | ✅ 해결 | 양 컬렉터 모두 `RequestInitLike` 로컬 타입 도입 (`appstore.ts:32-36`, `playstore.ts:32-36`). `Headers` 인스턴스 전달 경로 컴파일 타임에 차단됨 |
| **M4** testHooks 분리 | ✅ 해결 | `AppStoreCollectorTestHooks`/`PlayStoreCollectorTestHooks` 2번째 생성자 인자 (`appstore.ts:28-30,83`, `playstore.ts:27-29,70`). 프로덕션 `Options` 인터페이스에 `baseUrl`/`tokenUrl` 없음 → SSRF 표면 제거 |
| **L4** 빈 업데이트 가드 | ✅ 해결 | `appstore.ts:194-203` 네 필드 모두 undefined면 throw |
| **INFO 1** JSON.parse 래핑 | ✅ 해결 | `playstore.ts:84`의 `AuthError("PlayStoreCollector: serviceAccountJson is not valid JSON")` + `tests/collectors/playstore.test.ts:100` 누설 검증 테스트 |

### 유일한 미해결 nit (LOW, blocking 아님)

- **L1 부분 미해결**: 신청서에서는 "신규 코드에 `parseInt` 직접 호출 없음"이라 했는데 `src/collectors/playstore.ts:186`에 Google Play 리뷰 타임스탬프 초(`rawSeconds` string → number) 파싱용 `parseInt(rawSeconds, 10)`이 남아있다. 이건 retry 경로가 아니라 `PlayReviewsResponse.comments[].userComment.lastModified.seconds` 변환 경로이고, 원본 JS 파리티 유지 목적이라 기능상 문제는 없다. 완전 정합을 원하면 `Number.parseInt` 한 줄 치환이면 끝 — M2 배치 2/3 진행하면서 같이 정리해도 되고, 지금 커밋에 넣어도 됨. **blocking 아님, LOW 그대로 유지**.

### 새로 발견된 HIGH: 없음

재리뷰 스코프 내 변경(retry helper, testHooks 분리, 헤더 타입 좁히기, write 테스트 2개, JSON.parse 래핑, 빈 업데이트 가드, porting-matrix 문서)을 전부 읽었고 Mode A/B 경계나 approval 경로에 영향 없음. M2 스코프 유지.

### Positive observations on the fix pass

- `parseRetryAfter` 구현이 권고한 형태 그대로: delta-seconds 먼저 시도 → 음수면 fallback → 그 다음 `Date.parse` 시도 → 과거 날짜는 `Math.max(0, ...)`로 clamp. 6 test case로 커버.
- `RequestInitLike` 타입을 **두 파일 로컬로** 정의한 판단이 좋다 — 공유 타입으로 올려버리면 컬렉터마다 다를 수 있는 body 형태(JSON string vs form string 등)를 강제하게 된다.
- `AppStoreCollectorTestHooks`의 JSDoc("production config loaders cannot introduce a user-controlled base URL into the SSRF surface")이 왜 분리했는지를 명확히 기록 — 미래의 리팩터링 방지용으로 정확히 필요한 메시지.
- `updateLocalization` 빈 가드가 length 검증보다 **먼저** 나오는 순서가 맞다 (빈 객체 → 길이 검증 → attributes 조립 순이면 false negative 가능).

### Action items (updated)

- [x] H1, M1, M2, M3, M4, L4, INFO 1 — 모두 해결
- [ ] **L1** — `src/collectors/playstore.ts:186`의 `parseInt` → `Number.parseInt` 치환 (blocking 아님, M2 배치 2/3 또는 이번 커밋에 병합)
- [ ] 체크리스트 업데이트 + `feat(m2): port appstore + playstore collectors` 커밋 진행

