# Code Review: M2 배치 3 — Eodin Blog/SEO/Analytics + Fridgify Recipes

**Date**: 2026-04-12
**Scope**:
- `src/collectors/eodin-blog.ts` (신규, 306 LOC)
- `src/collectors/fridgify-recipes.ts` (신규, 196 LOC)
- `src/types/collectors.ts` (+78 LOC: Blog/Fridgify 타입 추가)
- `tests/collectors/eodin-blog.test.ts` (신규, 15 tests)
- `tests/collectors/fridgify-recipes.test.ts` (신규, 15 tests)

**Milestone**: M2 (growth-agent collector port — 배치 3/?)
**Commit(s)**: uncommitted working tree (base: `49676dc feat(m1): port CLI + launchd template + wire daemon`)
**Prior batches**: `review-2026-04-12-m2-batch1-collectors.md`, `review-2026-04-12-m2-batch2-collectors.md`

## Summary

배치 1·2에서 확립한 패턴(`testHooks` 분리, SSRF allowlist, API key redaction, `ExternalApiError`/`RateLimitError`)이 대체로 잘 따라왔다. `EodinGrowthClient` 추상 base 클래스로 3-way 중복(JS 원본)을 묶은 것은 적절한 TS 정리이고 porting-matrix `TS port` 범위 내이다. 다만 (1) **Fridgify SSRF allowlist에 `localhost` 포함** — 배치 1·2에서 모두 강제한 단일-도메인 엄격 allowlist 패턴에서 이탈, (2) **`markdownToHtml`의 HTML 미이스케이프 + `javascript:` URL 허용** — 공격자 제어 competitor 텍스트가 M4 `SeoBlogSkill`을 거쳐 `<EODIN_API_HOST>`로 POST되는 경로가 열려 있어 stored XSS 가능, (3) **Fridgify 429 처리가 `RateLimitError`가 아닌 `ExternalApiError`로 귀결** — 배치 2 I4에서 남긴 정책 결정이 이제는 실행되어야 한다, 이 세 가지는 배치 3 특유로 짚어야 한다.

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 2 |
| MEDIUM | 4 |
| LOW | 3 |
| INFO | 2 |

**Overall Grade**: B+
**Milestone fit**: 적합. M2 배치 3 스코프(2 collector TS port + 타입 + 테스트) 정확히 맞다. M3 DB 스키마, M4 스킬 로직, M5 approval gate는 전부 배치 외. write-path 경계(H1 관련) 결정은 배치 1 판단을 그대로 이어갈 명분이 있다.

## Critical & High Findings

### H1. `markdownToHtml`는 HTML을 이스케이프하지 않는다 — M4 `SeoBlogSkill`에서 stored XSS 가능

- **Severity**: HIGH
- **Category**: Security (A03 Injection, A06 Insecure Design)
- **File**: `src/collectors/eodin-blog.ts:253-297`
- **Issue**: `inlineReplacements`와 `markdownToHtml`은 `<`/`>`/`&`/`"`를 이스케이프하지 않고, 링크 URL을 `javascript:` 등 스킴별로 거르지도 않는다. 현재 테스트 케이스(tests/collectors/eodin-blog.test.ts:240-267)는 정상 입력만 검증한다. 원본 JS 패리티라는 설명은 정당하지만, 이 함수의 실제 호출자가 **공격자 제어 텍스트를 잉여 필터 없이 흘릴 수 있는 경로**에 있다는 점이 포팅에서 새로 생긴 위험이다:

  ```
  ASOMobile.getCompetitorInfo(...).description   // attacker-controllable, porting-matrix 148줄 경고 있음
    → M4 SeoBlogSkill (Claude 프롬프트)
    → Claude 생성 markdown (prompt injection 통과분 포함 가능)
    → markdownToHtml(...)
    → EodinBlogPublisher.create({ content: <HTML string> })
    → POST https://<EODIN_API_HOST>/api/v1/growth/blogs   ← stored XSS
  ```

  `FridgifyRecipe.aiDescription`도 같은 경로 (`src/types/collectors.ts:184-200`에 경고 주석 있음).

  구체 페이로드 3개:
  1. `<script>alert(1)</script>` → `<p><script>alert(1)</script></p>` (원문 그대로 HTML에 박힘)
  2. `[click me](javascript:alert(1))` → `<a href="javascript:alert(1)">click me</a>`
  3. `[x](" onmouseover="alert(1) "y)` → `<a href=" onmouseover="alert(1) "y">x</a>` (속성 탈출)

- **Impact**:
  - Stored XSS on `eodin.app` 공개 블로그. 1인 프로젝트라 실사용 사용자 피해는 제한적이지만 접근 권한 탈취 위험은 실재.
  - Human-in-the-loop approval이 있지만 승인자는 Slack 블록킷 프리뷰(텍스트 요약)만 보고 버튼을 누르므로 숨은 `<script>` 탐지는 기대 못한다.
  - 원본 growth-agent에는 없던 정당화("원본 패리티")가 **공격 표면이 같은 경로에 새로 생긴다는 사실**을 덮는다.
- **Current code**:
  ```typescript
  function inlineReplacements(text: string): string {
    return text
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
  }
  ```
- **Recommended fix** (최소 변경으로 3개 벡터 막기):
  ```typescript
  const HTML_ESCAPE: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch] ?? ch);
  }

  // 허용 스킴 화이트리스트 — 상대 경로도 허용
  function safeHref(url: string): string {
    const trimmed = url.trim();
    if (/^(https?:|mailto:|\/|#)/i.test(trimmed)) {
      return escapeHtml(trimmed);
    }
    return "#"; // drop javascript:, data:, vbscript:, etc.
  }

  function inlineReplacements(text: string): string {
    // escape first, then apply markdown — 순서 중요
    const escaped = escapeHtml(text);
    return escaped
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(
        /\[(.+?)\]\((.+?)\)/g,
        (_, label: string, url: string) =>
          `<a href="${safeHref(url)}">${label}</a>`
      );
  }
  ```
  그리고 테스트에 3개 negative 케이스 추가:
  ```typescript
  it("escapes raw HTML in content", () => {
    expect(markdownToHtml("<script>alert(1)</script>"))
      .toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  });
  it("rewrites javascript: links to #", () => {
    const html = markdownToHtml("[x](javascript:alert(1))");
    expect(html).toContain('href="#"');
    expect(html).not.toContain("javascript:");
  });
  it("allows https/mailto/relative links", () => {
    const html = markdownToHtml(
      "[a](https://eodin.app) [b](mailto:x@y.com) [c](/about)"
    );
    expect(html).toContain('href="https://eodin.app"');
    expect(html).toContain('href="mailto:x@y.com"');
    expect(html).toContain('href="/about"');
  });
  ```
- **원본 패리티에 관한 판단**: `CLAUDE.md`의 "one-time fork, no upstream sync"는 pilot-ai에 대한 것이고, growth-agent → adaria-ai는 도메인 로직 포팅이다. **포팅 시점에 발견된 보안 버그는 고쳐서 반영하는 것**이 이 프로젝트의 기본 입장이다 (배치 1·2에서 camelCase/flatten 등 비보안 개선도 이미 반영됨). 이 건은 "원본이 그랬다"로 남겨두면 M4 시점에 별도 리뷰가 또 필요해지고, 그때는 이미 `SeoBlogSkill` 코드가 이 함수에 의존하고 있을 것. 지금 고치는 게 가장 싸다.

---

### H2. Fridgify SSRF allowlist에 `localhost` 상시 포함 — 배치 1·2 패턴에서 이탈

- **Severity**: HIGH
- **Category**: Security (A01 / A05 SSRF), Architecture consistency
- **File**: `src/collectors/fridgify-recipes.ts:35-38`
- **Issue**: 배치 1(appstore/playstore), 배치 2(asomobile/eodin-sdk), 그리고 같은 배치의 `eodin-blog.ts:35`는 전부 **단일 프로덕션 도메인만** allowlist에 넣는다. `fridgify-recipes.ts`만 `"localhost"`를 런타임 allowlist에 포함한다. 테스트는 `testHooks.baseUrl`로 `http://localhost:...`를 주입하는 경로가 이미 존재(배치 2 M4 해결)하므로 여기서 localhost를 허용할 이유가 없다.
  ```typescript
  const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
    "<FRIDGIFY_BASE_HOST>",
    "localhost",   // ← 제거 필요
  ]);
  ```
- **Impact**:
  - 프로덕션 빌드(글로벌 설치된 `adaria-ai`)에서 localhost가 유효한 목적지가 된다. `baseUrl`을 config로 노출하지 않는 현재 설계 덕에 직접 익스플로잇 경로는 없지만, 미래에 누군가 `apps.yaml` 또는 `config.yaml` schema에 `fridgify.baseUrl` 필드를 무심코 추가하면 즉시 SSRF가 된다.
  - 패턴 일관성 훼손 — "SSRF allowlist는 단일 프로덕션 도메인"이라는 불변식을 코드 리뷰에서 자동 탐지하기 어려워진다.
- **Current code**:
  ```typescript
  const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
    "<FRIDGIFY_BASE_HOST>",
    "localhost",
  ]);
  ```
- **Recommended fix**:
  ```typescript
  const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["<FRIDGIFY_BASE_HOST>"]);
  ```
  테스트가 localhost로 모킹할 필요가 있으면 `testHooks.baseUrl`로 `https://<FRIDGIFY_BASE_HOST>`을 유지하고 `globalThis.fetch` 모킹으로 끝낸다 (현재 `tests/collectors/fridgify-recipes.test.ts`가 이미 그 방식이라 실제 테스트 수정은 거의 없다). 기존 테스트 15개 전부 default baseUrl 사용하니 이 변경은 테스트 실패를 유발하지 않는다.

## Medium & Low Findings

### M1. `logger` namespace import 관례 위반 — 기존 파일들은 named import 사용

- **Severity**: MEDIUM
- **Category**: Code quality / consistency
- **File**: `src/collectors/fridgify-recipes.ts:2`
- **Issue**: 프로젝트 내 다른 파일은 전부 `import { info as logInfo, warn as logWarn, error as logError } from "../utils/logger.js";` 패턴. `src/messenger/slack.ts`, `src/cli/daemon.ts`, `src/agent/core.ts`, `src/agent/claude.ts` 모두 동일. `fridgify-recipes.ts`만 `import * as logger from "../utils/logger.js";`를 쓴다.
  - 질문이었던 "logger가 default export가 아니라 namespace import 사용"은 기술적으로 동작하지만, **네임스페이스 import는 트리셰이킹을 방해**하고 `logger.warn(...)` 호출 스타일이 나머지 코드베이스와 달라 grep 패턴이 갈라진다 (`logInfo\(` 한 번으로 안 잡힘).
  - `eodin-blog.ts`는 아예 로거를 쓰지 않고(`ExternalApiError`만 throw) — `listSlugs`의 silent catch는 아예 로그 없이 빈 배열만 반환한다 (L3 참조).
- **Impact**: 트리셰이킹 저하(미미), grep/검색 일관성 저하, 미래 리뷰에서 "왜 이 파일만 달라?" 질문 유발.
- **Current code**:
  ```typescript
  import * as logger from "../utils/logger.js";
  // ...
  logger.warn(`[fridgify-recipes] 429 on ${path}; ...`);
  logger.info(`[fridgify-recipes] cascade stopped at period=${period} ...`);
  logger.warn(`[fridgify-recipes] cascade exhausted ...`);
  ```
- **Recommended fix**:
  ```typescript
  import {
    info as logInfo,
    warn as logWarn,
  } from "../utils/logger.js";
  // ...
  logWarn(`[fridgify-recipes] 429 on ${path}; waiting ${String(this.retryDelayMs)}ms before one retry`);
  logInfo(`[fridgify-recipes] cascade stopped at period=${period} (${String(rows.length)} rows)`);
  logWarn(`[fridgify-recipes] cascade exhausted — no window had >=${String(minResults)} rows (last=${String(lastRows.length)})`);
  ```
  alias 필요한 이유는 `info`/`warn`/`error`가 전역 함수/예약어와 섀도잉될 수 있기 때문 — 기존 관례가 이미 그렇게 수렴했다.

### M2. Fridgify 429 최종 실패가 `RateLimitError`가 아닌 `ExternalApiError`

- **Severity**: MEDIUM
- **Category**: Architecture (error taxonomy), Batch 2 I4 후속
- **File**: `src/collectors/fridgify-recipes.ts:104-120`
- **Issue**: 배치 2 리뷰 I4("Eodin에 RateLimitError 분기 추가할지 정책 결정 대기")가 이 배치에서 처음으로 실제 분기가 있는 코드를 만났다. Fridgify는 **실제로 429를 감지하고 한 번 재시도한다** — 패리티 근거("분기 없음")가 이 collector에는 해당 없음. 재시도 후 여전히 429면 현재는 `ExternalApiError`로 감싸 throw하는데, 배치 1·2의 appstore/playstore/asomobile 전원이 429를 `RateLimitError`로 분기하는 패턴과 불일치.
  ```typescript
  if (response.status === 429) {
    logger.warn(`[fridgify-recipes] 429 on ${path}; ...`);
    await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
    response = await this.fetchOnce(target);
  }
  if (!response.ok) {
    // 여기 들어올 때 response.status가 여전히 429일 수 있는데
    // 그냥 ExternalApiError로 묶여버림
    throw new ExternalApiError(...);
  }
  ```
- **Impact**:
  - M4 스킬에서 rate-limit vs 일반 실패를 `instanceof RateLimitError`로 분기하려 할 때 Fridgify만 빠진다.
  - `agent_metrics`에 rate-limit 카운터를 분리 집계할 때 (M5+) 누락.
  - 의도는 "재시도 이미 했으니 위에서는 그냥 실패로 처리해"였을 수 있으나, 그렇다면 **내부 재시도 사실을 에러 타입에 반영**해야 소비자가 안다.
- **Current code**: 위 발췌 참조
- **Recommended fix**:
  ```typescript
  import { ExternalApiError, RateLimitError } from "../utils/errors.js";
  // ...
  if (!response.ok) {
    const body = await response.text();
    if (response.status === 429) {
      throw new RateLimitError(
        `Fridgify API still rate limited after 1 retry: ${body.slice(0, 512)}`,
        { retryAfterSeconds: Math.ceil(this.retryDelayMs / 1000) }
      );
    }
    throw new ExternalApiError(
      `Fridgify API ${String(response.status)}: ${body.slice(0, 512)}`,
      { statusCode: response.status }
    );
  }
  ```
  이상적으로는 `Retry-After` 헤더도 읽어서 `retryAfterSeconds`를 그 값으로 세팅 (appstore/playstore/asomobile은 `parseRetryAfter` 유틸 씀 — `src/utils/retry.ts`). 이건 M3 범위로 미뤄도 되나 한 줄 차이다.

### M3. `EodinGrowthClient.request`의 `body !== undefined` 분기가 `null` body를 허용

- **Severity**: MEDIUM
- **Category**: Code quality / type safety
- **File**: `src/collectors/eodin-blog.ts:73`
- **Issue**: `if (body !== undefined && method !== "GET")`는 `body = null`이면 `null`을 `JSON.stringify(null)` = `"null"`로 POST한다. 원본 JS 패리티이지만, TS에서 `body?: unknown`을 받으니 이는 **오용 가능**하다. `publish(slug)`는 `{ status: "PUBLISHED" }`만 보내니 실제 호출 경로에서는 발생 안 하지만, 미래에 skill 레벨에서 `update(slug, null)` 같은 호출을 방어할 장치가 없다.
- **Impact**: 현재 호출 경로에서는 무해. 미래 버그의 시드.
- **Current code**:
  ```typescript
  if (body !== undefined && method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  ```
- **Recommended fix**:
  ```typescript
  if (body !== undefined && body !== null && method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  ```
  및 `update` 내부에서 빈 업데이트 가드(배치 2 M5와 동일 패턴):
  ```typescript
  async update(slug: string, updates: BlogPostUpdate): Promise<unknown> {
    if (Object.keys(updates).length === 0) {
      throw new Error("EodinBlogPublisher.update: updates object is empty");
    }
    return this.request<unknown>(
      "PUT",
      `/blogs/${encodeURIComponent(slug)}`,
      updates
    );
  }
  ```

### M4. `EodinBlogPublisher.list`가 미지정 시에도 `page=1&limit=100`을 강제 — 서버 default와 충돌 가능

- **Severity**: MEDIUM
- **Category**: API contract parity
- **File**: `src/collectors/eodin-blog.ts:149-159`
- **Issue**: `params.set("page", String(options.page ?? 1));` 는 호출자가 아예 page/limit을 전달 안 해도 쿼리스트링에 박는다. 이는 원본 JS와 실제로 맞는지 확인이 안 된 상태. 서버 default가 달라지면(예: `limit=20`) 클라이언트가 그 변경을 자동으로 따라가지 못한다.
- **Impact**: 서버가 미래에 pagination default를 바꾸거나, 특정 category에 다른 default를 적용하는 튜닝을 하면 adaria-ai가 그 혜택을 못 받는다. `listSlugs`가 늘 100개만 가져오는데, 이는 실제 blog post가 100개를 넘으면 일부 슬러그를 놓친다는 뜻이다 — **duplicate-slug 방지 용도라는 주석과 정면충돌** (166-173).
- **Current code**:
  ```typescript
  async list(options: BlogListOptions = {}): Promise<BlogListResponse> {
    const params = new URLSearchParams();
    if (options.status !== undefined) params.set("status", options.status);
    if (options.category !== undefined) params.set("category", options.category);
    params.set("page", String(options.page ?? 1));
    params.set("limit", String(options.limit ?? 100));
    // ...
  }

  async listSlugs(): Promise<string[]> {
    try {
      const result = await this.list({ limit: 100 });
      return result.data.map((post) => post.slug);
    } catch { return []; }
  }
  ```
- **Recommended fix**:
  1. `list`는 호출자가 준 값만 쿼리에 박고 default는 서버에 맡긴다:
  ```typescript
  async list(options: BlogListOptions = {}): Promise<BlogListResponse> {
    const params = new URLSearchParams();
    if (options.status !== undefined) params.set("status", options.status);
    if (options.category !== undefined) params.set("category", options.category);
    if (options.page !== undefined) params.set("page", String(options.page));
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.toString();
    return this.request<BlogListResponse>(
      "GET",
      query ? `/blogs?${query}` : "/blogs"
    );
  }
  ```
  2. `listSlugs`는 실제로 100개 초과 시 페이지네이션을 돌거나, **최소한 한도를 넘었다는 경고를 로그에 남겨야** duplicate-slug 가정이 언제 깨지는지 안다:
  ```typescript
  async listSlugs(): Promise<string[]> {
    try {
      const result = await this.list({ limit: 100 });
      const total = result.pagination?.total;
      if (typeof total === "number" && total > 100) {
        // logger 도입 (M1 참조)
        // TODO: paginate instead of silent truncation
      }
      return result.data.map((post) => post.slug);
    } catch {
      return [];
    }
  }
  ```
  원본 JS와 정확히 일치가 목적이면 최소 (1)만 적용.

### L1. `listSlugs`의 silent catch — 에러 원인 소실

- **Severity**: LOW
- **Category**: Observability
- **File**: `src/collectors/eodin-blog.ts:166-173`
- **Issue**: 의도 자체는 "duplicate-slug 체크를 위한 best-effort, API 불가 시 충돌 없음으로 처리"로 배치 1 M5 패턴과 유사하게 정당하다. 다만 401/403/500/네트워크 단절을 전부 똑같이 `[]`로 삼키면 **진짜 인증 깨짐**도 조용해진다. playstore.ts:80의 silent catch와는 성격이 다르다 (그쪽은 의도적 민감정보 마스킹).
- **Impact**: 토큰 만료를 skill 레벨에서만 발견 — doctor 명령(M9)에서 이 경로는 안 잡힘.
- **Recommended fix**: 최소한 warn 로그만:
  ```typescript
  import { warn as logWarn } from "../utils/logger.js";
  // ...
  async listSlugs(): Promise<string[]> {
    try {
      const result = await this.list({ limit: 100 });
      return result.data.map((post) => post.slug);
    } catch (err) {
      logWarn("[eodin-blog] listSlugs failed — assuming no slug conflict", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
  ```

### L2. `FridgifyRecipesCollector.getRecipe`의 `typeof id !== "string"` dead branch

- **Severity**: LOW
- **Category**: Dead code
- **File**: `src/collectors/fridgify-recipes.ts:186-195`
- **Issue**: 시그니처가 `id: string`이라 TS strict 모드에서 `typeof id !== "string"`은 도달 불가. runtime 방어는 정당하지만 그렇다면 `id: unknown`으로 받거나 guard 주석 달아 의도를 분명히 해야 한다.
- **Recommended fix**: 간단히 빈 문자열 체크로 정리:
  ```typescript
  async getRecipe(id: string): Promise<FridgifyRecipe> {
    if (id.length === 0) {
      throw new Error(
        "FridgifyRecipesCollector.getRecipe requires a non-empty string id"
      );
    }
    return this.request<FridgifyRecipe>(
      `/recipes/${encodeURIComponent(id)}`
    );
  }
  ```

### L3. `getPopularWithCascade`의 `lastPeriod = "year"` 초기값 dead

- **Severity**: LOW
- **Category**: Code clarity
- **File**: `src/collectors/fridgify-recipes.ts:161`
- **Issue**: `CASCADE_PERIODS`가 비어있을 리 없으므로 `lastPeriod` 초기값은 항상 loop 안에서 덮어씌워진다. 의도를 드러내려면 주석 한 줄 또는 non-null assertion으로 loop 후 할당을 명시.
- **Recommended fix**: 그대로 둬도 되지만, for-of 뒤 `lastPeriod`를 쓰는 마지막 return 줄에서 `CASCADE_PERIODS[CASCADE_PERIODS.length - 1]`로 바꾸면 dead assignment 제거:
  ```typescript
  let lastRows: FridgifyRecipe[] = [];
  for (const period of CASCADE_PERIODS) {
    const rows = await this.getPopular({ period, metric, limit });
    lastRows = rows;
    if (rows.length >= minResults) {
      logInfo(`[fridgify-recipes] cascade stopped at period=${period} ...`);
      return { period, rows, satisfied: true };
    }
  }
  const finalPeriod = CASCADE_PERIODS[CASCADE_PERIODS.length - 1] ?? "year";
  logWarn(`[fridgify-recipes] cascade exhausted ...`);
  return { period: finalPeriod, rows: lastRows, satisfied: false };
  ```

### I1. `EodinGrowthClient` 추상 base 클래스로 3-way 중복 통합 — 배치 3 스코프에서 정당

- **Severity**: INFO
- **Category**: Architecture
- **Observation**: 질문에 대한 답: **OK하다**. 원본 JS가 3개 클래스 각각에 동일한 `#request`를 복붙했던 것을 abstract base로 묶은 것은 `TS port`가 허용하는 범위의 정리다. 근거:
  1. `porting-matrix.md:147`의 해당 row에 "camelCase만" 같은 제약이 없음 — 구조 정리 허용.
  2. 3개 클래스가 **동일한 auth 헤더, 동일한 baseUrl, 동일한 error redaction**을 공유한다는 사실이 원본 JS부터 참이었고, 세 곳에 같은 버그가 잠재할 위험을 이 배치에서 한 곳으로 수렴시켰다 (bearer redaction만 수정하면 세 클래스 모두 수혜).
  3. base 클래스는 `abstract`로 명시돼 외부에서 `new`할 수 없고, `protected`로 `token`/`baseUrl`/`request`를 노출 — 클래스 hierarchy 남용 아님.
- **주의**: 만약 미래에 SEO 엔드포인트가 token ROT, Blog 엔드포인트가 JWT로 갈라지면 이 추상화가 비용이 된다. 지금은 OK.

### H1 답변: write-path 노출 경계는 OK한가?

- **Severity**: INFO
- **Category**: Architecture (approval gate layering)
- **Observation**: 질문에 대한 답: **OK하다**. 현재 `EodinBlogPublisher.create/update/publish/delete`는 approval 로직 없이 그대로 export한다. 이는 배치 1의 판단("collector는 low-level wrapper, approval은 별도 레이어")과 일관된다. 근거:
  1. `CLAUDE.md` "Write paths go through ApprovalManager" 섹션은 **스킬 레이어**에 approval을 요구하지 collector에 요구하지 않는다 — approval은 `src/agent/safety.ts:blog_publish` 게이트가 M5에 `SeoBlogSkill`을 감쌀 때 들어간다.
  2. MCP tools(`src/tools/`)는 이 collector를 직접 참조할 수 없어야 하며, 이는 M5.5 리뷰에서 "skill을 MCP tool로 노출 금지"와 같은 위상으로 강제될 것. 현재 파일에는 MCP 관련 코드 없음 — OK.
  3. JSDoc 주석(`eodin-blog.ts:17-20`)이 approval 경계를 명시적으로 안내 — future 리뷰어가 헷갈릴 여지 적음. 한 줄 보강 제안: `@see src/agent/safety.ts` 링크 추가.
- **단 조건**: M5 리뷰에서 반드시 확인할 것 — `SeoBlogSkill`이 `EodinBlogPublisher.publish`를 호출하는 모든 경로가 `safety.ts`의 `blog_publish` 게이트를 통과하는지. 이 collector는 순응형 도구이고 직접 방어하지 않는다.

## Data Flow Issues

없음 — collector 2개 모두 순수 wrapper이고 DB/messenger/core로 직접 데이터를 넘기지 않는다. 배치 외.

## Two-mode routing integrity

해당 없음. 이 배치는 `core.ts`/`skills/index.ts`/`tools/`를 건드리지 않는다.

## Positive Observations

1. **`EodinGrowthClient` 추상 base가 꽤 깔끔**. 원본 JS의 3중 중복(`#request` 복붙)을 TS 클래스 상속으로 자연스럽게 수렴. bearer redaction 로직이 한 곳에 있어서 H1 수정도 한 번에 끝난다.
2. **Bearer redaction + 본문 잘라내기**(`eodin-blog.ts:85-87`)가 배치 1·2의 API key redaction 패턴과 정확히 맞물린다 — 에러 메시지를 로그/audit에 뿌려도 토큰 유출 없음. 테스트(`eodin-blog.test.ts:164-181`)가 `[REDACTED]` 마커를 직접 검증해서 regression 방어도 단단하다.
3. **`encodeURIComponent` path traversal 테스트**(`eodin-blog.test.ts:101-115`)가 `"weird slug/../evil"` 페이로드로 구체적 벡터를 검증 — 배치 1·2에는 없었던 개선. 이 테스트 패턴을 다른 collector에도 역수입할 가치 있다.
4. **Fridgify cascade의 "satisfied" 플래그**가 "top recipes this year를 single stray row로 만들지 말라"는 운영 요구사항(주석 151-153)을 타입으로 강제 — 주석 + 타입 + 테스트 모두 한 방향. 매우 좋음.
5. **`testHooks.baseUrl` 분리 패턴**이 두 collector 모두 배치 2 M4 해결안을 그대로 따름 — 배치 간 일관성.
6. **`FridgifyRecipe` 타입의 prompt injection 경고 주석**(`collectors.ts:184-200`)이 M4 스킬 포터에게 구체적으로 어느 필드를 `prompt-guard.ts`로 흘리라고 알려줌 — 배치 2에서 확립한 attacker-controllable 필드 문서화 패턴을 이어감.

## Action Items

- [ ] **H1** — `markdownToHtml`/`inlineReplacements`에 HTML escape + javascript: URL drop 적용 + negative 테스트 3개 추가. 지금 고치지 않으면 M4 `SeoBlogSkill` 리뷰에서 다시 튀어나올 것 (`src/collectors/eodin-blog.ts:253-297`).
- [ ] **H2** — `fridgify-recipes.ts` ALLOWED_HOSTS에서 `"localhost"` 제거. 테스트는 기존 testHooks 경로 그대로 돌아감 (`src/collectors/fridgify-recipes.ts:35-38`).
- [ ] **M1** — `fridgify-recipes.ts`의 `import * as logger` 제거하고 `info as logInfo, warn as logWarn` named import로 교체. 코드베이스 관례 통일 (`src/collectors/fridgify-recipes.ts:2, 105, 169, 176`).
- [ ] **M2** — Fridgify 429 최종 실패를 `RateLimitError`로 분기. 선택적으로 `Retry-After` 헤더 반영. 배치 2 I4 정책 결정 실행 (`src/collectors/fridgify-recipes.ts:104-120`).
- [ ] **M3** — `EodinGrowthClient.request`에 `body !== null` 가드 추가 + `EodinBlogPublisher.update`에 빈 updates 가드 (`src/collectors/eodin-blog.ts:73, 122`).
- [ ] **M4** — `EodinBlogPublisher.list`의 강제 page/limit 파라미터를 optional 전파로 변경 + `listSlugs`의 100+ 한계 로그 보강 (`src/collectors/eodin-blog.ts:149-173`).
- [ ] **L1** — `listSlugs` catch에 warn 로그 추가 (`src/collectors/eodin-blog.ts:166-173`).
- [ ] **L2** — `getRecipe`의 `typeof` dead check 정리 (`src/collectors/fridgify-recipes.ts:186-195`).
- [ ] **L3** — `getPopularWithCascade`의 `lastPeriod` 초기값 dead assignment 제거 (`src/collectors/fridgify-recipes.ts:161`).
- [ ] **I1/H1(응답)** — `EodinBlogPublisher` 클래스 JSDoc에 `@see src/agent/safety.ts` 링크 한 줄 추가 (`src/collectors/eodin-blog.ts:99-101` 근처).

배치 3 블록 이슈: **H1, H2 둘만 해결되면 커밋 가능**. M1–M4는 이번 배치 안에서 처리 권장하되 M3 DB 레이어로 미루어도 치명적이지 않다. L1–L3는 취향.

## Re-review 2026-04-12

All HIGH + MEDIUM + cheap LOW addressed in the same working tree. Verified:

- **H1** — `src/collectors/eodin-blog.ts` gained `escapeHtml` + `safeHref` + a `SAFE_URL_SCHEME` allowlist; `inlineReplacements` now escapes before inserting `<strong>`/`<em>`/`<a>`. New `markdownToHtml (security)` test block covers `<script>` escape, `javascript:` / `data:` / `vbscript:` drop, https/mailto/relative/fragment allow, and attribute-escape injection.
- **H2** — `fridgify-recipes.ts` `ALLOWED_HOSTS` now contains only `<FRIDGIFY_BASE_HOST>`. Existing SSRF test still passes because the evil-URL check runs before fetch.
- **M1** — `fridgify-recipes.ts` switched to `import { info as logInfo, warn as logWarn } from "../utils/logger.js"` to match the codebase convention (`core.ts`, `slack.ts`, etc.).
- **M2** — Fridgify `request()` now throws `RateLimitError` with `retryAfterSeconds` derived from `retryDelayMs` on a persistent 429. Test renamed to `throws RateLimitError after a second 429` and asserts the instance type.
- **M3** — `EodinGrowthClient.request` added `body !== null` guard; `EodinBlogPublisher.update` rejects empty updates objects with a dedicated test.
- **M4** — `list()` only emits query params the caller provided; `listSlugs()` logs a warning when `pagination.total > 100` so silent truncation is observable. New test `list without options sends no query string` enforces the change.
- **L1** — `listSlugs` catch now calls `logWarn("[eodin-blog] listSlugs failed …", { error })` before returning `[]`.
- **L2** — `getRecipe` dropped the unreachable `typeof` branch, keeps only the empty-string guard.
- **L3** — `getPopularWithCascade` dropped the dead `lastPeriod = "year"` seed and computes `finalPeriod` from `CASCADE_PERIODS[length-1]` at exit.
- JSDoc on `EodinBlogPublisher` now points readers at `src/agent/safety.ts`.

Build clean, lint clean, 313 → 321 tests passing. **CRITICAL/HIGH regression: none.** Proceed to commit.
