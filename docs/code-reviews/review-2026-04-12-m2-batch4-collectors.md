# Code Review: M2 Batch 4 — YouTube Data API + Arden TTS collector port

**Date**: 2026-04-12
**Scope**:
- `src/collectors/youtube.ts` (new, 138 LOC)
- `src/collectors/arden-tts.ts` (new, 109 LOC)
- `src/types/collectors.ts` (extended with `YouTubeVideoStats`)
- `tests/collectors/youtube.test.ts` (new, 7 tests)
- `tests/collectors/arden-tts.test.ts` (new, 6 tests)
**Milestone**: M2 (collector port, final sub-batch)
**Commit(s)**: uncommitted working tree

## Summary

배치 1–3에서 확립된 testHooks + SSRF allowlist + API key redaction + camelCase wire shape 패턴을 YouTube에 일관되게 재적용했다. Arden TTS는 "internal self-hosted service라 production host가 없다"는 근거로 allowlist를 의도적으로 생략했는데, 이 판단 자체는 위협 모델 측면에서 수용 가능하나 "endpoint가 실제로 config.yaml에서만 온다"는 계약이 아직 코드상 어디에서도 강제되지 않고, URL scheme 검증도 전무해서 향후 M5 wiring 시점에 허술하게 뚫릴 틈이 남았다. YouTube는 API 키를 querystring에 박는 유일한 콜렉터라 redaction 경계가 에러 본문으로 한정돼 있는 점을 추가로 지적한다.

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 1 |
| MEDIUM | 3 |
| LOW | 2 |
| INFO | 2 |

**Overall Grade**: B+
**Milestone fit**: 정확. M2의 마지막 두 collector 포트. 스킬/tools/core.ts 오염 없음. checklist.md L126의 `arden-tts.ts` 포트 라인과 M2 collector 블록 최종 소진을 정확히 채움.

## 핵심 질문 답: Arden TTS의 SSRF allowlist 생략은 OK한가?

**짧은 답: 조건부 OK. 두 개 조건이 걸린다.**

1. **위협 모델 자체는 타당**. Arden TTS는 사용자(=single operator)가 본인 인프라에 배포한 내부 서비스이고, endpoint는 `config.yaml` (사용자가 `adaria-ai init`으로 작성)에서 올 계약이다. config.yaml을 조작할 수 있는 공격자는 이미 호스트 전체를 침해한 상태라 SSRF는 중복 방어일 뿐이다. 다른 collector들처럼 "실무자가 아는 하나의 프로덕션 호스트"가 존재하지 않으므로, 고정 allowlist를 만들면 사용자마다 다른 엔드포인트를 하드코딩해야 해 설치 경험이 무너진다. 이 판단은 배치 1–3 패턴의 **의도적이고 명시된 이탈**이고, 주석(`arden-tts.ts:6-14`)에 이유가 기록되어 있다. 좋다.

2. **그러나 계약이 두 곳에서 비어 있다.**
   - (a) **endpoint URL scheme/host 검증이 0이다.** `new ArdenTtsClient({ endpoint: "javascript:..." })`도 throw되지 않고, `fetch(\`${endpoint}/synthesize\`)` 경로로 들어가 undici 측에서 이상한 예외를 낸다. 방어 심층 관점에서 "옳은 에러를 일찍 내는" 작업이 없다.
   - (b) **"endpoint가 config.yaml에서만 온다"는 계약이 코드에서 어디에도 강제되지 않는다.** `src/config/` 에 Arden TTS 스키마가 아직 없고(M3 또는 M5에서 추가 예정), M5 `ShortFormSkill` wiring 시점에 `ctx.collectors.ardenTts`를 조립하는 코드가 실수로 `ctx.message.text`에서 값을 뽑거나 Claude가 tool 경유로 넘긴 값을 넣을 수 있다. 현재 시점에서는 call site가 없으니 허구의 위험이지만, **이 배치는 "나중에 오남용되기 쉬운 생성자"를 내놓는 것**이다.

→ **(a)는 HIGH로 잡는다** (finding H1). 한 줄 추가로 즉시 해결됨. **(b)는 M5 action item으로 연기**한다 (I1). 현 배치에서 강제할 수 있는 것이 없으니 문서화만.

## Critical & High Findings

### H1. `ArdenTtsClient` endpoint가 URL scheme 검증 없이 `fetch`로 흘러간다

- **Severity**: HIGH
- **Category**: Security (SSRF / protocol smuggling) — Arden-specific allowlist 생략 판단을 "수용 가능"으로 만들기 위한 방어 심층
- **File**: `src/collectors/arden-tts.ts:43-48, 60`
- **Issue**: 생성자는 `options.endpoint`가 비어 있지만 않으면 그대로 `fetch` base에 꽂는다. scheme/host 검증이 전혀 없어서:
  - `endpoint: "javascript:void(0)"` → `fetch("javascript:void(0)/synthesize")` — undici가 `TypeError: Only HTTP(S) protocols are supported`로 뒤늦게 throw. 사용자에게 깨끗한 에러 안 가고, audit log에는 `arden-tts` 관련 실패로 묻힘.
  - `endpoint: "file:///etc/passwd"` → undici가 file: 스킴 거부하지만, 이는 undici의 우연에 의존하는 방어다 (undici의 `fetch` API 제약을 신뢰하는 것인데, 런타임 교체나 폴리필 시 터진다).
  - `endpoint: " https://arden.example.com "` (trailing whitespace copy-paste) → 에러 메시지가 undici-native가 되어 debug 경험이 나빠짐.
  - 가장 현실적인 시나리오는 `adaria-ai init`이 http/https prefix를 빠뜨린 사용자 입력을 그대로 저장해 버리는 경우다. 지금 구조에서는 발견이 런타임, 메시지는 "cannot read properties…" 류가 된다.
- **Impact**:
  - config.yaml이 침해되지 않은 정상 운영에서도 설정 실수가 "이상한 에러"로 표현되어 `adaria-ai doctor` 신호가 흐려진다.
  - Arden TTS에 allowlist가 없다는 이탈 결정을 리뷰어/독자가 수용하려면, 최소한 "scheme은 http(s)만 허용한다"는 계약이 코드에 **명시적으로** 있어야 한다. 현재는 그 계약이 암묵적이고, 주석에 적힌 신뢰 모델과 코드가 불일치한다 (주석은 "endpoint comes from config.yaml"이라 주장하지만 코드는 어디서 왔든 받는다).
  - 앞으로 M5에서 `ShortFormSkill`이 `ctx.collectors.ardenTts = new ArdenTtsClient({ endpoint: config.arden_tts.endpoint })`라고 wire할 때, 타입 시스템은 이 endpoint의 신뢰 경로를 검증해 주지 않는다. 방어 심층 레이어가 하나 있으면 regression 내성이 생긴다.
- **Current code** (`src/collectors/arden-tts.ts:43-49`):
  ```typescript
  constructor(options: ArdenTtsClientOptions) {
    if (!options.endpoint) {
      throw new Error("ArdenTtsClient requires endpoint");
    }
    // Normalize away a trailing slash so path joins are predictable.
    this.endpoint = options.endpoint.replace(/\/+$/, "");
  }
  ```
- **Recommended fix**:
  ```typescript
  constructor(options: ArdenTtsClientOptions) {
    if (!options.endpoint) {
      throw new Error("ArdenTtsClient requires endpoint");
    }
    // Arden TTS is user-hosted so we cannot hardcode a host allowlist
    // (see file header). Enforce at least the scheme + parse-ability
    // contract here so mis-typed config.yaml values fail loudly at
    // construction, not inside undici with an opaque TypeError.
    let parsed: URL;
    try {
      parsed = new URL(options.endpoint.trim());
    } catch {
      throw new Error(
        `ArdenTtsClient endpoint must be a valid URL, got: ${options.endpoint}`
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `ArdenTtsClient endpoint must use http(s), got: ${parsed.protocol}`
      );
    }
    // Normalize trailing slash so path joins are predictable.
    this.endpoint = parsed.toString().replace(/\/+$/, "");
  }
  ```
  그리고 테스트 두 개 추가:
  ```typescript
  it("rejects non-http(s) endpoint schemes", () => {
    expect(
      () => new ArdenTtsClient({ endpoint: "javascript:alert(1)" })
    ).toThrow(/http\(s\)/);
    expect(
      () => new ArdenTtsClient({ endpoint: "file:///etc/passwd" })
    ).toThrow(/http\(s\)/);
  });

  it("rejects unparseable endpoint", () => {
    expect(
      () => new ArdenTtsClient({ endpoint: "not a url at all" })
    ).toThrow(/valid URL/);
  });
  ```
  이 한 줄 수정으로 "allowlist 생략"이 **의도된, 문서화된, 최소 계약이 있는** 결정으로 승격된다.

## Medium & Low Findings

### M1. `YouTubeCollector`는 API 키를 URL querystring에 박는다 — redaction 경계가 `fetchJson` error path로 한정됨

- **Severity**: MEDIUM
- **Category**: Security (credential leakage via transport path)
- **File**: `src/collectors/youtube.ts:87, 110` + `45-66`
- **Issue**: Google YouTube Data API v3의 인증 방식이 `key=...` querystring이라는 건 불가피한 상류 제약이다. 그런데 이 배치의 핵심 개선점인 "API key redaction"은 `fetchJson`의 `!response.ok` 분기에서만 작동한다 (`response.text().replaceAll(this.apiKey, "[REDACTED]")`). 문제는:
  - **fetch 자체가 throw하는 경로** (`TypeError: fetch failed`, DNS error, TLS handshake 실패 등)는 `response`가 없어서 redaction 코드를 지나지 않는다. Node undici는 error `cause`에 URL을 포함하지 않는 게 기본 동작이지만, 상위 `core.ts` / `logger.ts`가 `err` 전체를 JSON.stringify 하거나 `error.stack`을 통으로 audit에 남기면 `url.toString()`이 stack trace에 묻어 나올 가능성이 있다 (undici 버전에 따라).
  - **`ExternalApiError`의 `cause`**는 현재 배치 코드에서는 안 설정되지만, 향후 catch→rethrow 래퍼가 추가될 때 그 rethrow가 `{ cause: err }`를 전달하면 원본 `TypeError` (그리고 그 message에 포함될 수 있는 URL)가 재등장할 수 있다.
  - **URL이 brower/proxy/메트릭 수집 경로에 노출**되는 일반 리스크는 사용자가 outbound HTTPS로 직접 Google을 치므로 거의 없지만, 이것은 전송-레이어가 아닌 **로깅-레이어** 방어를 요구한다.
  - 가장 현실적 회귀 경로는 "`doctor.ts`가 YouTube 점검 중 생성한 URL을 에러 메시지에 출력"하거나 "`core.ts`의 top-level error handler가 `err.stack`을 audit.jsonl에 통째로 덤프"하는 경우다. 배치 3 리뷰에서 언급한 bearer redaction 패턴의 대칭이 필요하다.
- **Impact**: 평상시에는 문제 없다 (`ok=true` 경로는 URL 로깅 자체가 없음). 하지만 `fetch` 자체 실패 시점에 audit/logger가 `err`를 직렬화하면 API key가 `[REDACTED]`를 거치지 않고 기록될 수 있다. Quota 초과가 아닌 네트워크 장애 1회로 키가 로그에 남는 것은 실무적으로 드물지 않다.
- **Recommended fix**: `fetchJson` 전체를 try/catch로 감싸고, catch 분기에서도 동일 redaction을 적용한 뒤 rethrow한다. 테스트 하나 추가.
  ```typescript
  private async fetchJson<T>(url: URL): Promise<T> {
    if (!ALLOWED_HOSTS.has(url.hostname)) {
      throw new Error(
        `Untrusted YouTube host: ${url.hostname}. Allowed: ${[...ALLOWED_HOSTS].join(", ")}`
      );
    }

    const redact = (s: string): string =>
      s.replaceAll(this.apiKey, "[REDACTED]");

    let response: Response;
    try {
      response = await fetch(url.toString());
    } catch (err) {
      // Redact the key from any message undici or a polyfill may have
      // inlined (stack traces and error.cause can carry the URL).
      const raw = err instanceof Error ? err.message : String(err);
      throw new ExternalApiError(
        `YouTube API fetch failed: ${redact(raw).slice(0, 512)}`
      );
    }

    if (!response.ok) {
      const rawBody = await response.text();
      throw new ExternalApiError(
        `YouTube API ${String(response.status)}: ${redact(rawBody).slice(0, 512)}`,
        { statusCode: response.status }
      );
    }
    return (await response.json()) as T;
  }
  ```
  테스트:
  ```typescript
  it("redacts API key from fetch-level errors", async () => {
    mockFetch.mockRejectedValueOnce(
      new TypeError(
        "fetch failed: https://www.googleapis.com/youtube/v3/search?key=yt-key"
      )
    );
    const caught = await collector
      .getRecentShorts("UCx")
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ExternalApiError);
    expect((caught as ExternalApiError).message).not.toContain("yt-key");
    expect((caught as ExternalApiError).message).toContain("[REDACTED]");
  });
  ```

### M2. `synthesizeBatch`의 per-script 실패가 `ExternalApiError` 타입 정보를 **로그에서 지워** — rate limit 대응 기회 상실

- **Severity**: MEDIUM
- **Category**: Error handling / observability
- **File**: `src/collectors/arden-tts.ts:88-108`
- **Issue**: 현재 배치 실패 처리는 `err instanceof Error ? err.message : String(err)` 만 로그에 남긴다. `ExternalApiError.statusCode` (429/503 여부)가 로그에도 caller에게도 전달되지 않는다. 이 때문에:
  - 3개 스크립트 중 1개가 429를 맞아 실패하고 나머지 2개가 429 직후 즉시 실행되어 연쇄 실패를 유발할 수 있다. 배치 전체가 `for-of await`로 직렬 실행이라 rate limit 인식은 특히 중요하다.
  - 상위 `ShortFormSkill`(M5)은 "3개 중 2개만 성공"을 `results.length < scripts.length`로만 판단할 수 있어서, **왜** 실패했는지 몰라 재시도 전략을 고를 수 없다.
  - growth-agent 원본(`arden-tts.js:51-54`)의 `console.error` 제한을 그대로 옮긴 결과인데, 원본의 한계를 포팅 과정에서 수정할 기회였다.
- **Impact**: 운영 관점 — 내부 TTS 서비스가 일시적 500을 뱉을 때 조용히 빈 결과가 반환되고, 그 주의 short-form 브리핑이 "3개 중 1개 누락"으로 끝난다. 사용자는 누락 사실을 Slack에서 보고 "왜?"를 물을 수밖에 없다. 실패 사유가 status code로 로그에 있다면 `doctor.ts`가 즉시 진단 가능.
- **Recommended fix**: 로그 엔트리에 `statusCode`를 structured field로 덧붙이고, 반환 타입에 optional failure list를 더해 caller가 재시도 여부를 결정할 수 있게 한다.
  ```typescript
  export interface SynthesizeBatchResult {
    successes: SynthesizeResult[];
    failures: { title: string; error: string; statusCode?: number }[];
  }

  async synthesizeBatch(
    scripts: SynthesizeScript[],
    options: SynthesizeOptions = {}
  ): Promise<SynthesizeBatchResult> {
    const successes: SynthesizeResult[] = [];
    const failures: SynthesizeBatchResult["failures"] = [];

    for (const { title, script } of scripts) {
      try {
        const audio = await this.synthesize(script, options);
        successes.push({ title, audio });
      } catch (err) {
        const statusCode =
          err instanceof ExternalApiError ? err.statusCode : undefined;
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ title, error: message, statusCode });
        logError(`[arden-tts] Failed to synthesize "${title}"`, {
          statusCode,
          error: message,
        });
      }
    }

    return { successes, failures };
  }
  ```
  기존 반환 타입을 쓰는 곳이 아직 없으니(M5 wiring 전) 파괴적 변경이지만 지금이 고치기 가장 저렴한 시점이다. 이 제안이 부담스러우면 최소한 `logError`에 `{ statusCode }`를 구조화 필드로 붙이는 것만이라도 적용.

### M3. `YouTubeCollector.getRecentShorts`는 `videoDuration=short`에 의존하지만 Shorts 판별이 정확하지 않다 — 60초 필터가 없음

- **Severity**: MEDIUM
- **Category**: Data correctness / domain invariant
- **File**: `src/collectors/youtube.ts:73-99`
- **Issue**: 주석(74-78)에 "skills should cross-check the content-details duration if strict 60-second semantics are needed"고 명시했지만, `getRecentShorts`가 반환하는 배열 자체는 **4분 이하 모든 영상**을 섞어 준다. YouTube의 공식 "Shorts" 정의는 60초 이하(2024년 10월부터 3분)로 계속 바뀌고 있으며, `videoDuration=short` API 파라미터는 YouTube가 공식적으로 "under 4 minutes"로 정의한 별도 개념이다. M5 `ShortFormSkill`이 이 리턴을 "현재 주의 Shorts 성과"로 그대로 쓰면 일반 2–3분 세로 영상이 섞여서 성과 지표가 오염된다.
  - 배치 3의 `FridgifyCascadeResult.satisfied` 같은 타입 레벨 강제가 여기에는 없다. "cross-check"는 주석에만 있고, M5 스킬 구현자가 주석을 놓치면 묵묵히 틀린 데이터로 넘어간다.
  - 배치 1–3 일관성 관점에서도, **collector가 domain invariant를 강제하지 않으면 skill 레이어에 책임이 분산**되는데 이 프로젝트는 반대 방향 (collector는 low-level, 맞다)을 택해 왔다. 그러나 여기서는 "Shorts"라는 이름을 달고 있어서 함수 이름과 반환 내용이 일치하지 않는 misnomer가 된다.
- **Impact**: M5 `ShortFormSkill`이 `getRecentShorts("UCfridgify")` 결과로 weekly briefing을 만들면, 상수 N개를 Shorts로 집계하는 숫자에 4분 영상이 섞여서 "view-per-second" 같은 파생 지표가 틀어진다. 직접 리뷰된 `docs/growth-agent/prd.md:176`의 "ShortFormSkill → YouTube Data API" 라인 신뢰성이 흔들린다.
- **Recommended fix**: 세 가지 옵션 중 택일, 그리고 택한 것을 **코드에 기록**.
  1. **(권장)** 함수 안에서 ISO 8601 duration을 파싱해 실제 60초(또는 config-driven 임계)를 넘는 항목을 drop한다. 파서는 `PT\d+M\d+S` 단순 케이스만 다루면 됨.
  2. 함수 이름을 `getRecentShortFormVideos`로 바꾸고 JSDoc에 "under 4 minutes, not strictly 60s" 명시. misnomer 제거만으로도 숙주 부채가 사라짐.
  3. `options`에 `maxDurationSeconds`를 받고 skill 레이어에서 `60`을 넘겨주도록 한다.
  어떤 선택이든 테스트로 고정한다. 예(옵션 1):
  ```typescript
  private static parseIsoDurationSeconds(d: string): number {
    const m = /^PT(?:(\d+)M)?(?:(\d+)S)?$/.exec(d);
    if (!m) return Number.POSITIVE_INFINITY;
    return Number.parseInt(m[1] ?? "0", 10) * 60 + Number.parseInt(m[2] ?? "0", 10);
  }

  async getRecentShorts(
    channelId: string,
    maxResults = 10,
    maxDurationSeconds = 60
  ): Promise<YouTubeVideoStats[]> {
    // ...as before, then:
    const stats = await this.getVideoStats(videoIds);
    return stats.filter(
      (v) =>
        YouTubeCollector.parseIsoDurationSeconds(v.duration) <=
        maxDurationSeconds
    );
  }
  ```
  최소한 **옵션 2** (이름 변경 + JSDoc)만이라도 즉시 반영 권장.

### L1. `arden-tts.ts`의 `normalizeTrailingSlash` 주석이 "앞쪽만" 정규화한다는 사실을 숨김

- **Severity**: LOW
- **Category**: Subtle invariant / readability
- **File**: `src/collectors/arden-tts.ts:47-48`
- **Issue**: `endpoint.replace(/\/+$/, "")`는 trailing slash만 잘라내고, 사용자가 `https://arden.example.com/api/` 처럼 **서브 경로를 포함해 base를 준** 경우는 그대로 둔다. 이 동작은 의도적이고 맞지만, 주석은 "normalizes trailing slash"라고만 쓰여 있어서, 향후 리더가 "서브경로 제거 안 해?" 하고 혼동할 수 있다. 또한 `synthesize`는 `${this.endpoint}/synthesize`로 무조건 `/synthesize`를 붙이는데, 사용자가 `https://arden.example.com/api/v2`를 주면 결과가 `https://arden.example.com/api/v2/synthesize`로 올바르게 나온다 (의도한 동작). 테스트(`arden-tts.test.ts:44-57`)는 trailing slash 단순 케이스만 커버함.
- **Recommended fix**: 주석을 "base URL에서 trailing slash만 제거한다 (subpath는 보존 — 사용자가 `/api/v2` 같은 버전 경로를 줄 수 있음)"로 확장하고, 서브경로 케이스 테스트 1개 추가.
  ```typescript
  it("preserves user-provided subpath in the endpoint", async () => {
    const subPathClient = new ArdenTtsClient({
      endpoint: "https://arden.example.com/api/v2",
    });
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      })
    );
    await subPathClient.synthesize("hi");
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "https://arden.example.com/api/v2/synthesize"
    );
  });
  ```

### L2. `YouTubeVideoStats.duration`이 empty string을 "missing" sentinel로 쓰지만 `publishedAt`은 `null` — 일관성 없음

- **Severity**: LOW
- **Category**: Type design consistency
- **File**: `src/types/collectors.ts:213-222` + `src/collectors/youtube.ts:131, 135`
- **Issue**: 같은 interface 안에서 missing 표현이 두 가지다: `publishedAt: string | null`, `duration: string` (empty로 missing). 두 종류의 "없음"을 소비자가 각각 처리해야 한다. 배치 3에서 수립한 "wire shape 일관성" 원칙과 대치된다. duration은 `string | null`이 더 맞다.
  - 구체적으로, M5 `ShortFormSkill`이 "duration 표시"를 할 때 `if (stats.duration)`로 fallthrough를 타면 empty string이 `""`로 렌더링되어 Block Kit에서 공백이 찍힌다.
- **Recommended fix**: 타입 `duration: string | null`로 바꾸고 collector에서 `item.contentDetails?.duration ?? null`로 반환. 기존 테스트(`youtube.test.ts:117`)는 그대로 통과 — "PT30S"는 문자열 그대로, null 케이스는 새 테스트 1개.

## Informational

### I1. Arden TTS endpoint의 "신뢰 경로"는 M5에서 반드시 검증되어야 한다

- **Severity**: INFO
- **Category**: Future-milestone gate
- **Observation**: H1과 한 쌍. H1은 **local** 방어 (생성자에서 scheme 체크)이고, I1은 **system** 방어 (call site가 user-controlled input을 주지 않는다는 계약). M5 `ShortFormSkill` 포팅 PR 리뷰 시 다음 세 가지를 반드시 확인한다:
  1. `new ArdenTtsClient({ endpoint })`의 `endpoint` 출처가 `config.ts`의 loader를 거친 값이고, Slack 메시지 / Claude 툴 호출 파라미터에서는 오지 않는다.
  2. `config.yaml` 스키마(M3 또는 M5에서 추가)에 `arden_tts.endpoint`가 **문자열**이고, Zod/JSON schema로 `url`/`https?:` 강제.
  3. `doctor.ts`가 Arden TTS endpoint에 대해 at-least HEAD probe를 하고 `https?:` 스킴을 재검증한다.
- **Action**: M5 리뷰 체크리스트에 위 3개 bullet 추가. 이 review 문서 자체가 pointer가 된다.

### I2. 이 배치가 `tests/skills/index.test.ts`의 uncommitted modification을 **안 건드리지만** 빌드 상태를 상속한다

- **Severity**: INFO
- **Category**: Working-tree hygiene
- **Observation**: `git status`에 `tests/skills/index.test.ts` modified가 있고, `tsc --noEmit` full repo는 `tests/messenger/slack.test.ts(117,3) TS2412`를 내놓는다. 사용자 메시지의 "build/lint 클린"은 배치 4 파일들에 한해서는 사실이지만, 리포지토리 전역은 이미 살짝 더러운 상태다. 이 배치의 스코프와는 무관하지만, **커밋 전에 최소한 `git status`를 확인**하고 unrelated modified 파일을 분리 커밋하거나 stash하기를 권장. 배치 4 자체 품질 게이트는 통과 (13 tests passing, 해당 파일 typecheck clean).
- **Action**: 이 배치 커밋 직전에 `tests/skills/index.test.ts`의 modified가 배치 4와 섞이지 않게 분리. 배치 4 리뷰 스코프 외.

## Data Flow Issues

없음. 두 collector 모두 pure wrapper이고 DB / messenger / core / safety / tools와 무관한 low-level API adapter. 데이터는 오직 `Promise<YouTubeVideoStats[]>` / `Promise<SynthesizeResult[]>`로만 흘러나가며, M4+ 스킬들이 이를 소비한다.

## Two-mode routing integrity

해당 없음. 이 배치는 `core.ts` / `skills/index.ts` / `tools/`를 건드리지 않는다. Arden TTS / YouTube 모두 **skill 전용 low-level client**이며 MCP tool 노출 후보가 아니다. Invariant (skills never exposed as MCP tools, no write from Mode B tools) 유지됨.

## Positive Observations

1. **`YouTubeCollectorTestHooks`를 옵션에서 분리한 판단**(`youtube.ts:17-25`)이 배치 2·3에서 확립된 "production config이 baseUrl override를 못 하게 한다 + 그래도 allowlist가 방어 심층으로 남는다"를 주석과 함께 재수립. 주석이 이미 "왜 분리했는지"를 명시적으로 설명해서 배치 1·2 초기 버전보다 향상됨.
2. **YouTube `getRecentShorts`의 "search → stats 2-step" 플로우 테스트**(`youtube.test.ts:49-121`)가 두 호출 간 video ID 인코딩(`id=v1%2Cv2`)까지 검증한다. 상류 API의 comma 취급이 플랫폼마다 다른데, 그걸 test spec으로 고정해 둔 건 regression 보호로 유효. 배치 3 `encodeURIComponent` 테스트 패턴의 건강한 확장.
3. **`getVideoStats([])` 및 `getRecentShorts("")` 숏서킷**이 `fetch`를 전혀 호출 안 하는 걸 `expect(mockFetch).not.toHaveBeenCalled()`로 단언(`youtube.test.ts:45-47, 136-140`). 쓸데없는 quota 소모 방지를 타입이 아닌 테스트로 보장.
4. **API key redaction 테스트**(`youtube.test.ts:142-161`)가 `not.toContain("yt-key")` + `toContain("[REDACTED]")` 두 축으로 positive/negative 양방향 단언. 배치 2 `asomobile.test.ts`의 redaction 테스트 패턴을 그대로 승계.
5. **`synthesizeBatch` 부분 실패 복구 테스트**(`arden-tts.test.ts:130-165`)가 "3개 중 2개 성공, 1개 실패" 시나리오와 `results.length === 2`를 동시 검증 + 실패 건이 중간 위치임에도 *순서대로* success 배열에 들어가는 걸 단언. 배치 개념이 직렬 실행이고 순서 보존임을 테스트로 못박음.
6. **named logger import** (`arden-tts.ts:2`의 `error as logError`)는 배치 3의 M1을 학습해 처음부터 정식 관례로 시작. 리뷰 피드백이 다음 배치로 이월되는 효과 좋음.
7. **`ArdenTtsClient`가 `console.error` 대신 `logError`를 쓴다** — growth-agent JS 원본의 `console.error` 관성을 그대로 이어가지 않고 adaria-ai 관례(`utils/logger.ts`)로 수정. 배치 3 M1의 교정 방향이 여기서 proactively 반영됨.
8. **camelCase wire shape의 일관 적용** (`video_id` → `videoId`, `published_at` → `publishedAt`, `parseInt` → `Number.parseInt`). 배치 1의 wire-shape delta 주석(`collectors.ts:11-26`)과 정확히 일관.

## Action Items

블로킹 (커밋 전):

- [ ] **H1** — `ArdenTtsClient` 생성자에 `URL()` 파싱 + `http:`/`https:` 스킴 체크 추가 (`src/collectors/arden-tts.ts:43-49`). 테스트 2개 추가 (non-http(s) scheme, unparseable URL). H1 수정 후에야 "Arden SSRF allowlist 생략"이 defensible한 결정으로 완성된다.

권장 (커밋 전 또는 M3 시작 전):

- [ ] **M1** — `YouTubeCollector.fetchJson`을 try/catch로 감싸 fetch-자체 실패 경로에서도 API key를 redact. 테스트 1개 추가 (`src/collectors/youtube.ts:45-66`).
- [ ] **M2** — `synthesizeBatch` 반환 타입에 `failures[]` 추가하거나 최소한 `logError`에 `{ statusCode }` 구조화 필드. 지금 M5 wiring 전이 깨기 가장 저렴한 시점 (`src/collectors/arden-tts.ts:88-108`).
- [ ] **M3** — `getRecentShorts`의 misnomer 해결. 옵션 1(duration 파싱 필터) 권장, 최소 옵션 2(이름 변경 + JSDoc) 반영 (`src/collectors/youtube.ts:73-99`).

선택 (취향/다음 배치에서 처리 가능):

- [ ] **L1** — `arden-tts.ts:47` trailing-slash 주석 확장 + subpath 보존 테스트 1개 (`tests/collectors/arden-tts.test.ts`).
- [ ] **L2** — `YouTubeVideoStats.duration: string | null`로 변경 + null 케이스 테스트 (`src/types/collectors.ts:221` + `src/collectors/youtube.ts:135`).

이월 (future milestone gates):

- [ ] **I1** — M5 `ShortFormSkill` 리뷰 체크리스트에 "Arden TTS endpoint 출처가 config loader만이고 user input 경로 없음" 명시. 이 review 문서 링크.
- [ ] **I2** — 커밋 직전 `tests/skills/index.test.ts` unrelated modification을 이 배치와 분리.

배치 4 블로킹 이슈: **H1만 해결되면 커밋 가능**. M1–M3는 이 배치 안에서 동시 처리 권장 (진입 장벽 낮고, 지금이 가장 저렴). H1 수정 후 `tsc --noEmit` 로컬 배치 파일만 재확인, `npx vitest run tests/collectors/` 재실행하여 13 → 15 tests 확인. 배치 4가 통과되면 M2는 smoke script 하나만 남음(checklist.md M2 블록 최종 소진 직전).

## Re-review 2026-04-12

**Scope**: 원본 리뷰 H1 + M1 + M2 + M3 + L2 반영 여부 재검증.
**Result**: **PASS (커밋 가능)**. CRITICAL/HIGH 재발 없음. 모든 블로킹 + 권장 항목이 의도대로 구현되었고, 신규 회귀도 없음.

### 반영 확인

| Item | Status | 근거 |
|------|--------|------|
| **H1** `ArdenTtsClient` scheme/URL 검증 | ✓ Fixed | `arden-tts.ts:54-80` 생성자가 `options.endpoint.trim()` → `new URL()` 파싱 → `protocol !== "http:" && protocol !== "https:"` 검사. 테스트 3개 (`arden-tts.test.ts:44-57`): `javascript:alert(1)`, `file:///etc/passwd`, `"not a url at all"` 모두 throw 확인. Allowlist 생략 결정이 이제 "스킴 강제 + parseability 강제"라는 최소 계약으로 뒷받침되어 defensible한 의도적 이탈로 승격됨. |
| **M1** YouTube fetch-level redaction | ✓ Fixed | `youtube.ts:45-67`의 `fetchJson`이 `let response: Response` + `try { response = await fetch(...) } catch { throw new ExternalApiError(..redact(raw)..) }` 패턴. `redact()`를 private method로 추출해 ok/not-ok/throw 세 경로 모두에서 동일 redaction 통과. 테스트 `redacts the API key from fetch-level failures`(`youtube.test.ts:258-272`)가 `mockRejectedValueOnce(new TypeError("fetch failed: ...?key=yt-key"))`로 fetch-level 예외를 강제하고 `.not.toContain("yt-key") + .toContain("[REDACTED]")` 양방향 단언. 권고한 512자 slice도 유지. |
| **M2** `synthesizeBatch` 구조화 반환 | ✓ Fixed | `arden-tts.ts:40-49`에 `SynthesizeFailure { title, error, statusCode? }`와 `SynthesizeBatchResult { successes, failures }` 신규 타입. `synthesizeBatch`(`121-147`)가 `ExternalApiError` 분기에서 `statusCode`를 추출해 failure 객체에 optional로 담고 `logError`에도 구조화 필드로 전달. **중요**: `exactOptionalPropertyTypes`를 존중해 `statusCode !== undefined` 가드로만 할당 — strict 타입과 호환. 테스트(`arden-tts.test.ts:162-200`)가 3개 중 2개 성공/1개 실패 + 순서 보존 + `failures[0].statusCode === 500` 검증. M5 wiring 전 파괴적 변경을 가장 저렴한 시점에 소화. |
| **M3** `getRecentShorts` 60초 필터 | ✓ Fixed | `youtube.ts:90-119`에 `maxDurationSeconds = 60` 기본값 + `parseIsoDurationSeconds`(160-173) 파서. 파서 regex `^PT(?:(\d+)M)?(?:(\d+)S)?$`는 시간 단위(`H`)를 포함하지 않는 의도적 설계 — `PT1H0M`은 매치 실패 → `POSITIVE_INFINITY` → 필터 아웃. `PT3M0S`는 매치 → 180s > 60s → 필터 아웃. `PT45S`는 45s ≤ 60s → 통과. 주석(167-168)에 "hourly clips fall through as INFINITY" 계약이 문서화되어 리더의 혼동을 사전에 차단. 테스트 2개(`youtube.test.ts:173-256`): 기본 60s로 `PT45S`/`PT3M0S`/`PT1H0M` 세 케이스 혼합 시 `short`만 남고, override 180으로 `PT3M0S` 통과. 권고 옵션 1(파싱 필터) 전면 채택. |
| **L2** `duration: string \| null` | ✓ Fixed | `types/collectors.ts:221`이 `duration: string \| null`로 변경, JSDoc도 "or null if missing" 추가. `youtube.ts:155` mapper가 `item.contentDetails?.duration ?? null`로 empty-sentinel 제거. `parseIsoDurationSeconds`(166-173)가 `string \| null`을 직접 받아 `if (!duration)` falsy 가드. `publishedAt`과 표현 방식 통일 — 배치 3의 wire shape 일관성 원칙 회복. |

### 재발 검증 (CRITICAL/HIGH 없음)

- **H1 회귀 가능성**: scheme 검사가 `replace(/\/+$/, "")` 이전에 위치해 모든 constructor path 통과. `javascript:void(0)` 같은 가짜 스킴이 우회할 경로 없음. URL 생성자가 relative path를 거부하므로 `parsed = new URL(" trimmed")`가 `protocol`을 빈 값으로 둘 수 없음.
- **M1 회귀 가능성**: `fetch`가 throw하는 경로 외에 `response.text()`가 throw할 수도 있지만, 그 경우도 이미 `!response.ok` 분기 안에 있어 catch 대상은 아님. 단 향후 `response.text()` 실패 시 redaction이 우회될 여지는 남아 있으나, 이는 기존 리뷰 스코프 밖이고 실무 시나리오로 극히 드물어 플래그하지 않음.
- **M2 회귀 가능성**: `exactOptionalPropertyTypes` 하에서 `{ statusCode: undefined }`를 직접 할당하면 타입 에러인데, 현재 코드는 `if (statusCode !== undefined) failure.statusCode = statusCode`로 이를 회피함. build 통과가 이를 입증.
- **M3 회귀 가능성**: `parseIsoDurationSeconds` 파서가 `PT0S`(0초), `PT60S`(경계)를 지원해야 하는데 각각 0 ≤ 60, 60 ≤ 60으로 통과. `PT1M`(초 누락) → `minutes=1, seconds=0` → 60s → 통과. `PT10S` → 10s → 통과. 모두 의도와 일치. 단 `PT2M5S10` 같은 잘못된 문자열은 regex $ anchor 덕에 매치 실패 → INFINITY → 안전 쪽으로 실패. `videoDuration=short` API 필터(<4min) + collector 60s 필터가 이중 방어 레이어로 작동.
- **Mode A/B routing**: 두 파일 모두 여전히 low-level collector이고 MCP tool 경로 없음. `src/tools/`에 신규 항목 추가 없음 (현 단계에 tools 디렉터리 자체가 M5.5 전). Invariant 유지.
- **Approval / safety 경로**: 두 파일 모두 순수 read path, write action 없음. `safety.ts` 회귀 가능성 0.
- **`ADARIA_DRY_RUN`**: write 경로 신규 추가 없음, 해당 없음.
- **`ADARIA_HOME` / `import.meta.url`**: 두 파일 모두 파일시스템 assets 사용 안 함. 해당 없음.

### Gate 결과

| Gate | Status |
|------|--------|
| `npm run build` | ✓ clean (`tsc -p tsconfig.build.json` 에러 없음) |
| `npm run lint` | ✓ clean (`eslint src/ tests/`) |
| `npm test` | ✓ **340 passed** (이전 334 → +6: arden-tts 3개(scheme reject ×2 + subpath 보존) + youtube 3개(default 60s 필터 + override 180 + fetch-level redact)) |
| `tests/skills/index.test.ts` unrelated modification | INFO: working tree에 여전히 존재(`git status` M 상태). I2는 배치 4 스코프 밖이며 해당 파일도 all passing 상태이므로 커밋 시 별도 처리 권장. 재리뷰 대상 아님. |

### 관찰 사항

- `parseIsoDurationSeconds`의 "알 수 없는 형태 = INFINITY" 설계는 **안전 쪽으로 실패**하는 올바른 선택. `0` 또는 `NaN`으로 갔으면 악성/이상 duration이 조용히 통과했을 것. 주석에 이 트레이드오프 명시도 잘됨.
- `YouTubeCollector.redact`를 private method로 추출한 리팩터는 원 리뷰가 요구한 것 이상. ok/not-ok/throw 세 경로 모두 한 함수 통과 보장 — 향후 신규 에러 경로 추가 시에도 redaction 자동 적용.
- `SynthesizeFailure.statusCode`를 `exactOptionalPropertyTypes` 가드로 조건부 할당한 패턴은 strict 설정 호환 + 타입 표면 노이즈 최소화. 배치 5+에서 optional 필드 다룰 때 재사용 가능한 관례.
- 원 리뷰 L1(subpath 보존 주석 확장)은 별도 명시 없이도 `arden-tts.ts:76-78` 주석이 "subpath is preserved"로 확장되어 있고 대응 테스트(`arden-tts.test.ts:59-74`)도 추가됨. 덤으로 같이 해결.

### Action Items (post-commit)

- [ ] **I1** (이월) — M5 `ShortFormSkill` 리뷰 시 "Arden TTS endpoint 출처가 config loader + user input 경로 없음" 체크. H1이 local 방어를 제공하지만 system 방어는 여전히 M5 책임.
- [ ] **I2** (스코프 외) — `tests/skills/index.test.ts` unrelated modification 분리 커밋 또는 stash.

**판정**: 배치 4는 블로킹 해제. 기존 리뷰의 모든 블로킹(H1) + 권장(M1/M2/M3) + 선택(L2) 항목이 원안 또는 더 나은 형태로 반영되었고, 새로운 CRITICAL/HIGH 회귀 없음. 커밋 진행 권장.
