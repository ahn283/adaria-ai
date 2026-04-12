# Code Review: M4 ASO Skill -- First Skill Pattern Proof

**Date**: 2026-04-12
**Scope**: `src/types/skill.ts`, `src/skills/aso.ts`, `src/skills/index.ts`, `src/prompts/loader.ts`, `prompts/aso-*.md`, `src/agent/core.ts`, `tests/skills/aso.test.ts`, `tests/skills/index.test.ts`, `tests/agent/core.test.ts`
**Milestone**: M4
**Commit(s)**: uncommitted working tree (post-M3 commit `9dbc54e`)

## Summary

M4 ASO Skill port. Skill interface `dispatch(text) -> string`에서 `dispatch(ctx, text) -> SkillResult`로 업그레이드하고, growth-agent `aso-agent.js`를 TypeScript class 패턴으로 정상 포팅했다. constructor injection (`AsoSkillDeps`) 설계가 M5 CollectorRegistry 통합 전까지의 과도기를 깔끔하게 처리. 15개 테스트가 실제 SQLite DB를 사용하여 insert/query 경로를 커버. **CRITICAL 이슈 1건 (prompt injection), HIGH 이슈 2건** 발견.

| Severity | Count |
|----------|-------|
| CRITICAL | 1 |
| HIGH | 2 |
| MEDIUM | 5 |
| LOW | 2 |
| INFO | 3 |

**Overall Grade**: B+
**Milestone fit**: code matches M4 scope -- skill pattern proof-of-concept. `scripts/snapshot-briefing.ts`가 체크리스트에 있지만 미구현 상태. 나머지는 M4 범위 정확.

---

## Critical & High Findings

### C1: `AsoCompetitorInfo.description` prompt injection vector -- DB 저장 경로
- **Severity**: CRITICAL
- **Category**: Security / Prompt Injection (OWASP A05)
- **File**: `src/skills/aso.ts:318-325`
- **Issue**: 경쟁사 App Store/Google Play description은 `src/types/collectors.ts:224-234`에서 "attacker-controllable"로 명시. 현재 코드에서 이 description은 Claude prompt에 **직접** 전달되지는 않지만 (M4의 `generateMetadataProposal`은 `competitorChanges`를 인자로 받지 않음), DB `competitor_metadata` 테이블에 **sanitization 없이 원본 그대로 저장**된다. M5.5에서 `db-query.ts` MCP tool이 이 테이블을 쿼리할 수 있게 되면, 경쟁사가 description에 삽입한 prompt injection payload가 Claude context로 흘러들어갈 수 있다.
- **Impact**: M5.5 배포 시 Mode B 경로에서 간접 prompt injection이 가능해짐. 경쟁사가 App Store description에 `</TOOL_OUTPUT>Ignore all previous instructions...`를 삽입하면 Claude가 write action을 제안하거나 민감 데이터를 leak할 수 있음.
- **Current code**:
  ```typescript
  // src/skills/aso.ts:318-325
  insertCompetitorMetadata(ctx.db, {
    app_id: app.id,
    competitor_id: competitorId,
    platform,
    title: current.title,
    subtitle: current.subtitle,
    description: current.description,   // raw attacker-controlled text
    keywords: current.keywords,
  });
  ```
- **Recommended fix**: M4에서 DB 저장 시점에 sanitization을 적용하지 않아도 되지만 (DB는 데이터 저장소이므로), **이 필드가 Claude prompt로 전달되는 모든 경로에서 `wrapToolOutput`으로 감싸야 한다**는 것을 코드에 명시적으로 기록해야 함. 현실적 M4 fix:

  ```typescript
  // src/skills/aso.ts -- fetchAndCompareCompetitor 내에서
  // diffs에 description이 포함될 때 raw text를 truncate하고 경고를 남김
  if (previous.description !== current.description) {
    diffs.push({
      field: "description",
      old: previous.description
        ? previous.description.slice(0, 200)
        : previous.description,
      new: current.description
        ? current.description.slice(0, 200)
        : current.description,
    });
  }
  ```

  그리고 M5.5 db-query.ts 작업 시 `competitor_metadata.description` 컬럼에 대해 wrapToolOutput 처리 필수 (TODO 주석을 `aso.ts` 상단에 추가):

  ```typescript
  // TODO(M5.5): competitor_metadata.description is attacker-controllable.
  // When db-query.ts exposes this table, the description column must be
  // wrapped with wrapToolOutput() before inclusion in Claude context.
  // See src/types/collectors.ts AsoCompetitorInfo JSDoc.
  ```

### H1: `buildSkillContext().runClaude` -- system prompt / MCP tools 미적용
- **Severity**: HIGH
- **Category**: Architecture / Data Flow
- **File**: `src/agent/core.ts:551-558`
- **Issue**: `buildSkillContext()`에서 생성되는 `runClaude` 함수가 `invokeClaudeCli`를 bare로 호출한다. system prompt도 없고, `--mcp-config`도 없다. 이것은 Mode A에서 skill이 Claude를 호출할 때 (예: ASO metadata proposal 생성) Claude에게 아무런 persona 지시 없이 prompt만 전달한다는 뜻이다. M1의 Mode B 경로는 `buildBaseSystemPrompt()`으로 system prompt를 주입하지만 Mode A의 skill 경로는 그렇지 않다.
- **Impact**: 1) Skill prompt template가 이미 충분한 persona 정의를 포함하므로 (e.g. "You are a senior ASO consultant...") 당장 기능적 문제는 아님. 2) 하지만 향후 skill이 추가 Claude 호출을 체이닝하거나 MCP tool을 사용하게 되면 (M5 seo-blog가 review insights + aso insights를 cross-reference하는 시나리오) 이 bare 호출이 제약이 된다. 3) 더 중요하게, 이 호출에서는 audit log가 기록되지 않는다. `invokeClaudeCli`는 자체 audit을 하지 않음.
- **Current code**:
  ```typescript
  runClaude: async (prompt: string): Promise<string> => {
    const result = await invokeClaudeCli({
      prompt,
      cliBinary: this.config.claude.cliBinary,
      timeoutMs: this.config.claude.timeoutMs,
    });
    return result.result;
  },
  ```
- **Recommended fix**: M4에서는 audit logging만 추가. system prompt은 불필요 (prompt template가 역할을 대신함):

  ```typescript
  runClaude: async (prompt: string): Promise<string> => {
    const result = await invokeClaudeCli({
      prompt,
      cliBinary: this.config.claude.cliBinary,
      timeoutMs: this.config.claude.timeoutMs,
    });
    await writeAuditLog({
      type: "claude_invoke",
      userId: "system",
      platform: "skill",
      content: `skill-claude prompt=${prompt.slice(0, 200)}... result=${result.result.slice(0, 200)}...`,
    });
    return result.result;
  },
  ```

### H2: `SkillContext.runClaude`에 circuit breaker 및 error differentiation 미적용
- **Severity**: HIGH
- **Category**: Reliability / Error Handling
- **File**: `src/agent/core.ts:551-558`
- **Issue**: Mode B의 `invokeClaudeWithContext`는 session 관리, msg_too_long fallback, error differentiation을 모두 처리한다. Mode A의 `runClaude`는 raw `invokeClaudeCli` 호출이다. AsoSkill은 각 Claude 호출을 `try/catch`로 감싸고 있어서 (lines 402-407, 429-434, 449-454) 개별 실패를 gracefully 처리하지만, circuit breaker가 작동하지 않으므로 Claude CLI가 연속으로 실패해도 skill은 계속 retry를 시도한다. 주간 분석 (M6 orchestrator)에서 7개 skill x 3개 app x 평균 3 Claude 호출 = 63번의 Claude spawn이 전부 timeout 나는 시나리오를 고려하면, circuit breaker 없이 21분+ 대기가 발생할 수 있다.
- **Impact**: orchestrator 타임아웃 (launchd `TimeoutDictionary` / 기본 30분)에 걸리거나, 불필요한 API quota 소진. M4 단독 실행에서는 최대 3회 호출이므로 위험도 낮지만, M6 orchestrator 배치에서는 문제가 됨.
- **Recommended fix**: M4에서는 INFO급으로 두고, M6 작업 시 `runClaude`에 circuit breaker wrapping을 추가하거나, orchestrator 레벨에서 skill별 타임아웃을 적용. 다만 `SkillContext.runClaude`의 시그니처에 circuit breaker 정보를 노출할 필요 없음 -- 내부 구현에서 wrapping하면 충분:

  ```typescript
  // M6 시점에 core.ts에서 아래처럼 wrapping
  import { CircuitBreaker } from "../utils/circuit-breaker.js";
  
  private readonly skillClaudeBreaker = new CircuitBreaker({
    failureThreshold: 3, resetTimeout: 60_000,
  });
  
  // buildSkillContext 내:
  runClaude: async (prompt: string): Promise<string> => {
    return this.skillClaudeBreaker.call(async () => {
      const result = await invokeClaudeCli({ ... });
      return result.result;
    });
  },
  ```

---

## Medium Findings

### M1: Skill interface에 `schedule` 필드 누락
- **Severity**: MEDIUM
- **Category**: Architecture / Interface Completeness
- **File**: `src/types/skill.ts` / `src/skills/index.ts`
- **Issue**: `porting-matrix.md` line 173의 Skill interface sketch에는 `schedule?: 'weekly' | 'daily'`가 있다. 이 필드는 M6 orchestrator가 어떤 skill을 주간/일간 실행해야 하는지 결정하는 데 쓰인다. 현재 M4 구현에서 빠져 있다.
- **Impact**: M6에서 orchestrator가 registry를 순회하며 `skill.schedule === 'weekly'`인 skill만 실행해야 하는데, 이 필드가 없으면 별도의 하드코딩된 리스트가 필요해짐.
- **Recommended fix**: M4에서 추가하되 optional로:

  ```typescript
  // src/types/skill.ts 또는 src/skills/index.ts Skill interface
  /** How the orchestrator should invoke this skill. */
  readonly schedule?: "weekly" | "daily";
  ```

  ```typescript
  // src/skills/aso.ts
  readonly schedule = "weekly" as const;
  ```

### M2: `preparePrompt` -- unreplaced placeholder 무시
- **Severity**: MEDIUM
- **Category**: Code Quality / Defensive Programming
- **File**: `src/prompts/loader.ts:22-34`
- **Issue**: `preparePrompt`는 template에서 `{{var}}`를 대체하지만, 대체되지 않은 placeholder가 남아 있어도 경고 없이 그대로 반환한다. 예를 들어 prompt template에 `{{rankChanges}}`가 있는데 caller가 `rankChanges` 키를 빠뜨리면 Claude에게 raw `{{rankChanges}}` 문자열이 전달된다.
- **Impact**: 디버깅 난이도 증가. Claude가 `{{rankChanges}}`를 해석하려고 시도하면서 이상한 결과를 만들 수 있음.
- **Recommended fix**:

  ```typescript
  export function preparePrompt(
    name: string,
    vars: Record<string, string>,
  ): string {
    const filePath = path.join(BUNDLED_PROMPTS_DIR, `${name}.md`);
    let template = fs.readFileSync(filePath, "utf-8");

    for (const [key, value] of Object.entries(vars)) {
      template = template.replaceAll(`{{${key}}}`, value);
    }

    // Warn on unreplaced placeholders -- likely a caller bug.
    const unreplaced = template.match(/\{\{[a-zA-Z_]+\}\}/g);
    if (unreplaced) {
      logWarn(
        `[prompt-loader] Unreplaced placeholders in "${name}": ${unreplaced.join(", ")}`,
      );
    }

    return template;
  }
  ```

### M3: `stubCtx`에서 `db: undefined as never` -- 타입 안전성 우회
- **Severity**: MEDIUM
- **Category**: TypeScript Correctness
- **File**: `src/agent/core.ts:223-228`
- **Issue**: M1 placeholder path에서 DB가 없을 때 `db: undefined as never`로 캐스팅한다. PlaceholderSkill은 `_ctx`를 무시하므로 런타임에서는 안전하지만, M5에서 PlaceholderSkill이 제거된 후 실수로 이 path를 통해 real skill이 호출되면 `ctx.db.prepare(...)` 에서 runtime crash가 발생한다.
- **Impact**: M5에서 PlaceholderSkill 제거 시 이 stub path도 함께 제거하지 않으면 runtime crash 가능성.
- **Current code**:
  ```typescript
  const stubCtx: SkillContext = skillCtx ?? {
    db: undefined as never,
    apps: [],
    config: this.config,
    runClaude: () => Promise.resolve(""),
  };
  ```
- **Recommended fix**: 의도를 명확히 하고 guard를 강화:

  ```typescript
  if (!skillCtx) {
    // M1 placeholder path -- db not yet initialized.
    // Real skills (AsoSkill, etc.) require db; if this code runs
    // with a non-placeholder skill, it's a wiring bug.
    if (!(skill instanceof PlaceholderSkill)) {
      const errMsg = `Skill "${skill.name}" requires db but AgentCore was constructed without one`;
      logError(errMsg);
      response = `Error: ${errMsg}`;
    } else {
      const result = await skill.dispatch(
        { db: undefined as never, apps: [], config: this.config, runClaude: () => Promise.resolve("") },
        msg.text,
      );
      response = result.summary;
    }
  } else {
    const result = await skill.dispatch(skillCtx, msg.text);
    response = result.summary;
  }
  ```

  또는 더 간단히 -- `buildSkillContext()`가 null일 때 non-placeholder skill이면 error를 반환:

  ```typescript
  const skillCtx = this.buildSkillContext();
  if (!skillCtx && skill.name !== "placeholder") {
    // ... error
  }
  ```

### M4: `AsoSkill.dispatch` -- `app.competitors`가 undefined일 수 있음
- **Severity**: MEDIUM
- **Category**: TypeScript / Zod Schema Alignment
- **File**: `src/skills/aso.ts:287`
- **Issue**: `app.competitors`는 `apps-schema.ts`에서 `z.array(z.string()).default([])`이므로 undefined가 아닌 `string[]`이 보장된다. 그러나 `detectCompetitorChanges`에서 `app.competitors`를 직접 참조할 때, TypeScript 타입 시스템은 이를 보장하지만 runtime에서 yaml이 zod를 거치지 않고 로드되면 crash할 수 있다. 현재 코드는 `if (competitors.length === 0) return [];`으로 빈 배열을 처리하므로 실질적으로 안전하지만, 이는 zod default에 의존하는 implicit contract.
- **Impact**: 매우 낮음 -- zod validation이 load-apps.ts에서 보장됨. 방어적 코딩 관점에서 참고.
- **Recommended fix**: 현재 코드 유지 가능. 별도 조치 불필요.

### M5: Test coverage -- `competitorChanges` 2nd-run diff detection 테스트 누락
- **Severity**: MEDIUM
- **Category**: Testing
- **File**: `tests/skills/aso.test.ts:156-171`
- **Issue**: 현재 테스트는 첫 번째 실행에서 competitor data가 DB에 삽입되는 것까지 확인하지만, 두 번째 실행에서 competitor가 metadata를 변경했을 때 diff를 감지하는 시나리오를 테스트하지 않음. `getPreviousCompetitorMetadata`는 `recorded_at < datetime('now', '-7 days')` 조건이므로, 같은 날에 두 번 실행해도 diff가 감지되지 않는다는 점을 테스트로 문서화해야 함.
- **Impact**: diff 감지 로직의 regression을 감지할 수 없음.
- **Recommended fix**: 7일 전 데이터를 수동 삽입한 후 두 번째 실행 테스트:

  ```typescript
  it("detects competitor metadata changes vs 7-day-old snapshot", async () => {
    const deps = createMockDeps();
    const skill = new AsoSkill(deps);
    const ctx = createCtx(db);

    // Manually insert a "7 days ago" competitor snapshot
    db.prepare(`INSERT INTO competitor_metadata
      (app_id, competitor_id, platform, title, subtitle, description, keywords, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-8 days'))
    `).run("fridgify", "comp1", "ios", "Old Title", "Old Sub", "Old Desc", "old,kw");

    // Mock returns different metadata
    deps.asoMobile.getCompetitorInfo = vi.fn().mockResolvedValue({
      title: "New Title",
      subtitle: "New Sub",
      description: "New Desc",
      keywords: ["new", "kw"],
    });

    const result = await skill.dispatch(ctx, "aso fridgify");

    expect(result.summary).toContain("Competitor metadata change");
  });
  ```

---

## Low Findings

### L1: `PlaceholderSkill` export -- 불필요한 public API 확대
- **Severity**: LOW
- **Category**: API Surface
- **File**: `src/skills/index.ts:78`
- **Issue**: `PlaceholderSkill`이 `export class`로 변경됨. 이전에는 private class였다. core.ts의 `instanceof PlaceholderSkill` 체크를 위해 export가 필요할 수 있지만, 현재 코드에서는 사용되지 않음.
- **Impact**: 없음. M5에서 PlaceholderSkill이 제거되면 export도 사라짐.
- **Recommended fix**: M3 fix에서 `instanceof` 체크를 쓰지 않는다면 다시 private으로 돌려도 됨. 단, M5에서 제거 예정이므로 저우선.

### L2: Prompt template 파일명과 `aso-description.md` 미사용 파일
- **Severity**: LOW
- **Category**: Dead Code
- **File**: `prompts/aso-description.md`
- **Issue**: `aso-description.md`가 M4에서 추가되었지만 코드에서 참조하지 않음. 리뷰 요청 본문에 "not used in M4 but part of ASO set"으로 명시됨.
- **Impact**: 없음 -- M5에서 SeoBlogSkill이 ASO insights를 cross-reference할 때 사용될 수 있음. tarball 크기에 미미한 영향.
- **Recommended fix**: 현 상태 유지. 필요 시 M5에서 연결.

---

## INFO Findings

### I1: `SkillContext` -- `runner: ClaudeRunner` 대신 `runClaude: (prompt) => Promise<string>`
- **Severity**: INFO
- **Category**: Architecture Decision
- **Note**: porting-matrix sketch에서는 `runner: ClaudeRunner`로 명시했으나, 실제 구현은 `runClaude` 함수로 대체. 이 결정이 더 나은 이유: 1) Skill이 `ClaudeRunner` 구현체에 의존하지 않음 (테스트에서 `vi.fn().mockResolvedValue(...)` 한 줄로 mock). 2) circuit breaker, audit, system prompt 등을 core.ts에서 투명하게 wrapping 가능. 3) M5에서 skill이 Claude를 여러 번 호출할 때 호출별로 다른 system prompt이 필요하면 `runClaude(prompt, options?)` 시그니처를 확장하면 됨.

### I2: `AsoSkill.commands`에 한국어 alias 누락
- **Severity**: INFO
- **Category**: Feature Completeness
- **Note**: growth-agent의 commands.js에서는 `ASO 재분석` 한국어 trigger가 있었다 (porting-matrix line 158). 현재 `AsoSkill.commands = ["aso"]`만 등록됨. M4 범위에서는 영문 trigger만으로 충분하지만, M5 일괄 등록 시 한국어 alias를 추가할 것.

### I3: `ADARIA_DRY_RUN` 체크 -- M4 범위에서 해당 없음
- **Severity**: INFO
- **Category**: Compliance
- **Note**: AsoSkill의 유일한 write path는 `insertKeywordRanking`과 `insertCompetitorMetadata`인데, 이는 DB insert (분석 데이터 수집)이지 외부 시스템에 대한 write가 아님. `ADARIA_DRY_RUN`이 보호해야 하는 write path는 `blog_publish`, `metadata_change`, `review_reply` 등 외부에 영향을 주는 action임. AsoSkill의 approval item (`aso-meta-<app>`)은 아직 safety.ts와 연결되어 있지 않으므로 (M5에서 연결), dry run 체크는 M5/M6에서 safety.ts에 구현하는 것이 올바른 위치.

---

## Two-Mode Routing Integrity

### Mode A (Skill Dispatch)
- `core.ts`의 `skillRegistry.findSkill(msg.text)`가 `"aso"` 토큰 매칭 -> `AsoSkill.dispatch(ctx, text)` 호출 -- **정상**
- `SkillResult.summary`가 Slack 응답으로 전달 -- **정상**
- Claude CLI가 Mode A에서 호출되지 않음 (skill 내부에서 `ctx.runClaude`를 통해서만) -- **정상**
- `SkillResult.approvals`와 `SkillResult.alerts`는 현재 core.ts에서 무시됨 (summary만 반환). M5에서 approval 처리, M6에서 alert 집계가 추가되어야 함 -- **예상된 M4 scope 한계**

### Mode B (Claude Fall-through)
- `"aso"`가 아닌 자유 텍스트 -> `findSkill` returns null -> Mode B 진입 -- **정상**
- Mode B에서 MCP tools 미등록 (M1 상태 유지) -- **정상**
- core.test.ts에서 두 mode 모두 테스트됨 -- **정상**

### `SkillResult.alerts` / `SkillResult.approvals` -- core.ts에서 미처리
- `core.ts` line 229: `response = result.summary` -- alerts와 approvals는 버려짐
- M5에서 `result.approvals`를 `this.approvalManager`에 전달하고, `result.alerts`를 DB에 기록하는 로직 필요
- M4 범위에서는 정상: skill이 반환은 하되 core가 소비하지 않음

---

## Data Flow Issues

### Collector -> Skill -> DB 경로
```
AsoMobileCollector.getKeywordRankings(storeId, platform, keywords)
  -> AsoSkill.collectKeywordRankings()
  -> insertKeywordRanking(ctx.db, {...})  // DB write
  -> getKeywordRankChange(ctx.db, ...)    // DB read (7-day lookback)
```
- 정상 동작. DB에 insert한 후 rank change를 쿼리하는 순서가 올바름.
- `getKeywordRankChange`의 `previous_rank` subselect는 `< datetime('now', '-7 days')` 조건이므로, 방금 insert한 데이터는 "current"로만 잡히고 "previous"에는 잡히지 않음 -- 의도된 동작.

### Skill -> Claude -> Approval 경로
```
AsoSkill.generateMetadataProposal()
  -> preparePrompt("aso-metadata", vars)   // template 로드
  -> ctx.runClaude(prompt)                  // Claude CLI 호출
  -> metadataProposal (string)
  -> approvals.push({id, description, agent, payload})
```
- 정상. approval item은 생성되지만 core.ts에서 아직 소비되지 않음 (M5 연결 예정).

### Prompt Injection 데이터 흐름
```
AsoMobileCollector.getCompetitorInfo(competitorId, platform)
  -> AsoCompetitorInfo { title, subtitle, description, keywords }
     (description은 attacker-controllable)
  -> insertCompetitorMetadata(ctx.db, ...)        // DB에 raw 저장
  -> getPreviousCompetitorMetadata(ctx.db, ...)   // DB에서 읽기
  -> CompetitorChange.diffs (old/new description 포함)
  -> buildSummary() -- competitorId만 사용, description은 Slack에 노출 안 됨
```
- M4에서는 안전: description이 Claude prompt나 Slack 메시지에 직접 전달되지 않음
- **M5.5 위험**: `db-query.ts`가 `competitor_metadata` 테이블을 expose하면 description이 Claude context에 들어감 -> C1 참조

---

## Positive Observations

1. **Constructor injection (`AsoSkillDeps`)**: M5의 CollectorRegistry 통합 전까지 깔끔한 과도기 설계. 테스트에서 mock 교체가 자연스러움.

2. **`Promise.allSettled` 사용 (line 298)**: 경쟁사 fetch에서 한 경쟁사 실패가 다른 경쟁사 분석을 막지 않음. 이 패턴을 M6 orchestrator에서도 동일하게 적용해야 함.

3. **Error isolation**: AsoSkill의 모든 외부 호출 (`collectKeywordRankings`, `findOpportunities`, `detectCompetitorChanges`, `generateMetadataProposal`, `generateScreenshotSuggestions`, `generateInAppEventSuggestions`)이 try/catch로 감싸져 있고 logWarn으로 기록됨. 하나가 실패해도 나머지 분석은 계속 진행.

4. **테스트 품질**: 15개 테스트가 실제 SQLite DB를 사용 (`:memory:`가 아닌 tmpdir). DB insert/query 경로가 integration 수준으로 검증됨. Collector mock과 Claude mock의 경계가 명확.

5. **`parseAppNameFromCommand` 추출**: 공통 유틸로 분리되어 M5 다른 skill에서 재사용 가능. 테스트에서 edge case (trailing whitespace, uppercase) 커버됨.

6. **SkillResult 타입 설계**: `summary + alerts + approvals` 구조가 growth-agent의 ad-hoc return shape보다 체계적. M6 orchestrator가 이 구조를 iterate하여 briefing을 조립하기 좋음.

7. **Prompt template loader의 `import.meta.url` 기반 경로 해석**: `BUNDLED_PROMPTS_DIR`가 `paths.ts`에서 `import.meta.url` 기반으로 해석되므로 npm global install에서도 prompt 파일을 찾을 수 있음 -- M9 smoke test를 미리 대비한 설계.

---

## Action Items

- [ ] **CRITICAL**: C1 fix -- `aso.ts` 상단에 TODO 주석 추가 (M5.5 `db-query.ts`에서 `competitor_metadata.description` 노출 시 `wrapToolOutput` 적용 필수). `fetchAndCompareCompetitor`에서 diffs에 포함되는 description을 200자로 truncate.
- [ ] **HIGH**: H1 fix -- `buildSkillContext().runClaude`에 audit log 추가 (skill-claude 호출 추적).
- [ ] **HIGH**: H2 fix -- M6 작업 시 skill-level circuit breaker 추가 (M4에서는 TODO 주석으로 기록).
- [ ] **MEDIUM**: M1 -- `Skill` interface에 `schedule?: 'weekly' | 'daily'` 추가, `AsoSkill`에 `schedule = 'weekly'` 설정.
- [ ] **MEDIUM**: M2 -- `preparePrompt`에 unreplaced placeholder 경고 추가.
- [ ] **MEDIUM**: M3 -- `core.ts` stub context에 non-placeholder skill guard 추가.
- [ ] **MEDIUM**: M5 test -- competitor 7-day diff detection 테스트 추가.
- [ ] Checklist 업데이트: M4 tick items 완료 표시, `scripts/snapshot-briefing.ts` 미구현 상태 기록.
