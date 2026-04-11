# Code Review: M1c — Security & Config Port

**Date**: 2026-04-12
**Scope**: `src/config/{schema,keychain,store}.ts`, `src/security/{auth,prompt-guard}.ts`, `src/messenger/adapter.ts`, related tests
**Status**: pre-commit review

## Summary

M1c 포트는 pilot-ai의 personal-agent 표면을 깔끔하게 제거했고 zod 스키마·키체인·YAML 영속화의 골격은 의도대로 동작한다. 다만 **파일 퍼미션 강제 경로에 2건의 실제 회귀 버그**가 있고(`fs.mkdir`/`fs.writeFile`의 `mode`가 기존 경로에 적용되지 않음), `IncomingMessage.eventTs`를 required로 박아둔 것이 M1d·M1e의 synthetic-message 경로를 어색하게 만든다.

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 3 |
| MEDIUM | 3 |
| LOW | 3 |
| INFO | 2 |

**Overall Grade**: B+ (수정 후 A-)
**Milestone fit**: ✅ — skill/agent/MCP/cli 코드 유입 없음.

---

## HIGH Findings

### H1. `ensureAdariaDir` — 기존 디렉토리 퍼미션을 0700으로 강제하지 않음

- **File**: `src/config/store.ts:23-28`
- **Issue**: `fs.mkdir(path, { recursive: true, mode: 0o700 })`는 디렉토리가 이미 존재하면 mode 인자를 조용히 무시한다. 사용자가 이전 툴이나 수동으로 `~/.adaria`를 0755로 만들어 둔 상태면 설정 로드 후에도 world-readable 그대로.
- **Impact**: `data/adaria.db`, `audit.jsonl`에 들어가는 감사 로그·PII 노출 가능성. 0700 계약 위반.
- **Fix**: `fs.chmod(dir, 0o700)`를 `mkdir` 뒤에 명시적으로 추가 + 회귀 테스트 ("pre-existing 0755 dir gets tightened").

### H2. `saveConfig` — 기존 파일의 mode를 0600으로 강제하지 않음

- **File**: `src/config/store.ts:109-115`
- **Issue**: `fs.writeFile(path, content, { mode: 0o600 })`는 파일이 이미 존재하면 mode 인자를 무시한다 (플랫폼 의존적). 사용자가 처음 `adaria-ai init`을 잘못된 umask로 돌려 0644로 생성됐다면 자동 tightening 안 됨.
- **Impact**: 평문 Slack 봇 토큰 / API 키 노출 가능성 (키체인 미사용 유저).
- **Fix**: `fs.writeFile` 뒤에 `fs.chmod(CONFIG_PATH, 0o600)` 추가 + 회귀 테스트.

### H3. `IncomingMessage.eventTs`를 required로 둔 것이 synthetic-message 경로 차단

- **File**: `src/messenger/adapter.ts:27`
- **Issue**: growth-agent Phase 1 교훈("Date로 round-trip 하지 말 것")은 타당하지만, required 필드로 박은 결과:
  - 승인 버튼 클릭 재주입, cron 주도 synthetic 메시지, approval-callback re-injection 등에 fake ts를 발명해야 함.
  - 인터페이스가 거짓말을 함.
- **Impact**: M1d/M1e에서 빈 문자열 주입 + try/catch 회피책 등장.
- **Fix**: `eventTs?: string` + JSDoc에 "Slack-originated 메시지에만 존재" 명시. 사용부에서 `if (msg.eventTs)` 가드.

---

## MEDIUM Findings

### M1. `loadRawConfig`가 `ensureAdariaDir` 호출 안 함

- **File**: `src/config/store.ts:93-102`
- **Issue**: `loadConfig`는 호출하지만 `loadRawConfig`는 안 함. `adaria-ai init`이 existing config 업데이트할 때 `$ADARIA_HOME` 자체가 없으면 raw ENOENT. `ConfigError` 래핑도 안 됨.
- **Fix**: `ensureAdariaDir()` + `readFile` 실패 `ConfigError` 래핑.

### M2. `resolveKeychainSecrets` 캐싱 없음 (데몬 hot path)

- **File**: `src/config/store.ts:66-87`
- **Issue**: 데몬 startup 1회는 OK지만 M6 cron shot마다 최대 4× `security` CLI fork. 누적 시 눈에 띔.
- **Fix**: 지금은 TODO(M6) 주석만 남기고 이슈 발생 시점에 캐시 레이어 추가.

### M3. `auth.ts`의 `platform !== "slack"` 가드는 dead code

- **File**: `src/security/auth.ts:14`
- **Issue**: `IncomingMessage.platform`이 리터럴 `"slack"`이라 타입 레벨에서 항상 false. 미래 Telegram 추가 시 이 줄이 "조용히 차단" 버그가 됨.
- **Fix**: 제거. 다른 플랫폼 추가 시 allowlist를 platform별로 쪼개라는 TODO 주석 추가.

---

## LOW Findings

### L1. `store.test.ts` — `as never` 캐스트 불필요

- **File**: `tests/config/store.test.ts:89`
- **Issue**: `saveConfig` 시그니처가 이미 `Record<string, unknown>` 허용. `as never`는 불필요.
- **Fix**: `as Record<string, unknown>`으로 교체 + 에러 메시지 정확한 매칭.

### L2. 테스트 간 `ADARIA_HOME` 환경변수 오염 가능성

- **File**: `tests/config/store.test.ts:10`, `tests/utils/logger.test.ts:12`
- **Issue**: 두 파일 모두 top-level env 덮어쓰기 + dynamic import. vitest 기본 file-level isolation에서는 안전하지만 브리틀.
- **Fix**: M1c 스코프 밖. 근본 해결은 `paths.ts`의 const → getter 함수 전환. 당장은 주석으로 전제 명시.

### L3. `wrapMemory` 제거 시 TODO 마커 없음

- **File**: `src/security/prompt-guard.ts`
- **Fix**: 파일 상단에 의도적 생략 주석 추가.

---

## INFO

### I1. `auditLog.path` 스키마 드롭은 좋은 결정
`paths.ts`의 `AUDIT_PATH` 고정 → 0700 보장과 일관성 향상.

### I2. YAML 로더 안전성 확인 완료
`js-yaml@4.1.1`의 `yaml.load()`는 v3 `safeLoad`와 동치. 악의적 config 파일을 통한 RCE/프로토타입 오염 경로 없음. Zod 재검증으로 이중 방어.

---

## Positive Observations

- Keychain sentinel 해석 경로가 store.ts에만 집중 → 관심사 분리 깔끔
- `ConfigError`의 `userMessage`에 실행 가능한 다음 단계(`adaria-ai init`) 포함
- `execFile` (not shell) 사용 → shell-metacharacter 주입 불가
- `structuredClone`으로 deep clone 후 sentinel 치환 → 원본 불변
- 테스트가 0700/0600 mode 비트까지 검증 (대부분 프로젝트가 빠뜨리는 부분)
- `safeParse`의 issues를 사람이 읽을 수 있는 형태로 렌더링
- 밀스톤 스코프 규율 엄수

---

## Action Items

- [ ] H1: `ensureAdariaDir` + `fs.chmod` + 회귀 테스트
- [ ] H2: `saveConfig` + `fs.chmod` + 회귀 테스트
- [ ] H3: `eventTs`를 optional로 + JSDoc
- [ ] M1: `loadRawConfig` + `ensureAdariaDir` + `ConfigError` 래핑
- [ ] M2: `resolveKeychainSecrets` TODO(M6) 주석
- [ ] M3: `auth.ts` dead guard 제거 + TODO
- [ ] L1: `as Record<string, unknown>` 교체
- [ ] L3: `prompt-guard.ts` 주석
