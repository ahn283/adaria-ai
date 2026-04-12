# Code Review: M2 finisher v2 -- env var smoke -> config loader + prod/dev profile + tarball hardening

**Date**: 2026-04-12
**Scope**: `src/config/schema.ts`, `src/config/store.ts`, `src/config/apps-schema.ts` (new), `src/config/load-apps.ts` (new), `src/config/keychain.ts`, `src/cli/init.ts`, `scripts/smoke-collectors.ts`, `scripts/check-tarball-secrets.ts` (new), `apps.example.yaml` (new), `package.json`, `.gitignore`, `README.md`, tests x6 files
**Milestone**: M2 (collector port) -- finisher 단계, M3 (DB/config) 경계 코드 일부 선행 포함
**Commit(s)**: uncommitted working tree (20113f7 이후)

## Summary

env var 기반 smoke script를 `loadConfig()` + `loadApps()` 정석 경로로 성공적으로 승격했다. `deriveServicePrefix`를 통한 prod/dev Keychain 네임스페이스 분리, `check-tarball-secrets` pre-publish 가드, `KEYCHAIN_KEYS` 중앙 상수 맵은 모두 프로덕션 품질의 설계다. 전체 360 테스트 통과, typecheck/lint 클린. CRITICAL 없음. HIGH 2건은 아키텍처 일관성 + 보안 방어 강화 관련.

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 2 |
| MEDIUM | 5 |
| LOW | 3 |
| INFO | 3 |

**Overall Grade**: A-
**Milestone fit**: 코드 자체는 M2 범위(collector + config integration) + M9 사전 준비(tarball scanner) 혼합. `load-apps.ts`와 `apps-schema.ts`는 milestones.md에서 M3으로 분류한 항목인데, M2 smoke script의 정석화를 위해 앞당긴 것은 타당한 선제 이동(scope creep이라기보다 dependency pull-forward). `check-tarball-secrets`는 M9 항목이지만, 이 시점에 넣는 것이 npm publish 하드닝을 커밋 0부터 보장하므로 합리적.

## Critical & High Findings

### H1. `package.json` `files` 필드에 `src/` 포함 -- tarball에 소스코드 전체 동봉
- **Severity**: HIGH
- **Category**: npm package shape / M9 compliance
- **File**: `package.json:12`
- **Issue**: `files` 배열에 `"src/"` 가 포함되어 있다. M0 bootstrap 때부터 존재한 문제이지만, 이 커밋이 `check-tarball-secrets` 스캐너를 도입하고 `README.md`에 "5중 방어" 를 문서화하면서 `files` 필드를 건드렸으므로 이 시점에 수정해야 한다.
- **Impact**: (1) tarball 크기 2x (소스+빌드 모두 포함). (2) `src/cli/init.ts`의 validation 문자열 리터럴(e.g. `"xoxb-"`, `"BEGIN PRIVATE KEY"`)이 tarball에 그대로 들어감 -- `check-tarball-secrets`가 이를 잡을 수 없는 이유는 리터럴이 룰 패턴의 최소 길이를 충족하지 않기 때문이지만, 코드 내 주석이나 테스트 파일에 실수로 긴 더미 키가 들어가면 스캐너가 걸릴 수 있다. (3) milestones.md M0 exit criteria: `"files: ["dist/", "prompts/", "launchd/"]"` -- `src/` 는 명시적으로 목록에 없다. (4) CLAUDE.md도 `"files field ships only dist/, prompts/, launchd/, README.md, LICENSE"` 라고 명시.
- **Current code**:
  ```json
  "files": [
    "dist/",
    "src/",
    "prompts/",
    "launchd/",
    "apps.example.yaml",
    "README.md",
    "LICENSE"
  ]
  ```
- **Recommended fix**:
  ```json
  "files": [
    "dist/",
    "prompts/",
    "launchd/",
    "apps.example.yaml",
    "README.md",
    "LICENSE"
  ]
  ```
- **Note**: `apps.example.yaml` 추가는 이 커밋의 의도된 변경이므로 유지. `src/`만 제거.

### H2. `init.ts`에서 `APPS_PATH` 대신 `CONFIG_PATH.replace(...)` 로 apps.yaml 경로 파생
- **Severity**: HIGH
- **Category**: Architecture / DRY / fragility
- **File**: `src/cli/init.ts:382`
- **Issue**: `CONFIG_PATH.replace(/config\.yaml$/, "apps.yaml")` 로 apps.yaml 경로를 파생하고 있다. 동일 모듈(`src/utils/paths.ts`)에 이미 `APPS_PATH` 상수가 정의되어 있고, `load-apps.ts`는 이를 사용한다. regex 기반 파생은 `CONFIG_PATH`의 형태가 바뀌면(예: 향후 XDG 호환을 위해 config.yml 등으로 변경) 조용히 깨진다.
- **Impact**: 사용자에게 잘못된 경로가 출력될 수 있고, init와 load-apps 사이의 경로 불일치는 디버깅이 어렵다.
- **Current code**:
  ```typescript
  console.log(
    "\nNext: copy `apps.example.yaml` from the repo root to\n" +
      `${CONFIG_PATH.replace(/config\.yaml$/, "apps.yaml")} and\n` +
      "edit it with your app portfolio."
  );
  ```
- **Recommended fix**:
  ```typescript
  import { APPS_PATH, CONFIG_PATH } from "../utils/paths.js";
  // ...
  console.log(
    "\nNext: copy `apps.example.yaml` from the repo root to\n" +
      `${APPS_PATH} and\n` +
      "edit it with your app portfolio."
  );
  ```

## Medium & Low Findings

### M1. `store.ts`의 `yaml.load(content)` -- `JSON_SCHEMA` 미적용
- **Severity**: MEDIUM
- **Category**: Security consistency
- **File**: `src/config/store.ts:55`
- **Issue**: `load-apps.ts`는 `yaml.load(raw, { schema: yaml.JSON_SCHEMA })`를 사용하여 YAML 특수 타입(`!!binary`, `!!timestamp`)을 배제하는데, `store.ts`는 `yaml.load(content)` (DEFAULT_SCHEMA)를 사용한다. 이 코드는 이 커밋 이전부터 존재했으나, 이 커밋이 `load-apps.ts`에서 올바른 패턴을 확립했으므로 동일 패턴으로 통일해야 한다.
- **Impact**: 악의적 YAML 타입 태그로 zod 검증 전에 예상치 못한 타입이 생성될 수 있다(js-yaml v4에서 코드 실행은 불가하지만, `!!timestamp`가 Date 객체를 생성하면 `z.string()` 검증에서 거부되어 cryptic한 에러 메시지 발생).
- **Recommended fix**: `store.ts:55` 와 `loadRawConfig` (store.ts:168) 모두에 `{ schema: yaml.JSON_SCHEMA }` 옵션 추가.
  ```typescript
  raw = yaml.load(content, { schema: yaml.JSON_SCHEMA });
  ```

### M2. `KEYCHAIN_KEYS` 상수가 `schema.ts`에 위치 -- 레이어링 불일치
- **Severity**: MEDIUM
- **Category**: Architecture / separation of concerns
- **File**: `src/config/schema.ts:163-174`
- **Issue**: `KEYCHAIN_KEYS`는 macOS Keychain의 슬롯 이름 매핑이다. `schema.ts`의 책임은 "config.yaml의 데이터 형태 정의" 이고, Keychain은 "시크릿 저장 백엔드" 다. 이 상수는 `keychain.ts`에 있거나, 별도의 `src/config/secret-slots.ts`에 있는 것이 레이어링에 맞다. 현재 위치 때문에 `init.ts`가 `schema.ts`에서 Keychain 관련 상수를 import하는 어색한 의존 방향이 생긴다.
- **Impact**: 기능에는 문제 없으나, M4+ 에서 skill별 시크릿이 추가될 때 `schema.ts`가 비대해지는 경로로 진입한다.
- **Recommended fix**: drift 방지라는 원래 목적은 유지하되 `src/config/keychain.ts` 또는 별도 `src/config/secret-slots.ts`로 이동. `schema.ts`, `store.ts`, `init.ts` 모두의 import 경로만 바꾸면 됨. M3 진입 전 수행 권장, 지금 당장은 아니어도 됨.

### M3. `check-tarball-secrets.ts`의 `walk()` -- symlink 미처리
- **Severity**: MEDIUM
- **Category**: Security / defense-in-depth
- **File**: `scripts/check-tarball-secrets.ts:81-94`
- **Issue**: `walk()` 함수는 `entry.isDirectory()` / `entry.isFile()` 만 체크하고 `entry.isSymbolicLink()`를 처리하지 않는다. npm tarball에 symlink가 포함되는 것은 극히 드물지만, 악의적으로 포함된다면 스캐너가 symlink된 파일을 스킵한다. `readdirSync({ withFileTypes: true })` 는 `entry.isSymbolicLink()` 를 구분하며, symlink의 target을 `fs.stat`으로 follow 하지 않으면 해당 항목은 dir도 file도 아닌 상태로 조용히 무시된다.
- **Impact**: 현실적 exploit 가능성은 낮지만, 보안 스캐너의 누락은 원칙적으로 수정되어야 한다.
- **Recommended fix**:
  ```typescript
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // Follow symlinks: stat() resolves them, unlike lstat()
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue; // dangling symlink
      }
      if (stat.isDirectory()) {
        out.push(...walk(full));
      } else if (stat.isFile()) {
        if (!BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          out.push(full);
        }
      }
    }
    return out;
  }
  ```

### M4. `init.ts` 293 LOC -- 단일 파일 커질 때 분할 기준
- **Severity**: MEDIUM
- **Category**: Maintainability
- **File**: `src/cli/init.ts`
- **Issue**: 137 -> 293 LOC. `askSlack`, `askEnable`, `askAppStore`, ... `askArdenTts`, `askCollectors`, `runInit` 총 11개 함수가 한 파일에 있다. 현재 단일 책임("init wizard entry point")으로 응집도는 유지되나, M3+에서 `askApps()` (apps.yaml 인터랙티브 생성) 같은 wizard step이 추가되면 400+ LOC로 성장할 가능성이 높다.
- **Impact**: 지금은 문제 없으나, 성장 경로가 예측됨.
- **Recommended fix**: 현재 상태로 유지 OK. 다만 다음 기준을 코멘트로 남겨둘 것: `// Split into src/cli/init/*.ts when this file exceeds ~350 LOC or when apps.yaml wizard is added (M3+).` 실제 분할은 필요해질 때(YAGNI).

### M5. `prepublishOnly` 체인에서 `check:tarball-secrets`가 `npm pack`을 재실행
- **Severity**: MEDIUM
- **Category**: Performance
- **File**: `package.json:33`, `scripts/check-tarball-secrets.ts:96-112`
- **Issue**: `npm publish` 는 내부적으로 `npm pack` 을 호출하여 tarball을 생성한 후 업로드한다. `prepublishOnly` 의 마지막 단계인 `check:tarball-secrets` 도 `npm pack --silent` 를 별도로 호출하므로 빌드 산출물이 두 번 패키징된다. 현재 프로젝트 크기(~242 파일)에서는 무시할 수준이지만, M9에서 `prompts/` 디렉토리가 커지면 체감 가능해질 수 있다.
- **Impact**: publish 시간이 약간 늘어남 (현재 상태에서는 무시 가능).
- **Recommended fix**: 지금은 수정 불필요. M9에서 publish 시간이 문제되면, `npm pack --json` 출력에서 tarball 경로를 잡아 스캐너에 전달하는 wrapper script로 전환. 혹은 `prepublish` 대신 `.github/workflows/release.yml` CI step으로 분리.

### L1. `deriveServicePrefix` 의 trailing hyphen in slugified names
- **Severity**: LOW
- **Category**: UX / cosmetic
- **File**: `src/config/keychain.ts:27-37`
- **Issue**: `"My Adaria Test!"` -> slug `"my-adaria-test-"` -> prefix `"adaria-ai-my-adaria-test-"`. trailing hyphen는 Keychain 기능에 영향 없지만 `adaria-ai doctor` 출력이나 Keychain Access.app에서 이상해 보인다.
- **Current code**: `basename.replace(/^\.+/, "").replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()`
- **Recommended fix**: trailing hyphen 제거 추가:
  ```typescript
  const slug = basename
    .replace(/^\.+/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+$/, "")    // trim trailing hyphens
    .toLowerCase();
  ```
- **Test update**: `tests/config/keychain.test.ts:46` -- 기대값 `"adaria-ai-my-adaria-test-"` -> `"adaria-ai-my-adaria-test"`.

### L2. `keychain.ts` `serviceKey()` vs `paths.ts` -- ADARIA_HOME 읽기 시점 불일치
- **Severity**: LOW
- **Category**: Architecture / subtle divergence
- **File**: `src/config/keychain.ts:44-46` vs `src/utils/paths.ts:12-13`
- **Issue**: `paths.ts`의 `ADARIA_HOME`은 모듈 로드 시점에 `process.env["ADARIA_HOME"]`을 읽고 `const`로 고정한다. 반면 `keychain.ts`의 `serviceKey()`는 매 호출마다 `deriveServicePrefix()` -> `process.env["ADARIA_HOME"]`을 동적으로 읽는다. 단일 프로세스 내에서 env var가 바뀌는 시나리오는 거의 없으나, test에서 `process.env["ADARIA_HOME"]`을 바꿀 때 paths.ts는 원래 값을, keychain.ts는 새 값을 읽어 불일치가 발생할 수 있다.
- **Impact**: production에서는 문제 없음. 테스트에서 `store.test.ts` 처럼 `process.env["ADARIA_HOME"]`을 설정하고 dynamic import하는 패턴으로 우회하고 있으므로 실질적 버그 아님.
- **Recommended fix**: 없음 (현재 상태 OK). 향후 `paths.ts`를 함수형으로 바꿀 때 (`getAdariaHome()`) 통일 가능.

### L3. `check-tarball-secrets.ts`의 OpenAI 패턴이 일부 Anthropic 키 형식과 오버랩
- **Severity**: LOW
- **Category**: False positive potential
- **File**: `scripts/check-tarball-secrets.ts:49-51`
- **Issue**: OpenAI 패턴 `/sk-[A-Za-z0-9]{32,}/`는 `sk-` 접두어 뒤에 alphanumeric만 있으면 매치한다. 실제 Anthropic 키(`sk-ant-api03-…`)는 hyphen/underscore를 포함하므로 매치되지 않지만, 테스트 fixture에서 `sk-` 로 시작하는 32자 이상의 순수 alphanumeric 더미 키를 쓰면 false positive가 발생한다. 스캐너가 publish를 blocking하므로 false positive는 사용자에게 혼란을 줄 수 있다.
- **Impact**: 실질적으로 낮음. 현재 테스트 fixture에 이런 키가 없음.
- **Recommended fix**: 없음 (false positive = 안전 방향). 향후 문제 발생 시 `sk-(?!ant)[A-Za-z0-9]{32,}` 로 Anthropic 키를 제외하는 negative lookahead 추가.

## Data Flow Issues

### smoke-collectors.ts의 config -> collector 경로 검증

`smoke-collectors.ts` 의 데이터 플로우를 end-to-end 추적한 결과:

```
loadConfig() -> resolveKeychainSecrets() -> AdariaConfig
loadApps()   -> zod validation -> AppConfig[]
                       |
                       v
smokeAppStore(config, app) -> config.collectors.appStore? -> app.appStoreId? -> new AppStoreCollector(cfg)
```

각 smoke 함수는 config 블록 null 체크 + app 필드 null 체크를 **모두** 하고 있으며, skip 메시지가 어느 쪽이 비어있는지 명시한다. 이 패턴은 M4+ 스킬에서도 동일하게 재사용 가능하므로 좋은 선례.

### init.ts -> keychain -> store.ts 경로 검증

```
init.ts: askAppStore() -> setSecret(KEYCHAIN_KEYS.appStorePrivateKey, value)
                       -> configSchema.parse({ collectors: { appStore: { privateKey: KEYCHAIN_SENTINEL } } })
                       -> saveConfig(candidate)

store.ts: loadConfig() -> configSchema.safeParse(raw)
                       -> resolveKeychainSecrets()
                          -> if (collectors.appStore?.privateKey === KEYCHAIN_SENTINEL)
                             -> resolveSecretField(KEYCHAIN_KEYS.appStorePrivateKey)
                                -> getSecret("collector-appstore-private-key")
```

`KEYCHAIN_KEYS` 상수가 init (write) 와 store (read) 양쪽에서 동일 슬롯 이름을 참조하므로 drift 방지가 구조적으로 보장됨. 이것은 의도된 설계이며 잘 작동한다.

### 미검증 경로: ardenTts.endpoint 의 3중 검증 (질문에 대한 답변)

사용자가 "3중 URL 검증이 과한가" 를 물었다. 답: 과하지 않다.

1. **schema.ts** (`.url()`) -- `config.yaml` 로드 시 구조적 검증. 파일을 직접 편집한 경우 커버.
2. **init.ts** (`new URL()` + 프로토콜 체크) -- wizard 입력 시 즉각 피드백. 사용자가 `ftp://...` 를 넣으면 바로 거부.
3. **collector constructor** (`new URL()` + 프로토콜 체크) -- defense-in-depth. config가 programmatic하게 생성되거나 keychain에서 corrupt 값이 올 경우 마지막 방어선.

각각 다른 진입 경로를 커버하므로 중복이 아닌 깊이 방어.

## Positive Observations

1. **`KEYCHAIN_KEYS` 중앙 상수**: init/store 간 sloth name drift를 구조적으로 방지. 이전 growth-agent에서 문자열 리터럴이 양쪽에 흩어져 있던 문제를 확실히 해결.

2. **`collectorsConfigSchema` 전체 optional + `.default({})`**: 사용자가 collector를 점진적으로 활성화할 수 있는 설계. zod의 `.default({})`가 YAML에 `collectors:` 키가 아예 없는 경우도 깔끔하게 처리.

3. **`load-apps.ts`의 `JSON_SCHEMA` 사용**: `yaml.load`에 `json_schema`를 명시적으로 전달하여 YAML 특수 타입 공격면을 제거. 이 패턴은 `store.ts`에도 전파해야 하지만 (M1 참고), `load-apps.ts` 에서 올바른 선례를 세움.

4. **`check-tarball-secrets` 의 PEM body 요구**: `-----BEGIN PRIVATE KEY-----` 리터럴 문자열(init.ts validation message 등)이 false positive를 트리거하지 않도록 base64 body 40자 이상을 요구하는 설계. 실전적.

5. **`deriveServicePrefix` 의 테스트 가능성**: 함수를 순수 함수(`adariaHome?` parameter)로 설계하여 macOS Keychain을 건드리지 않고도 7개 엣지 케이스를 검증. 테스트 설계의 좋은 예.

6. **smoke script의 skip 메시지 구체성**: `"config.yaml.collectors.appStore not set"` vs `"apps.yaml[fridgify].appStoreId not set"` -- 어느 쪽이 비어있는지 즉시 파악 가능. 디버깅 시간 절약.

7. **`CollectorsDraft` 중간 타입**: init.ts에서 config 객체를 조립할 때 시크릿 필드를 `typeof KEYCHAIN_SENTINEL` 로 고정. 실수로 평문 시크릿이 YAML에 쓰이는 것을 타입 수준에서 방지.

8. **`.gitignore` 하드닝**: `/config.yaml`, `/apps.yaml`, `.adaria-*/` -- repo root에 실수 commit 차단. `!/apps.example.yaml` 예외. 실전적.

## Action Items

- [ ] **HIGH**: `package.json` `files`에서 `"src/"` 제거 (`package.json:12`)
- [ ] **HIGH**: `init.ts:382`의 `CONFIG_PATH.replace(...)` -> `APPS_PATH` import 사용
- [ ] **MEDIUM**: `store.ts:55` + `store.ts:168`에 `{ schema: yaml.JSON_SCHEMA }` 추가 (M1 기존 코드 수정)
- [ ] **MEDIUM**: `check-tarball-secrets.ts` `walk()` 에 symlink follow 추가
- [ ] **LOW**: `keychain.ts` slug 파생에 trailing hyphen trim 추가
- [ ] **MEDIUM (defer to M3)**: `KEYCHAIN_KEYS`를 `keychain.ts` 또는 별도 파일로 이동 검토
- [ ] **MEDIUM (defer to growth)**: `init.ts` 350 LOC 기준 도달 시 `src/cli/init/` 디렉토리 분할
