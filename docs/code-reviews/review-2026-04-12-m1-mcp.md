# Code Review: M1 — MCP Framework Skeleton (deliberate rewrite)

**Date**: 2026-04-12
**Reviewer**: Senior Code Review Agent
**Scope**:
- `src/agent/mcp-manager.ts` (new, ~158 LOC — skeleton for M5.5)
- `src/agent/mcp-launcher.ts` (new, ~47 LOC — `buildToolHostServerConfig` helper)
**Milestone**: M1 (pilot-ai runtime import)
**Commit(s)**: uncommitted (working tree)

## Summary

**아키텍처 결정은 올바릅니다.** Pilot-ai의 mcp-manager 472 LOC를 그대로 복사하는 것은 오답이었을 것입니다 — 거기 들어있는 건 전부 "사용자가 Gmail/Figma/Slack MCP 서버를 설치하게 해주는" 로직(Keychain secret 저장, npx 패키지 resolve, bash wrapper 스크립트 생성, Claude Code 동기화, HTTP transport 분기, migration 루틴 등)이고 adaria-ai에는 **설치 플로우 자체가 없기** 때문입니다. adaria-ai의 Mode B 툴 4개는 전부 패키지에 번들된 in-process TS 코드고, 유저가 공급하는 시크릿도, 서드파티 npm 서버도 없습니다. 472 LOC 중 실제로 포트할 가치가 있는 건 `buildMcpContext` 함수의 아이디어(시스템 프롬프트에 툴 설명 주입) 하나뿐이고, 그 외엔 전부 adaria-ai 컨텍스트에서 데드 코드입니다. 158 LOC 스켈레톤은 그 아이디어 + M5.5가 필요로 할 모양만 골라냈다는 점에서 정확합니다.

다만 porting-matrix.md가 두 파일을 🟢 copy로 분류한 건 오분류입니다. 내용상 🟡 adapt(사실상 🆕 new에 가까움)가 맞습니다. **사전 승인 문제로 따지자면, "copy를 adapt/new로 다운그레이드"는 `.claude/agents/senior-code-reviewer.md`의 프로세스 규약(매트릭스 deviation시 확인 필요)에 걸리는 사안입니다.** 이번 PR이 들어가는 같은 커밋에 `docs/growth-agent/porting-matrix.md` 줄 29-30의 분류를 🟡로 고치고 짧은 Notes를 붙이면 됩니다(아래 Action Item 참조).

메리트 기준으로는, M5.5가 필요로 할 표면은 대부분 잡았지만 **handler 필드의 위치가 근본적으로 애매**합니다. Claude CLI는 `--mcp-config`로 전달된 JSON을 읽고 서브프로세스를 spawn한 뒤 JSON-RPC로 대화합니다. 그 서브프로세스가 in-process `handler` 함수를 어떻게 다시 잡을지의 의문이 현재 타입만으로는 해결되지 않습니다. **M5.5 전에 이 부분의 책임 경계를 명확히 해야 합니다** (HIGH).

두 번째로, `buildMcpConfig()`가 M1에서 `{ mcpServers: {} }`를 반환하는데, pilot-ai의 자체 코드(`tools/figma-mcp.ts:getMcpConfigPathIfExists`)는 **"mcpServers가 비어 있으면 `--mcp-config` 플래그 자체를 넘기지 말아라"** 라는 패턴을 이미 확립해 두었습니다. Claude CLI가 빈 객체를 받았을 때의 동작은 문서화되어 있지 않고, 공식 레포에 HTTP MCP + `-p` 조합으로 silent exit 0하는 이슈도 있으므로 (`anthropics/claude-code#32191`) "빈 파일은 그냥 쓰지 말자"가 안전합니다 (MEDIUM).

나머지는 작은 문제들입니다.

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH     | 1 |
| MEDIUM   | 2 |
| LOW      | 2 |
| INFO     | 4 |

**Overall Grade**: B+
**Milestone fit**: 적절. M1 "MCP framework only, no tools registered yet" 스코프에 정확히 부합. 스코프 크리프 없음.
**Architectural decision**: **검증 통과.** 472 LOC → 158 LOC 다운사이즈는 올바른 판단. 다만 porting-matrix에 deviation을 반영해야 함.

---

## 아키텍처 결정 검증 (사용자 질문에 대한 직접 답)

### 왜 이 축소가 옳은가

Pilot-ai의 472 LOC를 기능별로 분해하면:

| Pilot-ai 라인 영역 | 기능 | adaria-ai에서 필요한가 |
|-------------------|------|----------------------|
| L27-203 | `getInstalledServers`, `detectNeededServers`, `installMcpServer`, `verifyMcpServerStartup`, `uninstallMcpServer`, `listAvailableServers` | ❌ 설치 플로우 없음. 툴 4개는 번들. |
| L205-239 | `registerSentinelAi` (sentinel-qa 하드코딩) | ❌ Personal agent 유산. |
| L241-260 | `buildApprovalMessage` | ❌ 유저 승인으로 서버 추가하는 플로우 없음. |
| L262-310 | `buildMcpContext` (설치/미설치 서버 목록을 시스템 프롬프트에 주입) | ⚠️ **아이디어만** 필요. adaria-ai 버전은 "tool 4개 설명" 한 블록. |
| L312-387 | `migrateToSecureLaunchers` (plaintext env → Keychain wrapper 마이그레이션) | ❌ Keychain wrapper 개념 자체 없음. |
| L389-472 | `checkAllMcpServerStatus` (Keychain secret 존재 확인) | ⚠️ **스텁만** 필요. adaria-ai는 서브프로세스 health probe로 대체. |

실제 재사용 비율은 2 함수의 "개념"만 해당되고, 나머지는 다른 도메인의 코드입니다. "복사"로는 커버할 수 없습니다.

`mcp-launcher.ts`도 마찬가지로, pilot-ai 187 LOC는 **"bash wrapper 스크립트에 security find-generic-password 호출을 심어 Keychain에서 시크릿을 런타임 추출"** 이 전부이고 adaria-ai는 wrapper 스크립트도 Keychain 시크릿도 쓰지 않습니다. 45 LOC는 정확히 필요한 만큼입니다.

**결론: 스켈레톤은 옳다.** 아래 HIGH 1건만 해결하면 M5.5로 넘어가기 좋은 시작점입니다.

---

## High Findings

### H1. `McpToolDescriptor.handler` 필드가 in-process 함수 참조지만 실제 호출 경로는 서브프로세스 — 책임 경계가 불명확

- **Severity**: HIGH
- **Category**: Architecture / MCP framework semantics
- **File**: `src/agent/mcp-manager.ts:36-47`
- **Issue**: `McpToolDescriptor`는 in-process `handler: (input: unknown) => Promise<unknown>` 필드를 가집니다. 그런데 Claude CLI가 MCP 툴을 호출하는 실제 경로는:

  ```
  daemon process (adaria-ai)
    └─ spawn('claude', ['--mcp-config', path, ...])
         └─ Claude CLI 프로세스
              └─ 스스로 spawn(serverConfig.command, serverConfig.args)
                   └─ tool host 프로세스 (별도 Node 인스턴스)
                        └─ MCP JSON-RPC over stdio → dispatch by tool name
  ```

  즉 **daemon에서 `manager.registerTool({ handler: ... })`로 등록한 handler는 tool host 서브프로세스의 `McpManager` 인스턴스까지 도달하지 않습니다.** daemon의 `McpManager`와 tool host의 `McpManager`는 서로 다른 프로세스 내의 다른 Map 인스턴스입니다. 현재 타입만 보면 마치 "daemon이 등록한 handler를 Claude가 바로 부를 수 있다"처럼 읽히는데, 실제론 그렇지 않습니다.

  두 가지 M5.5 설계 중 하나를 선택해야 하는데, 현재 스켈레톤은 어느 쪽에도 딱 맞지 않습니다:

  **옵션 A — Tool host가 같은 descriptor 모듈을 re-import하는 구조**
  - daemon은 `registerTool()`을 호출하지 않습니다 (descriptor 테이블이 daemon에 있을 이유가 없음).
  - `src/tools/index.ts`가 descriptor 배열을 export.
  - daemon은 그 배열에서 **descriptor만** 읽어 `buildMcpContext()`에 주입.
  - tool host 서브프로세스(`dist/tool-host.js`)가 같은 배열을 re-import해서 handler를 직접 실행.
  - 이 경우 `McpToolDescriptor.handler`는 **in-process가 아니라 "tool host에서만 실행됨"** 이라는 의미를 가져야 하며, daemon의 `McpManager`는 **descriptor-only 레지스트리**가 맞습니다. handler 필드는 옵션으로 만들거나 별도 타입으로 분리.

  **옵션 B — Daemon이 tool host를 겸하는 구조 (IPC 없음)**
  - `--mcp-config`를 쓰지 않고 `claude` CLI에 tool 설명만 system prompt로 주입한 뒤, Claude가 "tool call" 포맷으로 응답하면 daemon이 그걸 파싱해 직접 handler를 호출.
  - 이건 pilot-ai의 스킬 loader 패턴이고 Claude Code MCP 공식 경로가 아닙니다. 비추천.

  **옵션 C — Tool host가 IPC로 daemon에 reverse call**
  - tool host가 dispatch를 받으면 unix socket 등으로 daemon에 reverse-call해서 실제 작업 수행.
  - 복잡도 대비 이익 없음. 비추천.

  `milestones.md` M5.5 (`.claude/agents/senior-code-reviewer.md:211` "All 4 tools registered via `mcp-manager.ts` at daemon startup") 문구만으로는 옵션 A/B 중 어느 쪽인지 확정되지 않습니다. 스켈레톤의 `McpToolDescriptor.handler` + `McpManager.registerTool()` + `registerTool` JSDoc ("The MCP server subprocess will dispatch incoming requests to this handler by `id`") 은 옵션 A를 암시하지만, 그렇다면 daemon의 McpManager 인스턴스에는 handler를 저장할 이유가 없습니다 — daemon은 등록된 tool 이름만 알면 충분하고 handler는 tool host에서만 쓰입니다.

- **Impact**:
  - M5.5 구현자(반년 뒤의 당신 본인 포함)가 "daemon에서 registerTool을 호출해야 하는구나"라고 오해하기 쉬움. daemon은 호출하지 말아야 할 수도 있음.
  - 테스트에서 daemon 인스턴스의 `registerTool` → `handler()` 직접 호출 시나리오가 "작동"하지만 프로덕션 경로와 다름 → false positive.
  - tool host가 별도 파일에서 같은 descriptor 모듈을 import해야 한다는 점이 타입으로 강제되지 않아서, 두 쪽의 tool 이름이 drift할 수 있음.
  - 가장 중요하게: **`inputSchema` validation을 어디서 하는가?** 서브프로세스가 한다면 daemon에는 스키마가 필요 없음. daemon이 한다면 서브프로세스 재전송이 필요.
- **Recommended fix**: M1에서 결정하지 말고, **현재 구조를 옵션 A 전제로 명시적으로 정리**하고 M5.5에 위임합니다. 변경 사항은 작습니다:

  1. `McpToolDescriptor`에서 `handler`를 분리하여 두 가지 타입으로 나눕니다:

  ```ts
  /**
   * Daemon-visible metadata about an MCP tool. Used to build the system
   * prompt and the `--mcp-config` JSON. Does NOT include the implementation.
   */
  export interface McpToolDescriptor {
    /** Stable identifier used in `mcp__adaria__<id>`. */
    id: string;
    name: string;
    description: string;
    inputSchema: McpInputSchema;
  }

  /**
   * Tool-host-side implementation. Lives in the subprocess that Claude CLI
   * spawns via --mcp-config. The daemon never calls this directly — it is
   * re-imported by the tool host binary, which runs its own McpManager and
   * dispatches JSON-RPC calls to the handler.
   *
   * daemon ──[descriptors only]──▶ mcp-config.json
   *                                      │
   *                                      ▼
   *                              claude ──spawn──▶ tool-host
   *                                                  │
   *                                                  ▼
   *                                           new McpManager()
   *                                           manager.registerTool({
   *                                             ...descriptor,
   *                                             handler,
   *                                           })
   */
  export interface McpToolImplementation extends McpToolDescriptor {
    handler: (input: unknown) => Promise<unknown>;
  }
  ```

  2. `McpManager.tools`는 `Map<string, McpToolImplementation>`이어도 되지만, 그러면 daemon 쪽은 `McpManager`를 인스턴스화하지 않고 **descriptor-only 함수**들만 씁니다:

  ```ts
  /**
   * Daemon-side: given a set of descriptors, build the system prompt block.
   * Does not touch handlers. Does not instantiate McpManager.
   */
  export function buildMcpContextFor(descriptors: McpToolDescriptor[]): string {
    if (descriptors.length === 0) return "";
    const lines: string[] = [];
    lines.push("MCP TOOLS AVAILABLE:");
    lines.push(
      "These are read-only marketing tools. Use them to answer questions about apps, rankings, reviews, and prior analyses. They CANNOT write to the database or trigger skill write paths.",
    );
    lines.push("");
    for (const d of descriptors) {
      lines.push(`- mcp__adaria__${d.id} — ${d.description}`);
    }
    return lines.join("\n");
  }

  /**
   * Daemon-side: given a launch spec + list of descriptors, build the JSON
   * blob that goes to `claude --mcp-config`. Returns null when there are no
   * tools — pilot-ai's own convention, mirrored from `getMcpConfigPathIfExists`.
   */
  export function buildMcpConfigFor(
    descriptors: McpToolDescriptor[],
    launchSpec: ToolHostLaunchSpec,
  ): McpConfigFile | null {
    if (descriptors.length === 0) return null;
    return {
      mcpServers: {
        adaria: buildToolHostServerConfig(launchSpec),
      },
    };
  }
  ```

  3. `McpManager` 클래스는 **tool host 서브프로세스가 쓰는** 런타임 레지스트리로 축소:

  ```ts
  /**
   * In-process tool-host runtime registry. Instantiated inside the tool-host
   * subprocess (NOT in the daemon). Receives JSON-RPC dispatch and runs the
   * matching implementation.
   */
  export class McpManager {
    private tools = new Map<string, McpToolImplementation>();

    registerTool(impl: McpToolImplementation): void { ... }
    async dispatch(id: string, input: unknown): Promise<unknown> {
      const impl = this.tools.get(id);
      if (!impl) throw new Error(`Unknown MCP tool: ${id}`);
      return impl.handler(input);
    }
    // rest as before
  }
  ```

  4. M1 스코프에서는 daemon도 tool host도 아무 것도 등록하지 않으므로, 이 분리만 타입 수준에서 해두고 구현체는 지금처럼 빈 상태로 둡니다. 약 20 LOC 증가, 미래의 혼란은 -0건.

  **만약 옵션 A가 아니라 옵션 B(번들된 tool host 없음, daemon이 Claude의 tool call 응답을 직접 파싱)로 가기로 결정한다면**, `writeMcpConfig`/`mcp-launcher.ts` 전체가 의미가 없어지고 두 파일 다 삭제 후 `tool-descriptions.ts`만 남는 구조가 됩니다. 이 PR을 M5.5까지 들고 가기 전에 **M1/M5.5 사이에서 옵션 A/B를 open-questions.md에 등록하고 결정을 기록**하는 것이 가장 저비용입니다.

---

## Medium Findings

### M1. `buildMcpConfig()`가 빈 `{mcpServers: {}}`를 반환하고 `writeMcpConfig()`는 그걸 디스크에 씁니다 — pilot-ai 자체 규약은 "비면 파일 쓰지 마라"

- **Severity**: MEDIUM
- **Category**: Claude CLI integration / 미확정 동작 예방
- **File**: `src/agent/mcp-manager.ts:128-143`
- **Issue**: 사용자 질문 #2 그대로: Claude CLI가 `--mcp-config`에 `{ "mcpServers": {} }`만 들어 있는 파일을 받았을 때 어떻게 동작하는지 공식 문서에 없습니다. 경험적으론 세 가지 가능성이 있습니다:
  1. 무시하고 툴 없이 정상 실행
  2. "empty mcpServers — did you mean to omit the flag?" 경고 후 정상 실행
  3. parse 에러 혹은 silent exit 0 (HTTP MCP 관련해서 `anthropics/claude-code#32191` 같은 silent-exit 버그가 실제로 존재)

  어느 쪽이든 베팅할 이유가 없습니다. **pilot-ai 자신의 코드가 이미 답을 줬습니다:** `pilot-ai/src/tools/figma-mcp.ts:41-45`의 `getMcpConfigPathIfExists()`는 `Object.keys(config.mcpServers).length === 0`이면 `null`을 반환하고, `pilot-ai/src/agent/core.ts:389`는 그 `null`을 받아 `mcpConfigPath`를 undefined로 만들어 `claude.ts:172`의 조건부 `if (mcpConfigPath)` 분기에서 `--mcp-config` 플래그 자체를 건너뜁니다. "빈 파일 쓰지 말고 플래그 자체를 생략"이 pilot-ai가 실제로 프로덕션에서 검증한 패턴입니다. adaria-ai도 이걸 따라야 합니다.

  추가로, `writeMcpConfig`가 mode 0o600으로 파일을 쓰는 건 좋은데, 이건 시크릿이 들어갈 수 있다는 가정에서 유용한 조치였습니다. adaria-ai는 시크릿을 넣지 않으므로 — 옵션 A라면 `{command: process.execPath, args: [entryPoint]}`만 쓰므로 — 0600은 over-kill이 아니라 defensive함으로 유지해도 OK. 그러나 빈 파일을 쓰는 게 문제입니다.
- **Impact**:
  - M1 daemon 부팅 시 `writeMcpConfig()`가 호출된다면 `~/.adaria/mcp-config.json`에 `{"mcpServers":{}}`가 쓰입니다. 지금은 아무도 호출하지 않지만, M2/M3/M4에서 core.ts 포트할 때 "daemon 부팅 시 무조건 writeMcpConfig" 패턴을 그대로 따라갈 위험.
  - M5.5 시점에 "왜 빈 config가 disk에 있지?"를 디버깅하는 시간 낭비.
  - Claude CLI의 undefined 동작에 베팅하게 됨.
- **Current code**:
  ```ts
  buildMcpConfig(): McpConfigFile {
    return { mcpServers: {} };
  }

  async writeMcpConfig(outputPath?: string): Promise<string> {
    const target = outputPath ?? path.join(ADARIA_HOME, "mcp-config.json");
    const config = this.buildMcpConfig();
    await fs.writeFile(target, JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
    return target;
  }
  ```
- **Recommended fix**: `buildMcpConfig`를 null-able로 만들고 `writeMcpConfig`는 null일 때 파일을 쓰지 않고 null을 반환합니다. 호출부는 "path가 null이면 `--mcp-config` 플래그를 생략" 규약을 지키면 됩니다. H1의 리팩터로 `McpManager`가 descriptor-only로 바뀌면 아래는 `buildMcpConfigFor` 함수형 helper에 녹입니다.

  ```ts
  /**
   * Produces the `mcp-config.json` shape that `claude --mcp-config` expects,
   * or null when no tools are registered. Callers should treat null as
   * "do not pass `--mcp-config` at all" (mirrors pilot-ai's own
   * `getMcpConfigPathIfExists` pattern — Claude CLI's behavior on an empty
   * mcpServers object is not documented and should not be relied upon).
   */
  buildMcpConfig(): McpConfigFile | null {
    if (this.tools.size === 0) return null;
    // M5.5: build real server config via buildToolHostServerConfig()
    return { mcpServers: {} }; // placeholder until M5.5
  }

  /**
   * Writes the MCP config to disk at 0600 and returns the absolute path, OR
   * returns null when there are no tools — in which case no file is written
   * and callers must omit the `--mcp-config` CLI flag entirely.
   */
  async writeMcpConfig(outputPath?: string): Promise<string | null> {
    const config = this.buildMcpConfig();
    if (config === null) return null;
    const target = outputPath ?? path.join(ADARIA_HOME, "mcp-config.json");
    await fs.writeFile(target, JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
    return target;
  }
  ```

  그리고 JSDoc을 호출부 규약으로 강화:

  ```ts
  /**
   * ...
   *
   * Usage contract:
   *   const cfgPath = await manager.writeMcpConfig();
   *   if (cfgPath !== null) {
   *     args.push('--mcp-config', cfgPath);
   *   }
   *   // ... spawn claude
   */
  ```

  이후 M3/M4 core.ts 포트 때 그 분기가 반드시 반영되도록 `checklist.md` M3 섹션에 한 줄 추가합니다.

---

### M2. Porting-matrix.md 분류와 실제 내용이 불일치 — 🟢 copy가 아니라 🟡 adapt (또는 🆕 new)

- **Severity**: MEDIUM
- **Category**: Process / Doc integrity
- **File**: `docs/growth-agent/porting-matrix.md:29-30`
- **Issue**: 현재 매트릭스는:

  ```
  | `mcp-manager.ts`  | 🟢 copy | ... | MCP server registry / lifecycle. ... |
  | `mcp-launcher.ts` | 🟢 copy | ... | Spawns MCP servers for Claude CLI. Same framework, different tools. |
  ```

  실제로는 472 LOC → 158 LOC, 187 LOC → 47 LOC로 **핵심 함수 대부분이 교체**되었습니다. `generateLauncherScript`, `getSecret`, `setSecret`, `classifyEnvVars`, `installMcpServer`, `uninstallMcpServer`, `migrateToSecureLaunchers`, `detectNeededServers`, `listAvailableServers`, `buildApprovalMessage`, `verifyMcpServerStartup`, `syncToClaudeCode`, HTTP transport 분기 — 이 모두 삭제되었습니다. 남은 것은 `McpServerStatus` 타입 이름 정도고 그것도 enum 값이 축소되었습니다 (`'ready' | 'connecting' | 'auth_required' | 'not_registered' | 'error'` → `'ready' | 'error' | 'not_registered'`). 범례 기준으로는:
  - 🟢 copy: "lift verbatim or near-verbatim, TS tweaks only"
  - 🟡 adapt: "copy but meaningfully modify (trim, rename, refactor)"
  - 🆕 new: "write fresh in adaria-ai"

  실제 행위는 🟡-🆕 경계입니다. `.claude/agents/senior-code-reviewer.md`가 매트릭스 준수를 명시적 리뷰 포인트로 잡고 있으므로, 매트릭스가 틀렸다면 매트릭스를 고치는 게 "drift without approval"을 막는 유일한 방법입니다.
- **Impact**:
  - 미래 리뷰어가 "매트릭스가 copy라 했는데 왜 158 LOC밖에 없지? 472 LOC를 놓친 거 아닌가?"라고 되묻게 됩니다.
  - M9 릴리즈 전 포팅 완성도 검수 시 "매트릭스 대비 실제 코드" 대조 스크립트가 드리프트를 감지 못함.
  - 프로젝트 CLAUDE.md의 "Treat contradictions between docs and user instructions as a reason to pause and ask, not drift" 원칙과 충돌.
- **Recommended fix**: porting-matrix.md를 업데이트. Notes 칸에 왜 🟢가 아니라 🟡인지 한 줄. 같은 PR 혹은 바로 이어지는 docs PR로 처리.

  ```markdown
  | `mcp-manager.ts` | 🟡 adapt | `src/agent/mcp-manager.ts` | **Major rewrite, not a copy.** Pilot-ai's 472 LOC is scaffolded around installing/uninstalling third-party npm MCP servers (Gmail, Figma, Slack) with Keychain-backed wrapper scripts and Claude Code sync. adaria-ai ships a fixed set of bundled in-process tools with no install flow, no user secrets, and no third-party npm packages, so ~300 LOC of that machinery has no home. The kept surface is: `McpToolDescriptor` type, `buildMcpContext()` (system prompt text), `buildMcpConfig()`/`writeMcpConfig()` (the JSON Claude CLI consumes), and a `checkMcpServerHealth()` stub for M5.5. Approximately 158 LOC. |
  | `mcp-launcher.ts` | 🟡 adapt | `src/agent/mcp-launcher.ts` | **Major rewrite, not a copy.** Pilot-ai's launcher generates bash wrapper scripts that call `security find-generic-password` to pull Keychain secrets at runtime — adaria-ai has no Keychain-wrapped secrets and no wrapper scripts. The adaria-ai version is a single helper, `buildToolHostServerConfig`, that produces `{command: process.execPath, args: [entryPoint]}` for the bundled tool host. Approximately 47 LOC. |
  ```

  체크리스트 M1 섹션에 같은 deviation 노트를 붙입니다:

  ```markdown
  - [x] `src/agent/mcp-manager.ts` — framework skeleton (~158 LOC, not a literal copy of pilot-ai's 472 LOC — see matrix note)
  - [x] `src/agent/mcp-launcher.ts` — framework skeleton (~47 LOC, not a literal copy of pilot-ai's 187 LOC — see matrix note)
  ```

  추가로, 이 deviation을 "과거에 copy로 분류했던 다른 파일 중 실제로는 adapt였던 것" 검증 기회로 활용: `claude.ts`, `session.ts`, `memory.ts`, `audit.ts`, `conversation-summary.ts` 등 M1에서 이미 포트된 파일들을 LOC 기준으로 한번 sanity check해보기를 권장합니다.

---

## Low Findings

### L1. `reset()` 테스트 훅 — `new McpManager()` 패턴이 깔끔

- **Severity**: LOW
- **Category**: Code quality / Test ergonomics
- **File**: `src/agent/mcp-manager.ts:154-157`
- **Issue**: 사용자 질문 #6 그대로. `reset()`는 프로덕션 호출부가 없고 테스트 전용입니다. Pilot-ai 원본은 in-process singleton이 없어서 `reset()` 개념 자체가 없었고, 대신 파일 기반 `loadMcpConfig()`를 직접 mock해서 테스트했습니다. adaria-ai는 `McpManager` 클래스 인스턴스를 매 테스트마다 새로 만들 수 있으므로 `reset()`이 필요한 시나리오가 딱히 없습니다.

  예외: daemon이 module-level singleton을 export한다면(예: `export const mcpManager = new McpManager()`), 그때는 `reset()`이 필요해집니다. 현재 그런 싱글톤이 없으니 preemptive하게 넣어둔 셈입니다.
- **Impact**: 없음. 테스트에서 `new McpManager()`를 쓰면 되므로 dead function.
- **Recommended fix**: 두 가지 옵션:

  **옵션 a (권장):** `reset()` 제거. 테스트는 `new McpManager()`로 새 인스턴스 생성.

  ```ts
  // DELETE lines 154-157
  ```

  **옵션 b:** singleton export를 추가할 계획이 M5.5에 있다면(e.g. `core.ts`가 `import { mcpManager } from './mcp-manager.js'`) 남겨두되 JSDoc에 그 이유를 적기:

  ```ts
  /**
   * Clears all registered tools. Used by tests that exercise the shared
   * module-level singleton (see TODO(M5.5): singleton export). For tests
   * that work on their own McpManager instance, prefer `new McpManager()`.
   */
  reset(): void {
    this.tools.clear();
  }
  ```

  H1 리팩터로 `McpManager`가 "tool host 런타임 레지스트리"로 의미가 분명해지면, tool host는 프로세스당 한 번만 뜨므로 더더욱 `reset()`이 필요 없어집니다. 옵션 a 권장.

---

### L2. `McpToolDescriptor.handler`의 `input: unknown` 타입이 implementation 당사자에게 캐스트 책임을 떠넘김

- **Severity**: LOW
- **Category**: Type safety / Developer ergonomics
- **File**: `src/agent/mcp-manager.ts:46`
- **Issue**: `handler: (input: unknown) => Promise<unknown>`은 안전합니다 — 외부에서 들어오는 JSON을 `unknown`으로 두는 건 올바릅니다. 다만 각 tool의 구현부가 매번 `const { table, where } = input as DbQueryInput;` 같은 assertion을 하게 되고, `inputSchema` (JSON Schema)와 런타임 validation 사이의 연결이 구조적으로 없습니다.

  M5.5에서 선택지는:
  - Zod 스키마를 별도 필드로 잡고, Zod에서 `inputSchema`(JSON Schema) derive
  - `ajv`로 `inputSchema`를 직접 검증
  - 손으로 assertion

  현재 스켈레톤은 "손으로 assertion" 길을 열어두고 있는데, 4개 tool 모두 reject 테스트를 요구하는 M5.5 exit criteria(`milestones.md` M5.5: "Unit: each tool rejects non-whitelisted inputs")를 생각하면 지금 Zod 기반 패턴으로 잠그는 게 낫습니다.
- **Impact**: M5.5 구현자가 "한 번은 inputSchema, 또 한 번은 Zod assertion, 두 개가 drift" 하는 상황을 만들 위험.
- **Recommended fix**: M1 스코프에서 강제할 필요는 없지만 H1 리팩터를 할 때 함께 검토합니다. 대안 타입:

  ```ts
  import type { ZodType } from "zod";

  /**
   * Tool-host-side implementation. The `inputSchema` field is the runtime
   * validator; the `handler` receives the already-validated, typed input.
   */
  export interface McpToolImplementation<TInput = unknown, TOutput = unknown> {
    id: string;
    name: string;
    description: string;
    /** Zod schema. `inputJsonSchema` below is derived via zod-to-json-schema. */
    inputSchema: ZodType<TInput>;
    handler: (input: TInput) => Promise<TOutput>;
  }

  /**
   * Daemon-visible descriptor — same shape minus handler, with the
   * JSON-Schema representation of the input for Claude's consumption.
   */
  export interface McpToolDescriptor {
    id: string;
    name: string;
    description: string;
    inputJsonSchema: Record<string, unknown>;
  }
  ```

  M1에서 zod 디펜던시가 이미 있는지 확인해두고(`src/config/schema.ts` 쓰이고 있으므로 OK), M5.5 때 구현부가 `zod-to-json-schema`를 쓸 수 있는지만 결정합니다. **지금 이 변경을 강요하면 M1 스코프 초과이므로, `open-questions.md`에 "MCP tool input validation: Zod vs. ajv vs. bare JSON Schema"로 올려두는 것만 권장합니다.**

---

## Info / Observations

### I1. 사용자 질문 #3 — eager `ADARIA_HOME` import는 OK (storage layer convention과 일치)

사용자 질문:
> `ADARIA_HOME` is imported top-level in mcp-manager for the default `writeMcpConfig` path. Same eager-constant pattern as the storage layer — make sure tests that set `process.env["ADARIA_HOME"]` before dynamic import still work.

**괜찮습니다.** 현재 `tests/utils/logger.test.ts:6-28`와 `tests/agent/session.test.ts:6-24`가 사용하는 패턴은:
1. `process.env["ADARIA_HOME"] = TEST_HOME`
2. `await import("../../src/agent/mcp-manager.js")` (top-level await)
3. `await import("../../src/utils/paths.js")`

Node의 ESM module cache는 "첫 import 시점에 evaluate"이므로, env가 먼저 세팅되면 `paths.ts`의 `ADARIA_HOME = process.env["ADARIA_HOME"] ?? ...`가 테스트의 TEST_HOME을 잡습니다. `mcp-manager.ts:24`의 `import { ADARIA_HOME } from "../utils/paths.js"`도 같은 해상도 결과를 받습니다.

**단, `writeMcpConfig(outputPath?)`의 `outputPath` 기본값은 함수 *호출* 시점이 아니라 **함수 정의 시점에 캡처된 `ADARIA_HOME`** 입니다.** 이게 혹시 문제가 될까? 아니요 — `path.join(ADARIA_HOME, "mcp-config.json")`가 `?? outputPath` 삼항 안에 있어서 매 함수 호출마다 재평가되고, 그때마다 top-level `ADARIA_HOME`을 읽습니다. `ADARIA_HOME` 자체는 const이지만 모듈 로드 시점에 한 번만 해소되었으므로 test env를 import 이전에 세팅하는 기존 패턴과 100% 호환됩니다.

M1 스토리지 레이어 리뷰(`review-2026-04-12-m1-storage.md`)에서 같은 패턴을 이미 검증했으므로 동일한 결론입니다. **변경 불필요.**

이것만 추가로 문서화한다면 유용할 수 있습니다:

```ts
// src/agent/mcp-manager.ts top of file, just below the ADARIA_HOME import
// Tests that need to redirect $ADARIA_HOME must set it BEFORE the first
// `await import("../../src/agent/mcp-manager.js")` — this module captures
// ADARIA_HOME via paths.ts at load time, matching the convention used by
// session.ts, logger.ts, and audit.ts.
```

### I2. 사용자 질문 #4 — `checkMcpServerHealth`의 async 시그니처는 유지할 것

사용자 질문:
> `checkMcpServerHealth()` is `async` but has a synchronous body (returns `Promise.resolve([])`). Is the async signature needed for M5.5 forward-compat, or should it be sync now and promoted later?

**async 유지 권장.** M5.5 구현은 반드시 서브프로세스와 IPC을 하게 됩니다 (stdio JSON-RPC `ping` 또는 `tools/list` 응답 대기). 이는 I/O-bound이므로 async가 필연. 지금 sync로 바꾸면:
- M5.5에서 다시 async로 승격하는 PR이 필요
- 호출부 (e.g. `doctor.ts`)가 `await`을 나중에 추가해야 함 — caller-facing breaking change
- 현재는 `Promise.resolve([])` 한 줄이라 비용 0

또한 `async` 메서드 본문에서 `return [];`만 써도 똑같이 작동하지만, 명시적 `Promise.resolve([])`는 "이게 async 자리를 차지하고 있다"는 의도를 시그널합니다. 작은 스타일 포인트로는:

```ts
async checkMcpServerHealth(): Promise<McpServerStatusResult[]> {
  // M5.5: spawn tool host with --health-check flag, wait for JSON-RPC
  // "pong" response, map result per registered tool. For now, nothing
  // to probe because no tools are registered.
  return [];
}
```

`Promise.resolve([])`가 딱히 해롭진 않지만 `async` 함수 안의 `return Promise.resolve(x)`는 관용적이지 않으므로 `return [];`로 줄이는 걸 추천. **변경은 optional.**

### I3. 사용자 질문 #5 — `process.execPath`의 npm global install 거동 확인

사용자 질문:
> `mcp-launcher.ts` uses `process.execPath` unconditionally. During M9 (`npm install -g adaria-ai` on a fresh Mac), will `process.execPath` point to the user's Node binary or to the adaria-ai bin shim? launchd inherits PATH-less env so this matters.

**`process.execPath`는 항상 Node 바이너리의 절대 경로**입니다. npm의 bin shim (`#!/usr/bin/env node` 혹은 `node dist/index.js` 호출)이 adaria-ai daemon을 시작시키는 경로는 다음과 같습니다:

1. launchd가 plist의 ProgramArguments를 실행 (예: `["/usr/local/bin/node", "/usr/local/lib/node_modules/adaria-ai/dist/index.js", "daemon"]`)
2. daemon 프로세스 내부에서 `process.execPath === "/usr/local/bin/node"` (Node 실행 파일의 절대 경로)
3. `buildToolHostServerConfig` 호출 → `command: "/usr/local/bin/node"`, `args: [entryPoint]`
4. Claude CLI가 이 config를 받아 `spawn("/usr/local/bin/node", [entryPoint])` — PATH-less env여도 절대 경로라 OK

단, `bin shim`이 중간에 어떻게 생겼는지에 따라 미묘한 차이가 있습니다:
- **npm이 만드는 shim은 보통 `#!/usr/bin/env node` + `require('...../dist/index.js')` 패턴이 아니라**, `nodejs/bin/node` 혹은 `node dist/index.js` 스크립트 wrapper입니다. 그 wrapper 자체가 쉘 스크립트라면 `process.execPath`는 그 쉘 wrapper가 아니라 wrapper 내부에서 exec된 실제 Node입니다 — 여전히 올바름.
- 반면 **launchd가 `plist`에서 bin shim을 직접 부른다면**, launchd → shim(쉘 스크립트) → node → daemon 경로가 됩니다. 이 경우 `process.execPath`는 세 번째 단계의 node이고 여전히 절대 경로 — 올바름.
- **단 하나의 엣지 케이스**: 사용자가 `nvm`으로 여러 버전의 node를 쓰는 경우, daemon이 시작될 때의 Node 버전과 Claude CLI가 spawn할 때 같은 Node 바이너리를 쓰게 됩니다. Claude CLI 측 스케줄링 시점의 Node 버전 mismatch가 생길 수 있는데, adaria-ai tool host가 package.json `engines: ">=20"`을 지키는 한 문제가 되진 않습니다.

**결론: `process.execPath` 사용은 올바름.** 다만 comment에 그 이유를 명확히 기록해두는 것을 권장합니다 (문제를 3년 뒤 디버깅할 때의 본인을 위해):

```ts
/**
 * Uses `process.execPath` (the absolute path to the currently running Node
 * binary) rather than `node` or `npx`. This is deliberate:
 *
 *   1. Launchd inherits a PATH-less environment, so `node` by bare name
 *      would not resolve.
 *   2. When adaria-ai is installed via `npm install -g`, launchd spawns the
 *      daemon via an absolute path, and `process.execPath` within that
 *      daemon points at the same Node binary. Using that value for the MCP
 *      subprocess guarantees version parity between daemon and tool host.
 *   3. `nvm` users with multiple installed Node versions get consistent
 *      behavior — whatever Node started the daemon also starts the tool
 *      host.
 */
export function buildToolHostServerConfig(...
```

### I4. `buildMcpContext` 시스템 프롬프트 문구 — 프롬프트 인젝션 관점에서 문구 자체는 OK지만 M5.5 때 한 번 더 보기

현재 문구는:

```
MCP TOOLS AVAILABLE:
These are read-only marketing tools. Use them to answer questions about apps, rankings, reviews, and prior analyses. They CANNOT write to the database or trigger skill write paths.

- mcp__adaria__<id> — <description>
```

M1 시점에 `<description>`이 하드코딩 literal이므로 사용자 입력이 시스템 프롬프트에 반사될 경로는 없습니다 — 안전. M5.5에서 tool description을 동적으로 생성하는 방식(예: apps.yaml의 앱 이름을 description에 끼워 넣기)을 도입하면 **해당 입력의 prompt-guard 처리가 추가로 필요**합니다. M5.5 리뷰 때 다시 체크할 것.

또한 "They CANNOT write" 선언은 Claude에게 주는 **기대값**이지 **강제**가 아닙니다. 실제 쓰기 차단은 tool host의 handler에서 보장해야 합니다. `.claude/agents/senior-code-reviewer.md:210-211`의 "Read-only enforcement: Every tool implementation must reject any input that could cause a write. Verify at the code level, not trust-based." 규약 준수는 M5.5의 tool implementation PR 리뷰 몫입니다.

---

## Data Flow Issues

### 현재 스코프: 없음

M1에서 `mcp-manager`/`mcp-launcher`는 어느 모듈에서도 import되지 않습니다 (`Grep` 확인: `src/index.ts`, `src/agent/*.ts` 아무 것도 쓰지 않음). 타입 정의 + 미사용 클래스 상태입니다. 이는 의도적이고 M1 exit criteria에 부합합니다.

M3/M4에서 core.ts가 포트되면 데이터 경로는:

```
daemon boot
  └─ loadConfig() → ensureAdariaDir()
  └─ const manager = new McpManager()          ← 옵션 A에서는 McpManager 인스턴스화 불필요
       registerTool(...) × 4                    ← M5.5가 여기서 4개 등록
  └─ core.handleMessage(slackEvent)
       ├─ Mode A command match → skill
       └─ Mode B no match
            └─ const mcpConfigPath = await manager.writeMcpConfig();
                 if (mcpConfigPath !== null) args.push('--mcp-config', mcpConfigPath);
            └─ spawn('claude', args, ...)
                 └─ Claude 프로세스가 mcpServers.adaria 서브프로세스를 직접 spawn
                      └─ tool host 프로세스 (dist/tool-host.js)
                           └─ McpManager 재-인스턴스화
                           └─ 같은 descriptor 모듈 import
                           └─ JSON-RPC dispatch loop
```

H1에서 지적한 책임 경계 문제는 이 그림을 보면 즉시 명확해집니다: daemon의 McpManager와 tool host의 McpManager는 **별개 프로세스의 별개 객체**이므로, daemon이 `registerTool`을 한다면 그건 "이 툴 이름이 존재한다"는 메타데이터를 위해서지 handler 호출을 위해서가 아닙니다. handler 필드는 구조적으로 tool host 쪽에만 속합니다.

---

## Two-mode Routing Integrity

N/A — `src/agent/core.ts`, `src/skills/`, `src/tools/`가 이 PR 스코프에 없음. M3/M4 core.ts 포트 PR과 M5 skill registry PR에서 Mode A dispatch + Mode B fall-through를 검증합니다. 다만 M1에서 H1/M1을 해결해두면 M3/M4/M5.5 리뷰가 훨씬 덜 까칠해집니다.

---

## Positive Observations

1. **축소 결정 자체가 옳음.** 472 LOC → 158 LOC, 187 LOC → 47 LOC. Pilot-ai 코드의 70-80%는 adaria-ai에 의미가 없고, 축소 후에도 M5.5가 쓸 핵심 표면(`McpToolDescriptor`, `buildMcpContext`, `buildMcpConfig`, `writeMcpConfig`, 서브프로세스 spawn 스펙)이 전부 잡혀 있습니다.
2. **`ADARIA_HOME` import 패턴이 스토리지 레이어와 일관됨.** 기존 `session.ts`/`logger.ts`/`audit.ts`와 같은 방식으로 top-level 상수를 `paths.ts`에서 import하므로 테스트 패턴이 호환됩니다.
3. **`writeMcpConfig`의 `mode: 0o600`.** 시크릿이 들어가지 않더라도 defensive하게 유지한 것은 좋은 습관입니다.
4. **M1 스코프를 정확히 준수.** 두 파일 모두 아무 호출부가 없고, daemon 부팅 시 어느 모듈에서도 import되지 않으며, 빈 상태가 "daemon boots with zero tools registered"라는 M1 exit criterion을 충족합니다.
5. **JSDoc에 pilot-ai와의 대비를 명시.** 두 파일 상단 주석이 "pilot-ai는 X를 하지만 adaria-ai는 Y가 필요 없다"를 설명해 미래 리뷰어가 차이를 파악하기 쉽게 만들었습니다. 특히 `mcp-launcher.ts:4-15`는 나중에 이 파일을 처음 읽는 사람에게 맥락을 그대로 전달합니다.
6. **`process.execPath` 선택.** `npx`나 `node` bare name이 아니라 현재 실행 중인 Node 바이너리의 절대 경로를 쓰는 것은 launchd inherits no PATH 제약과 npm global install 경로를 모두 만족하는 유일한 올바른 선택입니다 (I3 참조).
7. **Tool id prefix convention**: `mcp__adaria__<id>`가 pilot-ai의 `mcp__<server>__<tool>` 패턴과 호환되어, M5.5에서 Claude가 tool 이름을 파싱하는 로직이 pilot-ai의 실전 검증된 경로와 같습니다.

---

## Action Items

**이 PR 내에서 처리 권장 (H1, M1, M2를 같은 커밋에 묶기):**

- [ ] **H1 (HIGH)** `McpToolDescriptor`와 `McpToolImplementation`을 분리. daemon 쪽은 descriptor-only 경로 (`buildMcpContextFor`, `buildMcpConfigFor` 함수형 helper), `McpManager` 클래스는 tool host 런타임 전용으로 역할을 명시. JSDoc에 프로세스 경계 다이어그램 추가. 또는 open-questions.md에 "MCP tool host: 옵션 A (bundled subprocess) vs 옵션 B (no subprocess)" 결정 등록 후 M5.5로 미루기.
- [ ] **M1 (MEDIUM)** `buildMcpConfig()` 리턴 타입을 `McpConfigFile | null`로 변경. `writeMcpConfig()`도 `Promise<string | null>`로. 호출 규약을 JSDoc에 명시: "null이면 `--mcp-config` 플래그 생략". `checklist.md` M3 섹션에 "core.ts 포트시 `writeMcpConfig` → null 분기 처리" 한 줄 추가.
- [ ] **M2 (MEDIUM)** `docs/growth-agent/porting-matrix.md:29-30`의 두 줄을 🟢 copy → 🟡 adapt로 변경. Notes 칸에 축소 이유(472→158, 187→47)와 드롭된 기능군(Keychain wrapper, npx install, Claude Code sync) 기록. `docs/growth-agent/checklist.md:83-84`에도 deviation 노트 추가.

**Low / Info (선택):**

- [ ] **L1 (LOW)** `reset()` 제거하거나 JSDoc 보강. H1 리팩터 후 자연스럽게 불필요해질 가능성 높음.
- [ ] **L2 (LOW)** `open-questions.md`에 "MCP tool input validation: Zod vs ajv vs bare JSON Schema" 등록. M5.5 전에 결정.
- [ ] **I1** `mcp-manager.ts` 상단에 "eager ADARIA_HOME import — 테스트는 import 전에 env 세팅" 코멘트 한 줄 (스토리지 레이어 관례 명시).
- [ ] **I2** `checkMcpServerHealth()` 본문의 `return Promise.resolve([])`를 `return []`로 간소화 + M5.5 placeholder 코멘트.
- [ ] **I3** `buildToolHostServerConfig`에 `process.execPath` 선택 이유 JSDoc 추가 (launchd PATH-less, nvm 호환, npm global install 경로).

**미래 리뷰에서 재확인 (지금 액션 필요 없음):**

- [ ] **M3/M4 core.ts 포트 PR 리뷰**: `writeMcpConfig()`가 null일 때 `--mcp-config` 플래그 생략이 실제로 구현되었는지 확인.
- [ ] **M5.5 tool PR 리뷰**: tool host 서브프로세스가 descriptor 모듈을 re-import하는 경로가 코드로 표현되는지 확인. 4개 tool 모두 `inputSchema` 기반 reject 테스트가 있는지. `db-query`의 테이블 whitelist가 구현 레벨에서 강제되는지.
- [ ] **M5.5 tool-descriptions.ts PR 리뷰**: `description` 문자열에 사용자 입력(apps.yaml 필드 등) 반사가 없는지 — prompt injection 벡터 차단.

---

## Severity Counts (핵심 답변)

- **CRITICAL**: 0
- **HIGH**: 1 (H1 — `handler` 필드의 프로세스 경계 책임 불명)
- **MEDIUM**: 2 (M1 — 빈 mcp-config 처리 / M2 — porting-matrix 분류 불일치)
- **LOW**: 2
- **INFO**: 4

**M1 진행 가능 여부**: 네, H1을 "타입 분리 + JSDoc 경계 명시"로 해결하면 M1 exit criteria(daemon boots with zero tools, `buildMcpContext()` returns '')를 여전히 만족합니다. H1을 open-questions.md 등록으로 미루는 것도 허용 가능하지만 그 경우 이 PR 병합 전에 질문이 반드시 닫혀 있어야 합니다.

**아키텍처 결정에 대한 최종 판단**: **승인.** 472 LOC를 verbatim 복사하는 것은 오답이었습니다. 158 LOC 스켈레톤은 M5.5가 필요로 할 표면을 정확히 잡았고, pilot-ai 코드의 대부분은 adaria-ai 도메인에서 데드 코드입니다. 다만 porting-matrix를 고쳐 deviation을 문서화하는 것이 "drift without approval" 규약 준수를 위해 필요합니다.
