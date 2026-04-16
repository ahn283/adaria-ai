# Code Review: M7 Cleanup — Round 3 (HIGH 1 resolution)

**Date**: 2026-04-16
**Scope**: 6 social platform fetch-mock test additions, 3 doc stragglers
**Milestone**: M7 (post-M6.5 cleanup, parallel-run scaffolding removal)
**Commit(s)**: uncommitted working tree (round 3 of 3)

## Summary

HIGH 1 (social `post()` coverage) is **resolved**. The 6 new fetch-mock tests are not shallow — they assert endpoint URL, HTTP method, auth header shape (OAuth signature for Twitter, `appsecret_proof` HMAC for Facebook, `LinkedIn-Version` + `X-Restli-Protocol-Version` for LinkedIn, Bearer for YouTube/TikTok/Threads), and body field semantics that match the real implementations. Three doc stragglers also fixed. No new findings.

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 0 |
| LOW | 1 |
| INFO | 1 |

**Overall Grade**: A
**Milestone fit**: deliverable closes the round-2 outstanding HIGH; scope is correct.

## Findings

### LOW 1 — `JSON.parse(String(...body))` is brittle if body becomes async iterable
- **Category**: Test robustness
- **Files**: `tests/social/twitter.test.ts:73`, `tests/social/youtube.test.ts:38`, `tests/social/tiktok.test.ts:46`, `tests/social/linkedin.test.ts:64`
- **이슈**: `JSON.parse(String((init as RequestInit).body))` 패턴은 현재 모든 클라이언트가 `JSON.stringify` 결과를 그대로 넣기 때문에 동작하지만, 향후 누군가 body를 `Readable` 스트림으로 바꾸면 `String(stream)` → `"[object Object]"` → 파싱 실패로 테스트가 죽는다 (테스트 의도와 다른 형태로). `body instanceof URLSearchParams ? ... : JSON.parse(body as string)` 분기 또는 헬퍼 함수로 추출하면 안전.
- **Impact**: 테스트가 깨질 때 원인이 한 단계 더 멀어짐. 지금은 무해.
- **권장**: 후속 PR에서 `parseFetchBody(init)` 헬퍼 도입 시 처리.

### INFO 1 — file-level `eslint-disable` 정당함
- **Category**: Code quality
- **이슈**: `no-unsafe-assignment` 및 `no-base-to-string` 비활성화는 mock destructuring 패턴(`fetchMock.mock.calls[0]!`)과 `URLSearchParams` body inspection (`String(init.body)`)에 typed-rules가 잘 안 맞기 때문. 테스트 파일 한정이고, per-test `as unknown as ...` cast 반복보다 가독성이 좋음. 합리적 trade-off.
- **권장**: 그대로 유지.

## Verification of round-2 outstanding items

- **HIGH 1 (social `post()` coverage)** — **RESOLVED**.
  - Twitter: OAuth header (`oauth_consumer_key="test-key"`), `/2/tweets` URL, JSON body, postId 추출, 429 실패 케이스.
  - Facebook: 2-step page-token 흐름, `appsecret_proof` HMAC 64-char hex 검증, `/me/accounts` 빈 응답 시 "Page ... not found in managed pages" 에러 매칭 (src/social/facebook.ts:170 throw와 일치).
  - Threads: container-create → publish 2-step, `creation_id` 연결, 400 시 "Container creation failed" 에러 매칭 (src/social/threads.ts:62).
  - TikTok: `/post/publish/inbox/video/init/`, `PULL_FROM_URL` source, photo_images 배열, Bearer auth.
  - YouTube: Data API v3 `activities?part=snippet,contentDetails`, `bulletin` type, channelId, 403 실패.
  - LinkedIn: `/rest/posts`, `LinkedIn-Version: \d{6}`, `X-Restli-Protocol-Version: 2.0.0`, `urn:li:organization:` author, postId를 `x-linkedin-id` response header에서 추출하는 비자명한 동작까지 검증, 403 실패.
  - 6개 모두 실제 클라이언트 구현(엔드포인트 URL · 헤더 키 · body 필드명)과 일치. URL 오타, 헤더 누락, body 필드 rename 같은 silent regression은 모두 잡힘.

- **README.md:133** (round-2 straggler) — 확인됨, `npm run smoke:social:dev` 광고 라인 삭제됨.
- **porting-matrix.md:142** (round-2 straggler) — 확인됨, generator 설명 재작성.
- **checklist.md:181** — `scripts/snapshot-briefing.ts` 라인에 strikethrough 적용.

## Cross-cutting verification

- **DRY_RUN refs in src/**: `grep -r "ADARIA_DRY_RUN\|isDryRun\|dryRunResult" src/` → 0 matches. 완전히 제거됨.
- **Doc DRY_RUN/parallel-run refs**: `docs/code-reviews/*.md`(역사적), `docs/growth-agent/*.md`(M7 runbook), `CLAUDE.md`(M7 parallel-run runbook section)에 남아있음. 모두 의도된 역사적/계획 문서. 코드는 깨끗.
- **Test count**: `npm test` → 68 files, 697 passed (round-2 686에서 +11). 일치.
- **lint/build**: 변경 영역에 새로운 회귀 없음.

## Two-mode routing integrity

해당 없음 (이번 라운드는 social client + 문서만 변경).

## Approval flow integrity

해당 없음. 단, social write 경로의 `ADARIA_DRY_RUN` 분기 전체 제거는 round 2에서 이미 검토 완료. 이번 라운드는 그 결정을 테스트로 확정하는 단계.

## Positive Observations

- Twitter `oauth_consumer_key="test-key"` 부분 문자열 검증으로 OAuth 1.0a 헤더가 단순 형식이 아닌 실제 키 기반으로 만들어졌음을 보장.
- Facebook 테스트가 `appsecret_proof`를 64-char hex regex로 검증 — HMAC-SHA256 결과 길이/문자셋이 깨질 경우 즉시 잡힘.
- LinkedIn postId가 response body가 아닌 `x-linkedin-id` 헤더에서 나온다는 비자명한 API 동작을 테스트가 명시적으로 커버.
- Threads · Facebook · LinkedIn · Twitter · YouTube 모두 happy + 실패 페어로 작성. TikTok은 happy만이지만 `requires image/video for posting` 검증이 별도 존재해 실패 경로 커버는 충분.
- `vi.unstubAllGlobals()` cleanup이 모든 파일의 `afterEach`에 들어있어 fetch mock leak 위험 없음.

## Action Items

- [ ] (선택) 후속 PR에서 `parseFetchBody(init)` 헬퍼 도입 검토 (LOW 1).
- [ ] M7 cleanup 전체를 단일 commit으로 묶거나 round별로 분리하여 conventional commit 메시지 작성.
- [ ] M7 종료 처리: `docs/growth-agent/checklist.md` progress tracker에서 M7 완료 마킹.
