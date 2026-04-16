# Code Review: M7-cleanup round 2 (verify after-fix)

**Date**: 2026-04-16
**Scope**: Re-verification of round-1 fixes + sweep for stragglers
**Milestone**: M7
**Commit(s)**: uncommitted working tree (40 files, +175/-1014)

## Summary

라운드 1의 4개 픽스(H2/M1/M2/M3)는 모두 정상 적용. Build/lint 클린, 686/686 그린.
다만 doc 정리에서 잡혀야 했을 stale 참조 2건이 누락됨 — `docs/growth-agent/porting-matrix.md:142` 와 `README.md:133`.

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH     | 0 |
| MEDIUM   | 2 |
| LOW      | 1 |
| INFO     | 2 |

**Overall Grade**: A−
**Milestone fit**: 정상. M7-cleanup 정의에 부합.

## Verified fixes (round 1)

- **H2 doctor.ts** — 4지점(line 93/100/131/209) 모두 “M7 parallel run / shared auth with growth-agent” 제거됨. 재확인 OK.
- **M1 generator.ts JSDoc** — `dryRun: true` 언급 제거, BrandSkill PREVIEW + cleanup 설명으로 대체. `BrandGenerateResult` 타입에서도 `dryRun` 필드 삭제, `isDryRun()` 헬퍼 제거.
- **M2 brand.test.ts** — `dryRun: false` 잔재 제거, `originalDryRun`/env restore 블록도 정리.
- **M3 docs (5/6)** — SETUP.md, PORTING-LOG.md, folder-structure.md, prd.md, open-questions.md, senior-code-reviewer.md 모두 일반화. line 160 의도적으로 보존(사용자 지시).

## Findings

### M1. `docs/growth-agent/porting-matrix.md:142` — generator 설명에 `ADARIA_DRY_RUN=1 short-circuit` 잔존
- **Severity**: MEDIUM
- **Category**: Doc/code drift
- **File**: `docs/growth-agent/porting-matrix.md:142`
- **Issue**: porting-matrix가 generator를 “Type dispatch → collect → sanitise → Claude → YAML; `ADARIA_DRY_RUN=1` short-circuit” 로 기술. M7-cleanup에서 short-circuit 제거됨.
- **Recommended fix**: 해당 절을 `Type dispatch → collect → sanitise → Claude → YAML; PREVIEW gate in BrandSkill, no dry-run`로 교체.

### M2. `README.md:133` — 삭제된 `npm run smoke:social:dev` 광고
- **Severity**: MEDIUM
- **Category**: Public-facing doc / dead command
- **File**: `README.md:133`
- **Issue**: README의 “Dev Profile” 섹션이 `npm run smoke:social:dev` 실행을 안내하지만, 이번 cleanup에서 `package.json` 의 `smoke:social`/`smoke:social:dev`/`snapshot:briefing*` 4개 스크립트 + `scripts/smoke-social.ts` + `scripts/snapshot-briefing.ts` 가 모두 삭제됨. 신규 사용자가 그대로 따라 하면 `npm ERR! Missing script: "smoke:social:dev"` 발생.
- **Recommended fix**: 해당 한 줄 삭제. 필요하면 `npm run smoke:collectors:dev` 만 남기고, social smoke는 “covered by unit tests” 한 문장으로 대체.

### L1. `docs/growth-agent/checklist.md:363` — 과거 시점 진술이지만 오해 소지
- **Severity**: LOW
- **Category**: Doc framing
- **File**: `docs/growth-agent/checklist.md:363`
- **Issue**: Phase 2 항목이 “Claude-driven generator with `ADARIA_DRY_RUN` short-circuit (commit `7e65111`)” 로 적혀 있다. 시점 표현(commit-at-time)으로 읽으면 정확하지만 현재 상태로 오해될 수 있음.
- **Recommended fix**: 끝에 `(short-circuit later removed in M7-cleanup, see line 197)` 한 줄 추가 또는 line 197(이미 그렇게 적혀 있음)로 cross-reference만 끼워두면 충분.

### INFO 1. HIGH 1 (social `post()` HTTP coverage) 재평가
- **Severity**: 변경 없음 — **HIGH** 유지가 맞다 (CRITICAL 으로 escalation 불필요, MEDIUM 으로 demote 도 안 됨).
- **이유**:
  - **CRITICAL 아님**: 모든 `post()` 호출은 `safety.ts` ApprovalManager 게이트를 통과해야만 실행되며, allowlisted 사용자의 명시적 클릭이 단일 안전망이다. 게이트 자체에는 별도 unit test가 있고, M6.5 review 에서 `core.ts` 의 approval wiring 검증이 끝났다. 즉 “coverage 가 비어 있다” 가 곧 “prod 가 깨진다” 로 직결되지 않는다.
  - **MEDIUM 아님**: 6개 플랫폼의 fetch path 가 한 번도 통합 테스트로 호출된 적이 없다 — auth header 형태, 멀티파트 경계, 401/429 핸들링 등 회귀가 silent하게 발생할 수 있음. Approval 가 통과해도 첫 실 사용자가 “400” 받는 시나리오는 운영상 큰 비용. 그래서 LOW도 아니다.
  - **HIGH가 적절**: M7 “go-live” 직전이고, write path 인 점, 외부 의존성이 큰 점을 종합. 60–100 LOC fetch-mock 테스트 추가는 ROI 높음. 사용자 결정 대기 사항으로 명시 보존.

### INFO 2. 기타 sweep 결과
- `parallel run` / `growth-agent` / `ADARIA_DRY_RUN` / `dryRun` 전체 검색 — 위 M1/M2/L1 외에는 다음만 잔존:
  - `src/skills/*.ts`, `src/db/queries.ts`, `src/messenger/*.ts`, `src/security/auth.ts`, `src/types/collectors.ts`, `src/utils/retry.ts`, `src/agent/safety.ts`, `src/orchestrator/*.ts`, `src/config/apps-schema.ts`, `tests/messenger/slack.test.ts` — 모두 “Ported from growth-agent …” 형식 **역사적 attribution JSDoc**. 잔존이 정상.
  - `docs/code-reviews/**` — 과거 리뷰 문서. 역사 기록이므로 손대지 않음.
  - `docs/brand-profile/PRD.md:309–311`, `docs/brand-profile/CHECKLIST.md:132–134` — 의도적 “removed in M7-cleanup” 설명. 그대로 둠 (오히려 가치 있음).
  - `.claude/agents/senior-code-reviewer.md:160` — 사용자 지시로 보존.
  - `launchd/`, `prompts/`, `apps.example.yaml` — 잔존 없음.

## Build / lint / test

- `npm run build` — clean
- `npm run lint` — clean
- `npm test` — 68 files / **686 passed**, duration 1.58s

## Action items

- [ ] M1 — `docs/growth-agent/porting-matrix.md:142` generator 설명에서 `ADARIA_DRY_RUN=1 short-circuit` 제거
- [ ] M2 — `README.md:133` `npm run smoke:social:dev` 줄 삭제 (또는 “covered by unit tests” 로 대체)
- [ ] L1 — `docs/growth-agent/checklist.md:363` 에 line 197 cross-ref 추가 (선택)
- [ ] HIGH 1 (deferred) — 6개 social `post()` fetch-mock 테스트 ~60–100 LOC. M7 go-live 전 권장, 사용자 결정 사항.
