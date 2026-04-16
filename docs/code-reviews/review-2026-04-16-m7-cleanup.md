# Code Review: M7 Cleanup — Remove DRY_RUN + Parallel-Run Framing

**Date**: 2026-04-16
**Scope**: ~35 files (DRY_RUN removal across `src/social/`, `src/skills/`, `src/agent/core.ts`, `src/cli/start.ts`, `src/brands/`, deleted dev scripts + tests, doc rewrites)
**Milestone**: M7 (reframed as pre-launch smoke)
**Commit(s)**: uncommitted working tree

## Summary

DRY_RUN 분기 자체는 production 코드/테스트/스크립트/launchd/prompts에서 깔끔히 제거됐고 빌드·린트·테스트(686/686) 모두 통과한다. 단 (1) 두 군데 stale 잔재가 남아 있고, (2) `doctor.ts`·SETUP.md·agent prompt 등 docs/source 5곳이 여전히 “M7 parallel run”을 안내한다, (3) 더 중요한 건 social 클라이언트 `post()` HTTP path 커버리지가 실제로 비어 있다는 점 — DRY_RUN 테스트를 지우면서 `post()` 경로의 회귀 안전망도 같이 사라졌다.

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 2 |
| MEDIUM | 3 |
| LOW | 2 |

**Overall Grade**: B
**Milestone fit**: 정상 — “smoke + go-live” 재정의에 부합. parallel-run 잔재만 정리하면 M7 진입 OK.

## High Findings

### H1. Social `post()` HTTP path 커버리지 실종
- **Severity**: HIGH
- **Category**: Test gap / regression risk
- **File**: `tests/social/{twitter,facebook,threads,linkedin,youtube}.test.ts`
- **Issue**: 삭제된 `dryRun` 케이스가 사실상 `post()` 진입과 응답 형태(success/postUrl)를 검증하던 유일한 단위 테스트였다. 지금 남은 social 테스트는 전부 `validateContent()`만 호출하며 (`tiktok.test.ts`만 예외, `imageUrl` 없을 때 빠른-실패 1건), `client.post()`가 실제로 올바른 URL/method/body/OAuth 헤더를 만드는지 검증하는 테스트가 0건이다. `tests/skills/social-publish.test.ts` 도 `executePost`(실제 호출 경로)는 건드리지 않고 `dispatch` approval 생성만 본다.
- **Impact**: 누군가 OAuth 1.0a signature base string 인코딩이나 `v2Request` URL을 깨도 CI 그린. 다음 사람이 social 클라이언트를 손대면 prod 첫 호출에서 무성한 실패.
- **Recommended fix**: `fetch`를 mock해서 각 client.post() 한 케이스씩 추가. 예 (twitter):
  ```typescript
  it("posts via v2 /tweets with OAuth header", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "123" } }), { status: 200 }),
    );
    const result = await new TwitterClient(config).post({ text: "hi" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.twitter.com/2/tweets",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^OAuth /),
        }),
      }),
    );
    expect(result).toMatchObject({ success: true, postId: "123" });
  });
  ```

### H2. `doctor.ts` 가 여전히 M7 parallel-run 경고를 내보낸다
- **Severity**: HIGH
- **Category**: Doc consistency / user-facing
- **File**: `src/cli/doctor.ts:93,100,131,209`
- **Issue**: 4건 모두 “during M7 parallel run, do NOT re-run /login” 메시지/주석. 사용자가 `adaria-ai doctor` 돌리면 존재하지 않는 parallel-run 모드를 신경쓰라고 안내한다. `checkClaudeAuthRecency()`는 그래도 가치가 있지만(24h 내 auth 변경 자체는 유의미), 메시지 문구를 일반화해야 한다.
- **Impact**: 신규 사용자 혼란. M7 cleanup 의도와 직접 모순.
- **Recommended fix**:
  ```typescript
  // line 93
  : "Run 'claude /login' to authenticate.",
  // lines 99-101 + 131
  // 주석/문구에서 "M7 parallel run" 제거. 메시지 예:
  `WARNING: ~/.claude/${newestFile} modified ${ago} min ago — recent auth change may invalidate the running daemon session.`
  // line 209 주석:
  // 2b. Claude auth recency (warns if ~/.claude was touched recently)
  ```

## Medium Findings

### M1. `src/brands/generator.ts:261-262` JSDoc 잔재
- **Severity**: MEDIUM
- **Category**: Dead doc
- **File**: `src/brands/generator.ts:261`
- **Issue**: `BrandGenerateResult` 타입에서 `dryRun` 필드는 제거됐는데 JSDoc은 “In dry-run mode, returns a synthesized profile with `dryRun: true` and writes nothing”라고 거짓말 중. 코드와 doc 불일치.
- **Recommended fix**: 두 줄 삭제하고 `Returns the profile and the resolved file path.`로 끝.

### M2. `tests/skills/brand.test.ts:126` mock 객체에 `dryRun: false` 잔재
- **Severity**: MEDIUM
- **Category**: Test cleanliness
- **Issue**: `runGenerate` mock 반환에 `dryRun: false`가 남아 있다. `BrandGenerateResult`엔 더 이상 필드가 없으므로 excess property — vi.fn 추론 덕에 컴파일은 통과하지만 stale signal.
- **Recommended fix**: 한 줄 삭제.

### M3. parallel-run 언급이 docs 5곳에 남음
- **Severity**: MEDIUM
- **Category**: Doc consistency
- **Files**:
  - `docs/guide/SETUP.md:76,107,110` — “For side-by-side testing (e.g., M7 parallel run)” 섹션 + warning
  - `docs/guide/PORTING-LOG.md:49,53` — “M7 — Parity + parallel run”
  - `docs/growth-agent/folder-structure.md:283` — “two instances side-by-side during M7 parallel run”
  - `docs/growth-agent/prd.md:61` — decision row 5는 갱신됐지만 본문 “Safe cutover. Parallel run during M7…”은 그대로
  - `docs/growth-agent/open-questions.md:216` — `ADARIA_HOME` 설명에 “used by M7 parallel run”
  - `.claude/agents/senior-code-reviewer.md:160` — 검토 체크리스트에 parallel run 참조
- **Impact**: 문서 신뢰도 저하. M8 go-live 직전 사용자/에이전트가 잘못된 운영 절차를 학습.
- **Recommended fix**: 위 6개 문구 중 “parallel run” 단어를 “M7 smoke” 또는 단순 “re-auth caution” 으로 일반화. open-questions.md는 “used to isolate state during M7 smoke runs”.

## Low Findings

### L1. `docs/growth-agent/checklist.md:485` 는 무관
- **Severity**: LOW
- **Issue**: M9 smoke test의 `claude /login` step (정당한 신규 머신 setup) — 여기는 그대로 두는 게 맞다. 단지 grep 결과로 잡혔을 뿐.

### L2. `tiktok.test.ts` 의 한 `post()` 호출이 사실상 검증을 안 한다
- **Severity**: LOW
- **File**: `tests/social/tiktok.test.ts:13-18`
- **Issue**: `post({text:"No image"})` 가 “image required” 가드에서 즉시 반환되므로 실제 fetch path는 안 탄다. H1 fix 시 함께 보강.

## Two-mode routing integrity

변경 없음. `core.ts` 는 DRY_RUN 가드만 빠졌고 Mode A/B/C 라우팅은 동일.

## 검증 완료 항목

1. **Production 코드 (`src/`)에 `ADARIA_DRY_RUN`/`isDryRun`/`dryRunResult` 잔재 없음.** (M1 JSDoc 1건만 잔존 — 위 M1.)
2. **Approval gate 가 유일한 write 장벽인지**: 확인. `seo-blog.ts` `publishApprovedPosts`, 모든 `src/social/*.ts` `post()`/`deletePost()`, `social-publish.ts` `executePost`, `core.ts` `onApprovalResolved` 모두 DRY_RUN 분기 제거 후에도 “Skill produces ApprovalItem → core.sendApproval → approver click → onApprovalResolved → executePost” 라인이 깨지지 않음. 비-approval 경로에서 직접 `client.post()` 를 부르는 위치는 0곳 (grep `\.post\(` 으로 social-publish.ts L140 외 production caller 없음).
3. **DRY_RUN 을 “안전망”으로 의존한 fixture 없음**: 삭제된 테스트는 모두 “DRY_RUN=1 일 때 success=true & dryRun=true 반환” 형태였고, 실제 endpoint를 치지 않는 안전 fixture는 아니었음 (그래서 H1 처럼 그냥 비어버린 것).
4. **launchd plists / prompts / package.json scripts 깨끗**: grep 결과 0건.

## Action Items

- [ ] H1: 6개 social client `post()`에 fetch-mock 단위 테스트 추가 (각 1~2건)
- [ ] H2: `src/cli/doctor.ts` 4지점 “M7 parallel run” 문구 제거/일반화
- [ ] M1: `src/brands/generator.ts:261-262` JSDoc 정리
- [ ] M2: `tests/skills/brand.test.ts:126` `dryRun: false` 제거
- [ ] M3: docs 6곳 parallel-run 문구 일반화 (SETUP.md / PORTING-LOG.md / folder-structure.md / prd.md / open-questions.md / senior-code-reviewer.md)
- [ ] L2: H1 작업 시 tiktok.test의 빈 post 케이스도 함께 보강
