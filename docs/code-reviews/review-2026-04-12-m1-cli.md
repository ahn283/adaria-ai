# Code Review: M1 CLI 포트 + launchd 배선

**Date**: 2026-04-12
**Scope**: `launchd/com.adaria-ai.daemon.plist.template`, `src/cli/{daemon,start,stop,status,logs,init,doctor}.ts`, `src/index.ts`
**Milestone**: M1 (마지막 커밋 — 이 변경이 랜딩되면 `@adaria-ai 안녕`이 launchd 경유로 실제 Claude 응답을 돌려줄 수 있어야 함)
**Commit(s)**: uncommitted working tree

## Summary

전반적으로 M1 종료 조건을 충족하는 알찬 포트다. 번들 에셋 경로는 `import.meta.url` 기반으로 올바르게 해석되며, `launchd` 플리스트 템플릿과 CLI 명령어 8개가 깔끔하게 짜여 있고, end-to-end 데이터 흐름(`daemon` → `loadConfig` → `createMessengerAdapter` → `AgentCore.start`)에 명백한 배선 결함은 없다. 다만 **launchd 크래시 루프**와 **Homebrew Node 업그레이드 시 플리스트 결화**라는 두 가지 운영 리스크, 그리고 `init.ts`의 기존 config 처리가 깨진 YAML에 대해 빠져나갈 길을 막아 두는 UX 버그가 있어 실제 M9 첫 smoke-test 전에 정리할 필요가 있다.

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 2 |
| MEDIUM | 5 |
| LOW | 6 |
| INFO | 3 |

**Overall Grade**: B+
**Milestone fit**: 범위 일치 — M1 범위를 정확히 커버하며, M6 훅(주간/모니터 플리스트, `doctor` 확장)에 대한 `TODO`/주석이 적절히 달려 있어 스코프 크리프 없음.

## Critical & High Findings

### H1. 설정 누락 시 launchd 크래시 루프 (`ThrottleInterval=30` + `KeepAlive=true`)
- **Severity**: HIGH
- **Category**: Failure mode / Operational stability
- **File**: `src/cli/daemon.ts:17-23`, `launchd/com.adaria-ai.daemon.plist.template:38-48`
- **Issue**: `runDaemon()`의 첫 줄이 `loadConfig()`인데 `~/.adaria/config.yaml`이 사라지거나 YAML 파싱이 깨지면 `ConfigError`가 던져져 `program.parseAsync().catch()`가 `console.error` + `process.exit(1)`로 끝난다. launchd는 `KeepAlive=true` + `ThrottleInterval=30`이라 **30초마다 무한 재시작**하면서 `daemon.err.log`를 꾸준히 불린다. 하루면 ~2,880라인, M7 병행 주간 기간 동안 손 안 대면 수십 MB까지 간다.
- **Impact**: 사용자가 `ADARIA_HOME` 경로를 옮기거나 config.yaml을 잘못 수정한 뒤 `adaria-ai stop`을 잊으면, 로그가 쌓이고, 더 나쁜 것은 `launchctl list`의 lastExitStatus가 계속 1로 깜빡여서 실제 사용 중에 일어난 다른 crash 신호를 가린다. M1 `doctor`도 이 상태를 바로 감지하지 못한다(`loadConfig`는 성공해도 daemon 프로세스가 따로 돌고 있으니).
- **Current code**:
  ```typescript
  // src/cli/daemon.ts
  export async function runDaemon(): Promise<void> {
    const config = await loadConfig();          // throws ConfigError
    const messenger = createMessengerAdapter(config);
    const agent = new AgentCore(messenger, config);
    await agent.start();
    ...
  }
  ```
- **Recommended fix**: `daemon.ts`에서 `ConfigError`를 명시적으로 캐치하고, launchd가 재시작하지 않도록 **SuccessfulExit 종료 코드** 또는 **exponential backoff**를 적용한다. macOS launchd의 `SuccessfulExit=true` 키는 "종료 코드 0일 때만 재시작"이므로, 설정 오류는 exit 0으로 마크하고 콘솔/로그에 이유를 남기는 편이 사용자 경험이 낫다. 또는 `plist`에서 `SuccessfulExit=true`를 추가해 "정상 종료는 재시작 안 함"으로 바꾼 뒤 config 에러는 `process.exit(0)`으로 내려 보낸다.

  ```typescript
  // src/cli/daemon.ts
  import { ConfigError } from "../utils/errors.js";

  export async function runDaemon(): Promise<void> {
    let config;
    try {
      config = await loadConfig();
    } catch (err) {
      if (err instanceof ConfigError) {
        logError(
          `adaria-ai daemon cannot start: ${err.userMessage ?? err.message}`,
        );
        // Exit 0 + plist SuccessfulExit=true ⇒ launchd will not respawn.
        // The operator fixes config.yaml and runs `adaria-ai start` again.
        process.exit(0);
      }
      throw err;
    }
    ...
  }
  ```

  그리고 `launchd/com.adaria-ai.daemon.plist.template`에:
  ```xml
  <key>KeepAlive</key>
  <dict>
      <key>SuccessfulExit</key>
      <false/>
      <key>Crashed</key>
      <true/>
  </dict>
  ```
  로 전환하면, "설정 실패로 일부러 0으로 나감 → 재시작 안 함", "segfault/uncaught throw → 재시작함"이라는 훨씬 안전한 실패 모드를 얻는다.

### H2. `init.ts`가 깨진 YAML을 만나면 자기 자신을 복구할 수 없음
- **Severity**: HIGH
- **Category**: UX / Failure recovery
- **File**: `src/cli/init.ts:39-48`
- **Issue**: `adaria-ai init`은 사용자가 **설정을 고치러** 부르는 명령어다. 그런데 기존 config.yaml이 YAML 파싱 오류(탭/공백 섞임, 손으로 수정하다 중괄호 하나 누락 등)를 유발하면 `loadRawConfig()`가 `ConfigError`를 던지고 프로세스가 `exit 1`로 죽는다. 사용자는 `adaria-ai init`으로는 절대 탈출할 수 없고, 직접 `rm ~/.adaria/config.yaml`을 수동으로 실행해야만 한다. 게다가 읽어 온 값은 현재 어느 프롬프트에도 **주입되지 않는다**(`void existing;`). 즉, 로드 시도 자체가 순수한 부작용 — **쓸모없는 실패 경로**가 추가된 것과 같다.
- **Impact**: 첫 실패 → 사용자가 Slack에서 도움 요청 → 디버깅 기록이 늘어난다. 이는 `adaria-ai`가 "single-user, local-first, 친숙한 재설치"를 목표로 하는 M9 smoke-test 경로와 정면으로 충돌한다.
- **Current code**:
  ```typescript
  if (await configExists()) {
    const existing = await loadRawConfig();   // ⚠ throws on malformed YAML
    console.log(
      `Existing config found at ${CONFIG_PATH}. Values marked *** are already stored in the macOS Keychain.`,
    );
    console.log("Press Enter to keep a value unchanged.\n");
    void existing;                            // ⚠ dead weight
  }
  ```
- **Recommended fix**: `loadRawConfig`를 지우거나, 최소한 그 호출을 `try/catch`로 감싸서 "기존 config가 읽히지 않아 덮어씀"을 알려주기만 하면 된다. "Press Enter to keep unchanged" 안내는 거짓말(실제로 default를 주입하지 않음)이니 제거해야 한다.

  ```typescript
  if (await configExists()) {
    console.log(
      `Existing config found at ${CONFIG_PATH}. This will be overwritten. Secrets are re-read from the Keychain on next load.`,
    );
    // Optional: attempt a best-effort read of the old config for debugging,
    // but never let it abort the wizard — malformed YAML is the whole reason
    // the user is running init again.
    try {
      await loadRawConfig();
    } catch (err) {
      console.warn(
        `  (existing config failed to parse: ${err instanceof Error ? err.message : String(err)} — continuing with a fresh setup)`,
      );
    }
  } else {
    console.log(`Config will be written to ${CONFIG_PATH}.\n`);
  }
  ```

  M1 범위 내에서 기존 값으로 프롬프트 default를 시드하고 싶지 않다면(= 현재 결정), 정말로 호출을 지우는 편이 더 정직하다.

## Medium & Low Findings

### M1. `process.execPath`는 Node 업그레이드에 취약 (Homebrew/nvm 둘 다)
- **Severity**: MEDIUM
- **Category**: Bundled asset safety / M9 smoke test blocker candidate
- **File**: `src/cli/start.ts:57`
- **Issue**: Apple Silicon Homebrew에서 `process.execPath`는 `/opt/homebrew/Cellar/node/23.11.0/bin/node`처럼 **버전 픽스드 Cellar 경로**를 돌려준다. 사용자가 `brew upgrade node`를 실행하면 `23.11.0` 디렉터리는 사라지고 플리스트는 존재하지 않는 바이너리를 가리키게 된다. launchd는 daemon을 시작하려고 시도하다 실패 → 사용자가 `adaria-ai start`를 다시 실행해야만 복구된다. nvm(`~/.nvm/versions/node/v23.11.0/bin/node`) 역시 같은 문제. CLAUDE.md가 명시적으로 "M9 fresh-Mac install"을 smoke-test 차단기로 지목한 만큼 주의가 필요하다.
- **Impact**: 사용자가 Node 업그레이드 후 "Slack 멘션에 답이 없어"라며 디버깅에 빠지게 됨. `daemon.err.log`에 "no such file or directory" 에러가 찍히지만 사용자는 로그 파일을 잘 안 들여다본다.
- **Current code**:
  ```typescript
  return template
    .replaceAll("__NODE_BIN__", process.execPath)
    ...
  ```
- **Recommended fix**: `/opt/homebrew/bin/node`(symlink)가 존재하고 `fs.realpathSync`가 `process.execPath`와 같으면 **symlink 경로를 선호**한다. 이러면 Homebrew 업그레이드에도 플리스트가 살아남는다.

  ```typescript
  import fs from "node:fs";
  // ... inside renderPlist()
  function getStableNodeBinary(): string {
    const current = process.execPath;
    // Prefer /opt/homebrew/bin/node over Cellar real path so Homebrew
    // version upgrades don't invalidate the plist.
    const homebrewSymlink = "/opt/homebrew/bin/node";
    try {
      if (fs.realpathSync(homebrewSymlink) === current) {
        return homebrewSymlink;
      }
    } catch {
      // Not Homebrew / symlink missing — fall through.
    }
    // TODO(nvm): equivalent stable path doesn't exist for nvm; users must
    // re-run `adaria-ai start` after `nvm use <new version>`.
    return current;
  }
  ```
  동시에 `runStart()`의 성공 콘솔 출력에 "Node 또는 adaria-ai를 업그레이드한 뒤에는 `adaria-ai start`를 다시 실행해 주세요"라는 한 줄 안내를 추가한다.

### M2. `launchctl list` 파싱이 라벨 prefix 충돌에 취약
- **Severity**: MEDIUM
- **Category**: Status parsing correctness
- **File**: `src/cli/status.ts:17`
- **Issue**: `stdout.split("\n").find((l) => l.includes(label))`는 **어떤 라인이든** 라벨 문자열을 **포함**하면 매치된다. M6에서 `com.adaria-ai.daemon`, `com.adaria-ai.weekly`, `com.adaria-ai.monitor` 세 개가 공존할 때, 아무 라벨이 `com.adaria-ai.daemon`을 포함하는 더 긴 이름(예: `com.adaria-ai.daemon.backup`)을 가지면 엉뚱한 라인을 집어 올 수 있다. 또한 `PID\tStatus\tLabel` 포맷에서 Label이 맨 끝이므로 이를 엄격하게 매치하지 않으면 디버깅용 임시 라벨과 충돌한다.
- **Impact**: M1에선 라벨이 하나뿐이라 발현되지 않지만, M6 추가 시 잠재적 regression. 지금 고치면 cost 0.
- **Current code**:
  ```typescript
  const line = stdout.split("\n").find((l) => l.includes(label));
  ```
- **Recommended fix**: 필드가 정확히 `label`과 일치하는 라인을 찾는다.
  ```typescript
  const line = stdout.split("\n").find((l) => {
    const parts = l.trim().split(/\s+/);
    return parts[2] === label;
  });
  ```

### M3. `runStart()`가 daemon이 이미 로드됐을 때 플리스트를 **다시 렌더하지 않음**
- **Severity**: MEDIUM
- **Category**: Upgrade / dev flow
- **File**: `src/cli/start.ts:82-85`
- **Issue**: `adaria-ai start`를 다시 호출하면 "already loaded"라고 일찍 리턴한다. 그런데 개발 중에 `adaria-ai start`를 반복 호출하는 가장 흔한 이유는 (a) Node 업그레이드로 `__NODE_BIN__` 경로가 바뀜, (b) `__SCRIPT_PATH__`가 바뀔 정도로 dist 위치가 이동함 — 이 두 경우에 플리스트는 stale 상태로 남는다.
- **Impact**: 개발 플로우에서 "start가 재시작을 해 줄 것"이라는 직관을 깨뜨린다. 명시적으로 `stop && start`를 해야만 실제로 새 플리스트가 로드된다.
- **Recommended fix**: 이미 로드된 상태여도 플리스트 내용을 **다시 생성**하고 `launchctl kickstart`로 교체한다.
  ```typescript
  export async function runStart(): Promise<void> {
    if (!(await configExists())) { /* ... */ }

    await fs.mkdir(LOGS_DIR, { recursive: true, mode: 0o700 });
    await fs.mkdir(LAUNCH_AGENTS_DIR, { recursive: true });

    const plistContent = await renderPlist();
    const plistPath = getDaemonPlistPath();
    await fs.writeFile(plistPath, plistContent, { mode: 0o644 });

    if (await isDaemonLoaded()) {
      // Already loaded — unload + load so the updated plist takes effect.
      try {
        await execFileAsync("launchctl", ["unload", plistPath]);
      } catch { /* best-effort */ }
    }

    try {
      await execFileAsync("launchctl", ["load", plistPath]);
      console.log(`adaria-ai daemon loaded (${DAEMON_LABEL}).`);
      ...
    } catch (err) { /* ... */ }
  }
  ```
  혹은 더 가벼운 대안: 이미 로드된 경우 `"Daemon is already loaded. Use 'adaria-ai stop' first to apply plist changes."`라는 **더 명시적인** 안내만 내놓는다. 둘 중 어느 쪽이든 현재의 조용한 no-op은 함정이다.

### M4. `daemon.ts`의 shutdown에 하드 데드라인 없음
- **Severity**: MEDIUM
- **Category**: Graceful shutdown
- **File**: `src/cli/daemon.ts:25-44`
- **Issue**: SIGTERM → `agent.stop()` → `messenger.stop()` → Bolt `app.stop()`. Bolt가 Socket Mode WebSocket을 닫는 데 네트워크 이슈로 10초 이상 걸리면 launchd는 기본 5초 후 SIGKILL을 보낸다. 이 경우 이번 샷다운 중 쓰려던 **audit 로그 flush가 잘려 나가거나** (`agent_metrics` 같은 미래 테이블의 WAL 체크포인트가 밀릴 수 있음). 지금은 DB 쓰기 경로가 거의 없어 큰 문제는 아니지만 M4 skills가 쌓이면 발현한다.
- **Impact**: M1 단계에서는 이론적. M4+에서 재검토 대상.
- **Recommended fix**: 3초 데드라인 타이머 + hard exit.
  ```typescript
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo(`adaria-ai daemon received ${signal}, stopping...`);

    // Hard deadline: if agent.stop() hangs (e.g. Bolt socket refusing to
    // close), force-exit before launchd sends SIGKILL at 5s.
    const deadline = setTimeout(() => {
      logError("Shutdown exceeded 3s deadline — forcing exit");
      process.exit(1);
    }, 3_000);
    deadline.unref();

    agent
      .stop()
      .then(() => {
        clearTimeout(deadline);
        process.exit(0);
      })
      .catch((err: unknown) => {
        clearTimeout(deadline);
        logError(
          `Shutdown error: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      });
  };
  ```

### M5. `files` 필드가 `src/`를 포함 — npm 타르볼에 이중 포함
- **Severity**: MEDIUM
- **Category**: npm package shape (M9 관심사)
- **File**: `package.json:10-17`
- **Issue**: `package.json`의 `files`에 `"src/"`가 있다. CLAUDE.md가 명시적으로 "dist//prompts//launchd/만 ship"이라 써 두었고, `senior-code-reviewer` 시스템 프롬프트의 M9 체크 항목에도 `src/`는 **제외돼야** 한다고 적혀 있다. 현재 상태대로 `npm pack`하면 tarball에 `dist/` + `src/`가 둘 다 들어가 2배 가까운 용량이 나간다.
- **Impact**: 로딩 시간 증가, 디스크 낭비, 그리고 원본 TS 소스가 배포된다는 점에서 의도치 않은 **정보 노출**(주석, 개발자 메모). M9 smoke-test 단계에서 tarball 검사 시 차단 항목이다.
- **Current code**:
  ```json
  "files": [
    "dist/",
    "src/",
    "prompts/",
    "launchd/",
    "README.md",
    "LICENSE"
  ]
  ```
- **Recommended fix**: `src/`를 제거한다. source-map이 필요하면 `dist/**/*.js.map`은 이미 dist에 있으므로 문제 없다. declarationMap도 dist에 들어간다.
  ```json
  "files": [
    "dist/",
    "prompts/",
    "launchd/",
    "README.md",
    "LICENSE"
  ]
  ```
  (이 수정은 M1 체크리스트에는 없을 수 있지만 M9 전에 반드시 처리돼야 해서 지금 플래그한다. 제외해도 M1 `node dist/index.js`는 영향 없음.)

### L1. `init.ts`가 `inquirer.prompt`의 legacy API를 사용 — 13.x에서는 deprecated
- **Severity**: LOW
- **Category**: Forward compat
- **File**: `src/cli/init.ts:50`
- **Issue**: inquirer 13.x는 내부적으로 `@inquirer/prompts`의 함수형 API로 전환됐고, legacy `inquirer.prompt([...])`는 유지되지만 비권장이다. 각 prompt를 직접 import해서 쓰는 편이 더 타입 안전하고 shake-able하다. M1 기능 정상 동작엔 문제 없으나, 장기적으로 정리 가치 있음. `mask: '*'`는 `@inquirer/password`가 `mask?: boolean | string`를 받아서 legacy 경로로도 정상 forwarding된다는 점을 확인했다 — 즉 **현재 런타임 버그는 없다**.
- **Recommended fix** (optional, M1 스코프 밖):
  ```typescript
  import password from "@inquirer/password";
  import input from "@inquirer/input";

  const botToken = await password({
    message: "Slack bot token (xoxb-…):",
    mask: "*",
    validate: (v) => v.startsWith("xoxb-") || "Slack bot tokens start with 'xoxb-'",
  });
  // ...
  ```

### L2. `daemon.ts`의 thenable 체인이 async/await과 섞여 있음
- **Severity**: LOW
- **Category**: Code style
- **File**: `src/cli/daemon.ts:30-40`
- **Issue**: 같은 함수 안에서 `await agent.start()`를 쓰고, shutdown 핸들러 안에서는 `agent.stop().then(...).catch(...)` 체인으로 전환한다. signal 핸들러는 sync 콜백이어야 하니 어쩔 수 없는 선택이지만, 그렇다면 async IIFE로 감싸는 편이 읽기 편하다. 기능적 버그는 아님.
- **Recommended fix** (optional):
  ```typescript
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo(`adaria-ai daemon received ${signal}, stopping...`);
    void (async () => {
      try {
        await agent.stop();
        process.exit(0);
      } catch (err) {
        logError(
          `Shutdown error: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    })();
  };
  ```

### L3. `logs.ts`의 follow 모드가 SIGINT를 한 번만 처리함 — daemon과 겹치면 회수 leak
- **Severity**: LOW
- **Category**: Signal handler scope
- **File**: `src/cli/logs.ts:44-47`
- **Issue**: `process.on("SIGINT", ...)`로 등록된 리스너가 follow 모드 종료 시 removeListener 되지 않는다. 동일 프로세스 수명 안에서 `logs.ts`가 두 번 호출되지는 않으므로 실제 leak은 일어나지 않지만, 습관적으로 once handler로 두는 게 더 깔끔하다.
- **Recommended fix**:
  ```typescript
  if (options.follow) {
    console.log(`Following ${logPath} (Ctrl+C to stop):\n`);
    const child = spawn("tail", ["-f", logPath], { stdio: "inherit" });
    process.once("SIGINT", () => {
      child.kill();
      process.exit(0);
    });
    return;
  }
  ```

### L4. `status.ts`의 `-1` 엣지케이스는 발현하지 않지만 방어적 파싱이 약함
- **Severity**: LOW
- **Category**: Defensive parsing
- **File**: `src/cli/status.ts:24-26`
- **Issue**: launchctl은 PID로 음수를 내지 않지만, `parseInt("-1", 10)`은 -1을 반환해서 `running: pid !== null` 판정이 `true`가 된다. 현실적으로 발생하지 않는 케이스라 CR 플래그는 아니지만, 정상적으로 `Number.isInteger(pid) && pid > 0`로 방어하는 것이 향후 fork/port 시 안전하다.
- **Recommended fix**:
  ```typescript
  const pidParsed = pidStr === "-" || pidStr === undefined ? null : parseInt(pidStr, 10);
  const pid = pidParsed !== null && Number.isInteger(pidParsed) && pidParsed > 0 ? pidParsed : null;
  ```

### L5. `status.ts`의 JobStatus가 "loaded but not running"을 명확히 표현하지 못함
- **Severity**: LOW
- **Category**: Observability
- **File**: `src/cli/status.ts:38-54`
- **Issue**: M6의 weekly/monitor는 cron job이므로 평상시엔 `pid=-`이고 `lastExitStatus=0`이 정상. 현재 코드에선 `running: false, lastExitStatus: 0`으로 `"stopped (last exit 0)"`로 출력되는데, M6에 와서 이 UX를 "loaded (idle, last run ok)"로 구분하지 않으면 사용자가 "왜 daemon이 stop 상태지?"라고 오해한다. M1에서 고쳐 두면 M6가 편해진다.
- **Recommended fix**: 두 개의 필드를 분리.
  ```typescript
  export interface JobStatus {
    label: string;
    loaded: boolean;          // launchctl list 에 있는지
    running: boolean;         // 지금 PID가 살아 있는지
    pid: number | null;
    lastExitStatus: number | null;
  }
  ```
  그리고 `runStatus()`에서 `loaded && !running && lastExitStatus === 0` → `"idle (last run ok)"`로 출력한다.

### L6. `index.ts`의 dynamic import는 타이포를 M1 smoke test에서 못 잡을 수 있음
- **Severity**: LOW
- **Category**: DX
- **File**: `src/index.ts:27,38,46,54,62,71,79`
- **Issue**: 사용자가 적었듯 `await import("./cli/init.js")`는 commander action이 실제로 돌 때까지 해석되지 않으므로, 경로 오타나 `.js` 확장자 누락이 컴파일 단계가 아닌 **런타임**에 드러난다. M1에선 수동으로 각 서브커맨드를 한 번씩 돌려 보는 것이 현실적이지만, 테스트 가능한 smoke test가 있으면 좋다. 아래 grep 결과로 **모든 dynamic import 경로는 실제 파일과 일치**함을 확인했으므로 현재 버그는 없다.
- **Verification**: `src/cli/{init,daemon,start,stop,status,logs,doctor}.ts` 7개 모두 존재, tsc로 compile된 `dist/cli/*.js`도 존재.
- **Recommended fix** (optional smoke): `tests/index.test.ts`에서 각 subcommand를 `--help`로만 호출해서 동적 import가 throw하지 않는지 확인.

### L7. `init.ts`에서 `keychain.getSecret` 실패 시 빈 문자열 저장 후 doctor가 catch — 순서가 아슬아슬
- **Severity**: LOW
- **Category**: Security / UX
- **File**: `src/cli/init.ts:92-94` + `src/config/store.ts:84-93`
- **Issue**: `init`이 `setSecret`을 await 하지만 에러를 catch하지 않는다. Keychain에 실패하면(드물지만 프롬프트 차단 시 발생 가능) exception이 위로 올라가 `parseAsync().catch`에서 exit 1. 이 경우 YAML도 **아직 안 쓰여서** 사용자는 다시 `init`을 돌리면 된다 — 그래서 큰 문제는 아니지만, 사용자에게 친절하지 않은 오류 메시지가 나간다.
- **Recommended fix**: `setSecret` 호출을 개별 try/catch로 감싸 어느 키가 실패했는지 알려주고 재시도 권유.

## Data Flow Issues

end-to-end 트레이스(`@adaria-ai 안녕` → launchd → daemon → Claude 응답):

```
launchd `com.adaria-ai.daemon`
  → ProgramArguments: [process.execPath, dist/index.js, "daemon"]
  → dist/index.js parses "daemon" subcommand
    → await import("./cli/daemon.js")
    → runDaemon()
      → loadConfig()  ← [H1] throws if config missing → crash loop
        → ensureAdariaDir() (creates ~/.adaria + 0700 subdirs)
        → resolveKeychainSecrets() (security tool calls)
      → createMessengerAdapter(config)
        → new SlackAdapter({botToken, appToken, signingSecret})
      → new AgentCore(messenger, config)
        → creates ApprovalManager, McpManager (empty M1), placeholder SkillRegistry
        → setupHandlers() — wires messenger.onMessage → handleMessage
      → agent.start()
        → messenger.start() → Bolt App.start() → Socket Mode connect
      → register SIGTERM/SIGINT handlers → return
  → launchd keeps process alive via Bolt's WebSocket handle

Slack event path:
  → Bolt socket receives app_mention
  → SlackAdapter internal dedup + rate limiter
  → messageHandler(msg) → AgentCore.handleMessage
    → isAuthorizedUser check
    → writeAuditLog
    → sendText(channelId, "🤔 Thinking...")
    → findSkill("안녕") → null (not "aso", "review", etc.)
    → Mode B: invokeClaudeWithContext
      → invokeClaudeCli() with config.claude.cliBinary
      → result streamed back via onToolUse/onThinking
    → updateText(statusMsgId, response)
    → addReaction white_check_mark
    → writeAuditLog(result)
```

이 경로에 **명백한 배선 결함은 없다**. config 로드 → messenger 생성 → agent 생성 → start → Slack 이벤트 수신까지 깔끔하게 연결돼 있다. H1/H2를 제외하면 happy path는 동작한다.

## Two-mode routing integrity

`core.ts`는 이번 PR에서 수정되지 않았으므로 Mode A/B 분기 자체는 검토 범위 밖이지만, `daemon.ts`가 `new AgentCore(messenger, config)`를 호출할 때 옵션 두 번째 인자를 **비워 둔다**. 그 결과 `AgentCoreOptions.skillRegistry`가 기본값인 `createM1PlaceholderRegistry()`로 들어가 Mode A가 7개 placeholder skill로 plumbing된다. M4에서 `daemon.ts`가 실제 skill registry를 주입하도록 옵션 인자를 채울 자리가 이미 있다.

`aso`, `review`, `blog` 등의 커맨드를 Slack에서 치면 현재는 `(skill not implemented: aso)` 문자열이 돌아오므로 Mode A 경로도 확인 가능하다. 좋은 M1 exit 조건 충족.

**MCP 툴 노출 여부**: M1 `McpManager`는 `buildMcpContext()`가 빈 문자열을 반환하고 `writeMcpConfig()`가 `null`을 반환해 `--mcp-config` 플래그를 아예 붙이지 않는다. Mode B에서 Claude에 노출되는 툴이 0개이므로 **skills를 MCP tool로 노출하는 사고는 구조적으로 불가능**하다. 이 invariant가 여전히 지켜진다. 

## Approval flow integrity

`safety.ts` / `core.ts`의 approval 경로는 이번 PR에서 수정되지 않았다. 다만 `daemon.ts`의 shutdown이 `approvalManager.shutdown()`을 통해 pending timeout을 정리한다 — 올바른 순서(먼저 approval → 뒤에 messenger stop).

`ADARIA_DRY_RUN` 처리는 M1 범위에서 아직 확인할 write path가 없으므로 해당 없음(skills가 없음). M4에서 재확인 필요.

## Bundled asset path resolution (요청 항목 A)

### 검증 1: 로컬 dev (`node dist/index.js start`)
- `import.meta.url` ← `file:///Users/ahnwoojin/Github/adaria-ai/dist/cli/start.js`
- `paths.ts.BUNDLED_LAUNCHD_DIR` ← `/Users/ahnwoojin/Github/adaria-ai/launchd/` ✅
- `getDaemonEntryScriptPath()` ← `/Users/ahnwoojin/Github/adaria-ai/dist/index.js` ✅
- 템플릿 파일 존재 확인 ✅

### 검증 2: 글로벌 설치 (`npm install -g adaria-ai`)
- 설치 경로: `/opt/homebrew/lib/node_modules/adaria-ai/`
- Node ESM 로더의 기본 동작: **symlink를 resolve한다** (CJS와 반대이며, `--preserve-symlinks` 플래그가 없을 때 기본).
- 사용자가 `adaria-ai start` 실행 → `/opt/homebrew/bin/adaria-ai` (npm bin shim) → `dist/index.js` 실행 → `import.meta.url` = real path `file:///opt/homebrew/lib/node_modules/adaria-ai/dist/cli/start.js`
- `BUNDLED_LAUNCHD_DIR` ← `/opt/homebrew/lib/node_modules/adaria-ai/launchd/` ✅
- `getDaemonEntryScriptPath()` ← `/opt/homebrew/lib/node_modules/adaria-ai/dist/index.js` ✅
- launchd가 쓸 경로는 **real path**이므로 npm shim의 `.bin/adaria-ai`가 사라져도 영향 없음 ✅
- `package.json.files`에 `launchd/`가 포함돼 tarball 출하 ✅ (M5의 `src/` 이중 포함 문제는 별도)

### 검증 3: `process.execPath`
- 위 M1 finding 참조. Homebrew Cellar 경로가 Node 업그레이드 시 stale해지는 문제는 **asset path 이슈는 아니지만** 결과적으로 M9 smoke test의 blocker가 될 수 있다.

**결론**: `import.meta.url` 기반 해석은 올바르다. 번들 에셋(`launchd/com.adaria-ai.daemon.plist.template`)은 로컬/글로벌 둘 다 문제없이 찾아진다. 유일한 잠재 이슈는 `__NODE_BIN__`에 들어가는 경로가 버전 픽스드인 것(M1).

## `replaceAll` + special chars (요청 항목 C)

- `tsconfig.base.json`의 `target: ES2022` → `String.prototype.replaceAll`(ES2021) 안전 사용 가능 ✅
- `replaceAll(literalString, literalString)` 오버로드는 리터럴 치환이라 regex 메타문자가 전혀 영향 없음 ✅ (regex 오버로드는 `new RegExp(...)`를 첫 인자로 받을 때만 발동)
- `process.execPath`, `ADARIA_HOME`, `LOGS_DIR`, `pathValue` 모두 path 문자열이고 literal로 전달되므로 문제 없음 ✅

## Positive Observations

1. **Minimal, honest init**: pilot-ai 834 LOC → adaria-ai 120 LOC. 필요 없는 OAuth 서플을 다 쳐냈고, `configSchema.parse()`로 후방 검증하는 패턴은 "YAML을 쓰기 전에 shape을 검증한다"는 좋은 습관.
2. **Bundled asset 해석**: `paths.ts` 중앙화, `import.meta.url` 기반 — 정확히 CLAUDE.md가 요구하는 방식. 로컬/글로벌 설치 둘 다 검증 통과.
3. **`eventTs` 일관성 유지**: `core.ts`의 `eventTs` 가드는 그대로 유지. Mode A/B 전환에서도 reaction 한정 패치가 의도대로 동작함을 daemon 실행 경로에서 재확인.
4. **Keychain sentinel 왕복**: `init.ts`가 `***keychain***`을 YAML에 쓰고, `store.ts`가 그걸 로드 시 해석하는 스키마/저장 분리가 깔끔하다.
5. **Signal handler guard**: `shuttingDown` 플래그로 더블 샷다운 방어, 그리고 `agent.stop()`이 `approvalManager.shutdown()`을 먼저 부른 뒤 messenger를 닫는 순서가 정확하다 (M1 core 리뷰에서 이미 검증된 패턴).
6. **Doctor 스코프 제약**: M1에서 Claude/config/allowlist만 체크하고 App Store/GA4 등은 M7로 미룬다고 명시. 스코프 크립 없음.
7. **`commander`의 dynamic import**: 전체 CLI cold-start 시간을 낮추는 좋은 패턴. `adaria-ai doctor`가 inquirer/bolt를 안 읽어도 된다.
8. **`exactOptionalPropertyTypes` 준수**: `doctor.ts`의 `check()` 팩토리가 `message` 필드를 조건부로 포함시키는 건 `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`에 걸리지 않도록 정확히 맞춘 구현.

## Action Items

### Must-fix before M1 commit
- [ ] **H1**: `daemon.ts`가 `ConfigError`를 캐치해 exit 0으로 마감 + `plist`의 `KeepAlive`를 `{SuccessfulExit: false, Crashed: true}` dict로 전환해서 설정 오류 시 crash loop 차단.
- [ ] **H2**: `init.ts`의 `loadRawConfig()` 호출을 제거하거나 try/catch로 감싸서 깨진 YAML로부터 `init`이 스스로 탈출할 수 있게 함. "Press Enter to keep unchanged" 거짓 안내 제거.

### Should-fix before M9 smoke test
- [ ] **M1**: `__NODE_BIN__` 계산 시 `/opt/homebrew/bin/node` symlink 선호. Node 업그레이드 후 `adaria-ai start` 재실행 안내.
- [ ] **M3**: `runStart`가 이미 로드된 경우에도 플리스트를 다시 렌더하고 reload하거나, 명시적 안내로 전환.
- [ ] **M5**: `package.json.files`에서 `"src/"` 제거.

### Before M4 skills land
- [ ] **M2**: `status.ts`의 launchctl 파싱을 라벨 완전일치로 교체 (M6 weekly/monitor 추가 시 회귀 방지).
- [ ] **M4**: `daemon.ts`의 shutdown에 3초 데드라인 타이머 추가.

### Nice-to-have
- [ ] **L1**: inquirer legacy API → `@inquirer/password`/`@inquirer/input` 함수형 API로 마이그레이션.
- [ ] **L2**: `daemon.ts` shutdown 체인을 async IIFE로 정리.
- [ ] **L3**: `logs.ts`의 SIGINT 리스너를 `once`로.
- [ ] **L4**: `status.ts` PID 파싱을 `Number.isInteger && > 0`로 방어.
- [ ] **L5**: `JobStatus.loaded` vs `running` 분리 (M6 기초).
- [ ] **L6**: 서브커맨드별 `--help` smoke test 추가.
- [ ] **L7**: `init.ts`의 `setSecret` 호출 개별 try/catch + 재시도 UX.
