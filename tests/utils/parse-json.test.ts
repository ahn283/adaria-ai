import { describe, it, expect } from "vitest";
import { parseJsonResponse } from "../../src/utils/parse-json.js";

describe("parseJsonResponse", () => {
  it("parses plain JSON object", () => {
    expect(parseJsonResponse('{"a": 1}')).toEqual({ a: 1 });
  });

  it("parses plain JSON array", () => {
    expect(parseJsonResponse("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("extracts JSON from surrounding prose", () => {
    const text = 'Here is the result: {"score": 42, "verdict": "good"} — done.';
    expect(parseJsonResponse(text)).toEqual({ score: 42, verdict: "good" });
  });

  it("extracts JSON from a markdown code fence", () => {
    const text = '```json\n{"fenced": true}\n```';
    expect(parseJsonResponse(text)).toEqual({ fenced: true });
  });

  it("handles nested objects", () => {
    const text = 'result: {"outer": {"inner": [1, 2]}}';
    expect(parseJsonResponse(text)).toEqual({ outer: { inner: [1, 2] } });
  });

  it("handles strings containing brackets", () => {
    const text = '{"text": "this has { and [ inside"}';
    expect(parseJsonResponse(text)).toEqual({
      text: "this has { and [ inside",
    });
  });

  it("handles escaped quotes inside strings", () => {
    const text = '{"msg": "he said \\"hi\\""}';
    expect(parseJsonResponse(text)).toEqual({ msg: 'he said "hi"' });
  });

  it("returns fallback when text is null", () => {
    expect(parseJsonResponse(null, { fallback: true })).toEqual({
      fallback: true,
    });
  });

  it("returns fallback when text is empty", () => {
    expect(parseJsonResponse("", "FALLBACK")).toBe("FALLBACK");
  });

  it("returns null fallback by default on unparseable input", () => {
    expect(parseJsonResponse("no brackets here at all")).toBeNull();
  });

  it("returns fallback when brackets are unbalanced", () => {
    expect(parseJsonResponse("{unbalanced: ")).toBeNull();
  });

  it("picks the first valid JSON structure when multiple are present", () => {
    const text = 'first: {"n": 1} and second: {"n": 2}';
    expect(parseJsonResponse(text)).toEqual({ n: 1 });
  });

  it("prefers a direct parse over extraction when whole text is JSON", () => {
    expect(parseJsonResponse('{"whole": "document"}')).toEqual({
      whole: "document",
    });
  });
});
