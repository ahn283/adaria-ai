# Code Review: M0 Bootstrap

**Date**: 2026-04-12
**Reviewer**: Senior Code Review Agent
**Scope**: `.gitignore`, `.npmignore`, `package.json`, `tsconfig.json`, `eslint.config.js`, `src/index.ts`, `src/utils/paths.ts`
**Commit(s)**: working tree (pre-commit)

## Summary

M0 부트스트랩은 목표(컴파일 가능한 TS 프로젝트 + npm 퍼블리시 가능 형태)를 안정적으로 달성했다. `paths.ts`의 `import.meta.url` 기반 경로 해석은 정확하며 M9 smoke test를 통과할 구조다. 다만 (1) 실수로 퍼블리시되는 것을 막는 가드가 없고, (2) `files` 배열이 존재하지 않는 디렉토리/파일을 참조해 M2·M9에서 "소리 없는 누락"이 발생할 수 있는 두 가지 구조적 리스크가 있다.

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 2 |
| Medium | 2 |
| Low | 3 |
| Info | 2 |

## Critical & High Priority Findings

### 1. `private: true` / `publishConfig` 가드 부재로 인한 오발행 리스크
- **Severity**: HIGH
- **Category**: Project-Specific Compliance
- **File**: `package.json:1-59`
- **Issue**: M0~M8은 모두 퍼블리시 전 단계이며 M9에서 처음으로 npm에 공개된다. 그러나 `package.json`에 `"private": true`도, `"publishConfig": { "access": "public" }`도 없다. 이 상태에서 `npm publish`가 실수로 실행되면 `0.0.1`이 전체 2KB짜리 빈 껍데기로 선점된다. npm은 같은 버전의 재퍼블리시를 허용하지 않으므로, 이후 M9에서 `0.0.1`을 정상 버전으로 올릴 수 없게 된다.
- **Impact**: 치명적 인시던트 1건으로 M9 전체가 막힐 수 있음. `prepublishOnly`가 `build && lint && test`만 검증하지 퍼블리시 자체는 막지 않는다.
- **Recommendation**:
```json
{
  "name": "adaria-ai",
  "version": "0.0.1",
  "private": true,
  "//": "M9에서 퍼블리시 직전 private를 제거하고 publishConfig.access=public 으로 교체"
}
```
M9 체크리스트에 "remove `private: true`" 를 명시적으로 추가하면 이중 가드가 된다.

### 2. `files` 배열이 존재하지 않는 항목을 참조 — 조용한 누락 위험
- **Severity**: HIGH
- **Category**: Project-Specific Compliance / 패키징
- **File**: `package.json:9-15`
- **Issue**: `"files": ["dist/", "prompts/", "launchd/", "README.md", "LICENSE"]` 에서 `prompts/`, `launchd/`, `README.md`, `LICENSE` 네 개 모두 현재 리포지토리에 존재하지 않는다. npm은 `files`에 적힌 존재하지 않는 경로를 **경고 없이** 조용히 건너뛴다 (실측: `npm pack --dry-run`이 `dist/` + `package.json`만 9개 파일로 생성, 경고 0개).
- **Impact**:
  - M2에서 `prompts/` 를 처음 추가할 때 누군가 `mkdir`을 잊거나 파일만 만들고 커밋에서 제외하면, 빌드·린트·테스트가 모두 통과한 채 **프롬프트가 없는 타르볼**이 퍼블리시될 수 있다. 런타임에서 `BUNDLED_PROMPTS_DIR` 을 읽을 때 `ENOENT`로 터지는데, 이는 M9 두 번째 맥 smoke test에서만 재현될 가능성이 크다.
  - `launchd/` 도 동일 문제.
  - `README.md` 없이 퍼블리시된 npm 패키지는 페이지가 매우 흉함 (치명적 아님).
- **Recommendation**:
  1. 즉시: `prompts/.gitkeep`, `launchd/.gitkeep` 빈 디렉토리 커밋. `prompts/` 는 `files` 가 디렉토리 통째로 포함하므로 `.gitkeep`을 제외해야 한다면 패턴을 `prompts/**/*.md` 같은 형태로 좁히는 것도 방법.
  2. M2·M3 PR에서 `npm pack --dry-run | grep prompts/` 가 0건이면 CI가 실패하도록 체크 추가.
  3. `README.md` 와 `LICENSE` 는 M0 시점에 만드는 것이 정석 — 최소한의 README(1 문단)와 MIT LICENSE 파일은 지금 넣는 것을 권장. CLAUDE.md 가 `license: "MIT"` 로 선언했으므로 LICENSE 파일 부재는 법적으로도 약간 애매함.

## Medium Priority Findings

### 3. sourcemap이 퍼블리시되지 않는 `src/` 를 참조
- **Severity**: MEDIUM
- **Category**: Code Quality / 패키징
- **File**: `tsconfig.json:21-22`, `dist/utils/paths.js.map`
- **Issue**: `sourceMap: true`, `declarationMap: true` 가 켜져 있어 `dist/utils/paths.js.map` 안에 `"sources": ["../../src/utils/paths.ts"]` 가 박힌다. 그러나 `.npmignore` 와 `files` 모두 `src/` 를 제외하므로, 퍼블리시된 타르볼에는 소스가 없다. 소비자(= 본인) 디버거는 `paths.ts` 원본을 못 찾는다.
- **Impact**: M1 ~ M9 동안 `adaria-ai`를 전역 설치해 돌릴 때 스택트레이스가 소스 라인이 아닌 빌드된 JS 라인을 가리킴. 디버깅 품질 저하이나 치명적이지 않음.
- **Recommendation**: 둘 중 하나.
  - (권장, 사이즈 작음) `files`에 `"src/"` 추가 — 퍼블리시 2KB → 약 3KB 증가, 디버그 경험 개선.
  - 또는 `tsconfig`에서 `sourceMap: false`, `declarationMap: false` 로 전환. 디버깅 포기 대신 타르볼 최소화. M1에서 런타임을 임포트하기 시작하면 sourcemap이 실제로 유용해지므로 전자를 권장.

### 4. 루트 tsconfig에서 `tests/` 제외 — 향후 vitest 타입 커버리지 구멍
- **Severity**: MEDIUM
- **Category**: Testing
- **File**: `tsconfig.json:26`
- **Issue**: `"exclude": ["node_modules", "dist", "tests"]`. 아직 `tests/` 디렉토리가 없으므로 현재는 무해하지만, M1 이후 테스트를 추가하기 시작하면 이 제외 규칙 때문에 `tsc --noEmit` 이 테스트 파일의 타입 오류를 놓친다. vitest 자체는 esbuild를 쓰므로 "돌아는 간다" → 타입 안전성 침식.
- **Impact**: 런타임 사일런트 실패가 아닌 타입 안전성만 부분 저하. M1 들어가기 전에 수정 권장.
- **Recommendation**: M1 초입에 `tsconfig.build.json` (빌드용, `tests/` 제외) 과 `tsconfig.json` (타입체크용, `tests/` 포함) 로 분리. 현재는 그대로 두되 해당 컨벤션을 `milestones.md`에 메모해두면 충분.

## Low Priority Findings

### 5. `dist/index.js` 가 644 권한 — `node dist/index.js` 는 되지만 직접 실행 불가
- **Severity**: LOW
- **Category**: Code Quality
- **File**: `dist/index.js`
- **Issue**: tsc 빌드 결과물은 기본적으로 644다. 셔뱅은 살아남았지만 실행 비트가 없어 `./dist/index.js --version` 은 Permission denied. 현재 검증은 `node dist/index.js --version` 으로 하므로 통과. npm 글로벌 설치 시에는 npm이 `bin` 항목을 심링크하며 실행권을 부여하므로 M9는 영향 없음.
- **Impact**: 개발 중 직접 실행 경로만 약간 불편. M9 블로커 아님.
- **Recommendation**: `package.json` 에 `scripts.build: "tsc && chmod +x dist/index.js"` 로 변경하면 로컬 테스트 경험이 일관된다. 또는 무시해도 됨.

### 6. `.npmignore` 와 `files` 의 중복 — 의도 문서화 부재
- **Severity**: LOW
- **Category**: Code Quality
- **File**: `.npmignore`, `package.json:9-15`
- **Issue**: `files` 필드가 있으면 npm은 `.npmignore`/`.gitignore`를 거의 무시하고 `files` 화이트리스트만 본다. 즉 `.npmignore` 는 현재 실질적으로 dead code. 시크릿 유출 방어 관점에서 belt-and-suspenders 의도로 남겼다면 OK지만, 장래에 누군가 `files`에 `src/`를 추가하는 순간 `.npmignore` 의 `src/` 가 뒤늦게 살아나 헷갈린다.
- **Impact**: 혼동 가능성. 시크릿 유출 갭은 없음 (`files` 가 명시적 화이트리스트이므로 `.env`, `apps.yaml`, `config.yaml` 은 절대 포함되지 않는다).
- **Recommendation**: `.npmignore` 상단에 주석 한 줄 추가.
```
# belt-and-suspenders: package.json `files` is the source of truth.
# This file only defends against someone adding a broad entry to `files`.
```

### 7. ESLint가 type-aware 린트 미사용
- **Severity**: LOW
- **Category**: Code Quality
- **File**: `eslint.config.js:11-28`
- **Issue**: `parserOptions.project` 미설정으로 `@typescript-eslint/no-floating-promises`, `no-misused-promises` 같은 type-aware 룰이 동작하지 않는다. M1에서 `core.ts` 를 포팅하기 시작하면 floating promise가 즉시 문제 된다.
- **Recommendation**: M1 초입에 `parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname }` 및 `tseslint.configs.recommendedTypeChecked` 로 교체. M0 scope 밖이므로 지금은 flag만.

## Info

### 8. `paths.ts` packageRoot 계산 검증 완료
- `dist/utils/paths.js` 에서 `path.dirname(thisFile)` → `<install>/dist/utils`, `..`, `..` → `<install>` (= package root). 정확함.
- `BUNDLED_PROMPTS_DIR`, `BUNDLED_LAUNCHD_DIR`, `PACKAGE_JSON_PATH` 모두 `<install>/prompts`, `<install>/launchd`, `<install>/package.json` 으로 올바르게 해석된다. `npm install -g adaria-ai` 후 `/usr/local/lib/node_modules/adaria-ai/` 레이아웃에서 그대로 동작 (npm 글로벌 설치는 타르볼을 그대로 푸는 구조이므로 `dist/` 와 `prompts/` 의 상대관계가 보존된다).
- `ADARIA_HOME` 환경변수 오버라이드는 `noUncheckedIndexedAccess` 스트릭트 하에서도 정상 (`process.env["ADARIA_HOME"] ?? path.join(os.homedir(), ".adaria")`).
- `process.cwd()` 사용 0건 (grep 확인). CLAUDE.md 의 "M9 smoke test 블로커" 조건 충족.

### 9. 마일스톤 스코프 준수
- M0 스코프 외(skills, collectors, MCP, Slack, claude agent 등)는 단 한 줄도 유입되지 않았다. `src/index.ts` 는 순수 commander `--version` 프린터. 의도적 minimalism이 잘 지켜짐.

## Positive Observations

- **Strict mode 전면 활성화**: `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noImplicitReturns` + `noFallthroughCasesInSwitch` + `noUnusedLocals/Parameters`. 이 조합은 M1 이후 포팅하는 pilot-ai 코드가 은근슬쩍 `any`를 끌고 들어오는 것을 원천 차단한다. 부트스트랩 단계에서 이 결정을 내린 것은 아키텍처적으로 가장 높은 가치의 선택.
- **ESM + NodeNext + `.js` 확장자**: `type: "module"`, `module/moduleResolution: "NodeNext"`, `src/index.ts` 의 `from "./utils/paths.js"` 까지 전부 일관됨. NodeNext는 향후 `better-sqlite3` (CJS) 인터롭에서도 문제없음.
- **`paths.ts` 가 `import.meta.url` 로 설계됨**: CLAUDE.md 의 "M9 블로커 조건"을 M0에서 선제적으로 해결. 이후 M1~M8에서 경로 관련 실수가 들어와도 `paths.ts` 만 보면 되는 단일 진실 소스가 확보됨.
- **Shebang tsc 통과**: `dist/index.js` 의 첫 줄이 `#!/usr/bin/env node` 로 살아있음 (실측). TS 6.0의 non-statement 구문 보존이 정상 작동.
- **`prepublishOnly` 게이트**: `build && lint && test` 가 퍼블리시 직전 강제됨.
- **보안 관점**: `files` 화이트리스트 방식으로 `.env`, `apps.yaml`, `config.yaml`, `sessions.json`, `audit.jsonl` 등이 구조적으로 퍼블리시 불가능. `.gitignore` 에 `.adaria/` 포함으로 런타임 상태가 git에도 새지 않음. 이중 방어 견고.
- **최소 의존성**: runtime deps 5개(@slack/bolt, better-sqlite3, commander, inquirer, js-yaml)로 M1~M9에서 필요한 것만 사전 설치. 사용하지 않는 패키지 0.

## Action Items Checklist

- [ ] (HIGH) `package.json` 에 `"private": true` 추가, M9 체크리스트에 "remove private before publish" 명시
- [ ] (HIGH) `prompts/.gitkeep`, `launchd/.gitkeep` 생성해 `files` 배열의 조용한 누락 차단
- [ ] (HIGH) `README.md` 최소 1문단, `LICENSE` (MIT) 파일 추가 — CLAUDE.md `license` 선언과 정합
- [ ] (MEDIUM) `files` 에 `"src/"` 추가하거나 tsconfig `sourceMap`/`declarationMap` 끄기 중 택1
- [ ] (MEDIUM) M1 시작 시 type-aware ESLint 활성화 + `tsconfig` 를 `tsconfig.json` / `tsconfig.build.json` 로 분리
- [ ] (LOW) `scripts.build` 에 `&& chmod +x dist/index.js` 추가 (선택)
- [ ] (LOW) `.npmignore` 상단에 의도 주석 추가
