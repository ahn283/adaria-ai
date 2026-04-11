/**
 * Safely extract and parse JSON from Claude text responses.
 * Uses bracket-matching instead of greedy regex to handle nested structures.
 *
 * Returns `unknown` — callers must narrow via type guards or schema validation.
 *
 * Complexity note: the extraction path is O(n * k) where n is text length and
 * k is the cost of rescanning after a failed JSON.parse inside the nested loop.
 * Fine for typical Claude responses (<10KB) but revisit in M1e if we start
 * piping long agent transcripts through this (add max length guard first).
 */
export function parseJsonResponse(
  text: string | null | undefined,
  fallback: unknown = null
): unknown {
  if (!text) return fallback;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Fall through to extraction
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch !== "{" && ch !== "[") continue;

    const endCh = ch === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let j = i; j < text.length; j++) {
      const c = text.charAt(j);

      if (escape) {
        escape = false;
        continue;
      }

      if (c === "\\" && inString) {
        escape = true;
        continue;
      }

      if (c === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (c === ch) depth++;
      if (c === endCh) depth--;

      if (depth === 0) {
        try {
          return JSON.parse(text.slice(i, j + 1)) as unknown;
        } catch {
          break;
        }
      }
    }
  }

  return fallback;
}
