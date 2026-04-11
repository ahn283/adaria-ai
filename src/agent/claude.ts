/**
 * Claude CLI runner.
 *
 * Ports pilot-ai's `src/agent/claude.ts` with four M1 adaptations:
 *
 *   1. Default timeout dropped from 15 min to 120 s. Reactive Slack
 *      mentions shouldn't block the daemon for 15 minutes. The weekly
 *      orchestrator (M6) passes `timeoutMs: 15 * 60 * 1000` explicitly.
 *   2. `cwd` parameter dropped — adaria-ai has no concept of projects.
 *   3. `DEFAULT_ALLOWED_TOOLS` export dropped — pilot-ai's code already
 *      notes it's unused (--dangerously-skip-permissions covers it), and
 *      adaria-ai doesn't register Bash/Read/Write tool *wrappers* either.
 *   4. `invokeClaudeApi` (Anthropic SDK fallback) dropped. The config
 *      schema keeps `mode: 'cli' | 'api'` for forward-compat, but M1
 *      ships only the CLI path. A later milestone will re-add the API
 *      fallback if we ever need it (so far the CLI has been adequate).
 *
 * Everything else — circuit breaker, stream-json parsing, tool-use
 * status callbacks, thinking deltas, session --resume, CLAUDECODE env
 * strip — is preserved.
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { CircuitBreaker } from "../utils/circuit-breaker.js";
import { error as logError } from "../utils/logger.js";
import { maskSecrets } from "./audit.js";

const execFileAsync = promisify(execFile);

/** Circuit breaker for Claude CLI invocations. */
const claudeCircuit = new CircuitBreaker({
  failureThreshold: 3,
  resetTimeout: 120_000,
});

export interface ClaudeCliOptions {
  prompt: string;
  systemPrompt?: string;
  mcpConfigPath?: string;
  timeoutMs?: number;
  onToolUse?: (status: string) => void;
  /** Thinking/reasoning deltas streamed as Claude produces them. */
  onThinking?: (text: string) => void;
  /** Start a new session with this UUID. */
  sessionId?: string;
  /** Resume an existing session by its UUID. */
  resumeSessionId?: string;
  /** Path or name of the Claude CLI binary (default: 'claude'). */
  cliBinary?: string;
  /** Max tool-use turns per invocation (maps to `--max-turns`). */
  maxTurns?: number;
}

export interface ClaudeCliResult {
  result: string;
  exitCode: number;
}

export interface ClaudeJsonMessage {
  type: string;
  subtype?: string;
  result?: string;
  content?: Array<{ type: string; text?: string }>;
  [key: string]: unknown;
}

/**
 * Default timeout for reactive Slack calls. The weekly orchestrator (M6)
 * overrides this to 15 minutes per call when running long analyses.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** Checks whether the Claude CLI binary is installed on PATH. */
export async function checkClaudeCli(binary = "claude"): Promise<boolean> {
  try {
    await execFileAsync("which", [binary]);
    return true;
  } catch {
    return false;
  }
}

/** Checks whether the Claude CLI is authenticated via `claude auth status`. */
export async function checkClaudeCliAuth(binary = "claude"): Promise<boolean> {
  try {
    const env = { ...process.env };
    delete env["CLAUDECODE"];
    const { stdout } = await execFileAsync(binary, ["auth", "status"], {
      timeout: 5_000,
      env,
    });
    return (
      stdout.includes('"loggedIn": true') || stdout.includes('"loggedIn":true')
    );
  } catch {
    return false;
  }
}

/** Maps Claude tool names to user-friendly status descriptions. */
function describeToolUse(
  toolName: string,
  input?: Record<string, unknown>,
): string {
  switch (toolName) {
    case "Bash": {
      const cmd =
        typeof input?.["command"] === "string"
          ? input["command"].slice(0, 60)
          : "";
      if (cmd.startsWith("gh ")) return `🔍 Checking GitHub... \`${cmd}\``;
      if (cmd.startsWith("git ")) return `📂 Checking git history...`;
      if (cmd.startsWith("curl ") || cmd.startsWith("wget "))
        return `🌐 Fetching URL...`;
      if (cmd.startsWith("npm ") || cmd.startsWith("npx "))
        return `📦 Running npm...`;
      return `⚡ Running: \`${cmd || "command"}\``;
    }
    case "Read":
      return `📖 Reading file...`;
    case "Write":
      return `✏️ Writing file...`;
    case "Edit":
    case "MultiEdit":
      return `✏️ Editing file...`;
    case "Glob":
      return `🔍 Searching files...`;
    case "Grep":
      return `🔍 Searching code...`;
    case "LS":
      return `📂 Listing directory...`;
    case "WebSearch": {
      const q =
        typeof input?.["query"] === "string"
          ? input["query"].slice(0, 50)
          : "";
      return q ? `🌐 Searching: "${q}"` : `🌐 Searching the web...`;
    }
    case "WebFetch":
      return `🌐 Fetching web page...`;
    case "Task":
      return `🧠 Delegating sub-task...`;
    case "NotebookRead":
    case "NotebookEdit":
      return `📓 Working with notebook...`;
    default:
      if (toolName.startsWith("mcp__adaria__")) {
        return `🔧 Using ${toolName.slice("mcp__adaria__".length)}...`;
      }
      return `🔧 Using ${toolName}...`;
  }
}

/** Exposes circuit-breaker state for `adaria-ai doctor` / health checks. */
export function getClaudeCircuitState(): ReturnType<CircuitBreaker["getState"]> {
  return claudeCircuit.getState();
}

/**
 * Invokes the Claude Code CLI as a subprocess.
 * Runs `claude -p --output-format stream-json` and parses the NDJSON
 * response. Protected by a circuit breaker to fail fast when the CLI is
 * unavailable or repeatedly crashing.
 */
export async function invokeClaudeCli(
  options: ClaudeCliOptions,
): Promise<ClaudeCliResult> {
  return claudeCircuit.execute(() => invokeClaudeCliInner(options));
}

async function invokeClaudeCliInner(
  options: ClaudeCliOptions,
): Promise<ClaudeCliResult> {
  const {
    prompt,
    systemPrompt,
    mcpConfigPath,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onToolUse,
    onThinking,
    sessionId,
    resumeSessionId,
    cliBinary = "claude",
    maxTurns,
  } = options;

  const args: string[] = [];

  // Session management: --resume takes precedence (continuing existing
  // session). --dangerously-skip-permissions: adaria-ai runs headless from
  // launchd — nobody is sitting at the terminal to approve CLI prompts.
  // Security is provided by the Slack allowlist (src/security/auth.ts)
  // and by ApprovalManager for write paths.
  if (resumeSessionId) {
    args.push(
      "-p",
      "--resume",
      resumeSessionId,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    );
  } else {
    args.push(
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    );
    if (sessionId) {
      args.push("--session-id", sessionId);
    }
  }

  if (systemPrompt) {
    args.push("--append-system-prompt", systemPrompt);
  }

  // NOTE: --allowedTools is intentionally NOT used.
  // --dangerously-skip-permissions already permits all tools.
  // Combining --allowedTools with bypass mode is buggy (GitHub #12232)
  // and can silently block MCP tools.

  if (maxTurns) {
    args.push("--max-turns", String(maxTurns));
  }

  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
  }

  // Prompt goes via stdin to avoid OS arg-length limits.

  return new Promise<ClaudeCliResult>((resolve, reject) => {
    const env = { ...process.env };
    delete env["CLAUDECODE"];

    const child = spawn(cliBinary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
      env,
    });

    child.stdin.write(prompt);
    child.stdin.end();

    let stdout = "";
    let stderr = "";
    let lineBuffer = "";

    child.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;

      if (onToolUse || onThinking) {
        lineBuffer += chunk;
        // Prevent unbounded buffer growth (max 1MB). Truncate to the
        // nearest newline boundary so we never hand half a JSON object
        // to `JSON.parse` — otherwise a single pathological long line
        // eats tool_use events for the rest of the stream (M1 claude
        // review MED #1).
        if (lineBuffer.length > 1_048_576) {
          const lastNl = lineBuffer.lastIndexOf("\n", 524_288);
          lineBuffer = lastNl >= 0 ? lineBuffer.slice(lastNl + 1) : "";
          logError(
            "[claude-cli] stream buffer overflow; dropped leading content",
          );
        }
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            parseStreamEvent(msg, onToolUse, onThinking);
          } catch {
            // Not valid JSON yet — skip.
          }
        }
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      // Mask secrets before writing to the disk log. Pilot-ai's plain
      // console.error didn't persist, but adaria-ai's logger writes to
      // $ADARIA_HOME/logs/ so an MCP server that dumps an auth header
      // in its stderr would land at-rest on disk (M1 claude review MED #2).
      for (const line of chunk.split("\n")) {
        if (line.trim()) {
          logError(`[claude-cli] ${maskSecrets(line)}`);
        }
      }
    });

    child.on("error", (err) => {
      reject(new Error(`Claude CLI execution failed: ${err.message}`));
    });

    child.on("close", (code) => {
      const exitCode = code ?? 1;

      if (exitCode !== 0 && !stdout) {
        reject(
          new Error(
            `Claude CLI error (exit ${String(exitCode)}): ${stderr || "Unknown error"}`,
          ),
        );
        return;
      }

      const result = parseClaudeJsonOutput(stdout);
      resolve({ result, exitCode });
    });
  });
}

/**
 * Parses one stream-json event and fires tool-use / thinking callbacks.
 * Handles both legacy json format (assistant messages) and the newer
 * stream-json format (`stream_event`).
 */
export function parseStreamEvent(
  msg: Record<string, unknown>,
  onToolUse?: (status: string) => void,
  onThinking?: (text: string) => void,
): void {
  if (msg["type"] === "assistant") {
    const topContent = (msg as ClaudeJsonMessage).content;
    const wrapped = msg["message"] as Record<string, unknown> | undefined;
    const nestedContent = wrapped?.["content"] as
      | ClaudeJsonMessage["content"]
      | undefined;
    const content = topContent ?? nestedContent;

    if (onToolUse && Array.isArray(content)) {
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b["type"] === "tool_use" && typeof b["name"] === "string") {
          onToolUse(
            describeToolUse(
              b["name"],
              b["input"] as Record<string, unknown> | undefined,
            ),
          );
        }
      }
    }
  }

  if (onThinking && msg["type"] === "content_block_delta") {
    const delta = msg["delta"] as Record<string, unknown> | undefined;
    if (
      delta?.["type"] === "thinking_delta" &&
      typeof delta["thinking"] === "string"
    ) {
      onThinking(delta["thinking"]);
    }
  }
}

/**
 * Parses Claude CLI stream-json output and extracts the final text result.
 * Supports both legacy json format and stream-json format.
 */
export function parseClaudeJsonOutput(output: string): string {
  const lines = output.trim().split("\n").filter(Boolean);
  const texts: string[] = [];

  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as ClaudeJsonMessage;

      // Legacy json format: assistant messages with content blocks.
      if (msg.type === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            texts.push(block.text);
          }
        }
      }

      // stream-json format: assistant message wrapper.
      if (msg.type === "assistant" && msg["message"]) {
        const message = msg["message"] as Record<string, unknown>;
        const content = message["content"] as
          | Array<{ type: string; text?: string }>
          | undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              texts.push(block.text);
            }
          }
        }
      }

      // Terminal result message (both formats).
      if (msg.type === "result" && typeof msg.result === "string") {
        texts.push(msg.result);
      }
    } catch {
      // Not JSON — treat as raw text.
      texts.push(line);
    }
  }

  return texts.join("\n") || output;
}
