import { describe, it, expect } from "vitest";
import { splitMessage, MAX_MESSAGE_LENGTH } from "../../src/messenger/split.js";

describe("splitMessage", () => {
  it("returns the input verbatim when under the limit", () => {
    expect(splitMessage("hello", 1000)).toEqual(["hello"]);
  });

  it("splits on newline boundaries when possible", () => {
    const text = "line1\nline2\nline3\nline4\nline5";
    const chunks = splitMessage(text, 12);
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk exceeds the limit.
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(12);
    }
    // Reassembly without code-block fencing is lossless.
    expect(chunks.join("")).toBe(text);
  });

  it("falls back to space boundaries when no newline is nearby", () => {
    const text = "word1 word2 word3 word4 word5";
    const chunks = splitMessage(text, 12);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(12);
    }
  });

  it("closes and reopens code blocks across split boundaries", () => {
    const text =
      "intro\n```js\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```\noutro";
    const chunks = splitMessage(text, 25);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk should contain an even number of ``` markers once we
    // account for the continuation markers the splitter inserted —
    // otherwise Slack renders stray backticks.
    for (const chunk of chunks) {
      const count = (chunk.match(/```/g) ?? []).length;
      expect(count % 2).toBe(0);
    }
  });

  it("hard-cuts at maxLength when there's no whitespace to split on", () => {
    const text = "x".repeat(100);
    const chunks = splitMessage(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
  });

  it("Slack limit constant matches pilot-ai's 4000", () => {
    expect(MAX_MESSAGE_LENGTH.slack).toBe(4000);
  });
});
