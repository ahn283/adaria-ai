/**
 * Tool description text injected into the Mode B system prompt.
 *
 * M5.5 fills this in with detailed descriptions of the 4 marketing MCP
 * tools (`db-query`, `collector-fetch`, `skill-result`, `app-info`) so
 * Claude knows exactly how to call them. M1 ships a stub that returns
 * an empty string — the `core.ts` caller is already wired to concatenate
 * the result into the system prompt unconditionally, so filling this in
 * later is a one-file change.
 */
export function buildToolDescriptions(): string {
  return "";
}
