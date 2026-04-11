import { describe, it, expect, vi } from "vitest";
import {
  parseStreamEvent,
  parseClaudeJsonOutput,
  DEFAULT_TIMEOUT_MS,
  getClaudeCircuitState,
  checkClaudeCli,
} from "../../src/agent/claude.js";

describe("claude.ts", () => {
  describe("DEFAULT_TIMEOUT_MS", () => {
    it("is 120 seconds (reactive Slack default)", () => {
      expect(DEFAULT_TIMEOUT_MS).toBe(120_000);
    });
  });

  describe("parseClaudeJsonOutput", () => {
    it("returns empty-stream output verbatim when input is empty", () => {
      expect(parseClaudeJsonOutput("")).toBe("");
    });

    it("joins text blocks from legacy assistant messages", () => {
      const stream = [
        JSON.stringify({
          type: "assistant",
          content: [
            { type: "text", text: "hello " },
            { type: "text", text: "world" },
          ],
        }),
      ].join("\n");
      expect(parseClaudeJsonOutput(stream)).toBe("hello \nworld");
    });

    it("joins text blocks from stream-json wrapped messages", () => {
      const stream = JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "streamed answer" }],
        },
      });
      expect(parseClaudeJsonOutput(stream)).toBe("streamed answer");
    });

    it("captures terminal result messages", () => {
      const stream = JSON.stringify({
        type: "result",
        result: "final text",
      });
      expect(parseClaudeJsonOutput(stream)).toBe("final text");
    });

    it("falls back to raw text on non-JSON lines", () => {
      expect(parseClaudeJsonOutput("not json")).toBe("not json");
    });

    it("ignores tool_use blocks in the text result", () => {
      const stream = JSON.stringify({
        type: "assistant",
        content: [
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
          { type: "text", text: "result text" },
        ],
      });
      expect(parseClaudeJsonOutput(stream)).toBe("result text");
    });
  });

  describe("parseStreamEvent", () => {
    it("fires onToolUse for assistant tool_use blocks (legacy format)", () => {
      const onToolUse = vi.fn();
      parseStreamEvent(
        {
          type: "assistant",
          content: [
            { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
          ],
        },
        onToolUse,
      );
      expect(onToolUse).toHaveBeenCalledTimes(1);
      expect(onToolUse.mock.calls[0]?.[0]).toContain("Running");
    });

    it("fires onToolUse for stream-json wrapped assistant blocks", () => {
      const onToolUse = vi.fn();
      parseStreamEvent(
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Read",
                input: { file_path: "/tmp/foo" },
              },
            ],
          },
        },
        onToolUse,
      );
      expect(onToolUse).toHaveBeenCalledWith(
        expect.stringContaining("Reading file"),
      );
    });

    it("strips the mcp__adaria__ prefix in user-facing tool labels", () => {
      const onToolUse = vi.fn();
      parseStreamEvent(
        {
          type: "assistant",
          content: [
            {
              type: "tool_use",
              name: "mcp__adaria__db-query",
              input: { table: "reviews" },
            },
          ],
        },
        onToolUse,
      );
      expect(onToolUse).toHaveBeenCalledWith(
        expect.stringContaining("db-query"),
      );
      expect(onToolUse.mock.calls[0]?.[0]).not.toContain("mcp__adaria__");
    });

    it("fires onThinking for content_block_delta thinking events", () => {
      const onThinking = vi.fn();
      parseStreamEvent(
        {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "pondering..." },
        },
        undefined,
        onThinking,
      );
      expect(onThinking).toHaveBeenCalledWith("pondering...");
    });

    it("ignores events with no callbacks attached", () => {
      expect(() =>
        parseStreamEvent({ type: "assistant", content: [] }),
      ).not.toThrow();
    });

    it("does not fire onToolUse for plain text blocks", () => {
      const onToolUse = vi.fn();
      parseStreamEvent(
        {
          type: "assistant",
          content: [{ type: "text", text: "hi" }],
        },
        onToolUse,
      );
      expect(onToolUse).not.toHaveBeenCalled();
    });
  });

  describe("getClaudeCircuitState", () => {
    it("returns one of the circuit-breaker states", () => {
      expect(["CLOSED", "OPEN", "HALF_OPEN"]).toContain(
        getClaudeCircuitState(),
      );
    });
  });

  describe("checkClaudeCli", () => {
    it("returns false when the binary does not exist", async () => {
      expect(await checkClaudeCli("definitely-not-a-binary-xyz")).toBe(false);
    });
  });
});
