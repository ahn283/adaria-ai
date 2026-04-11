/**
 * Escapes a string for use inside AppleScript double-quoted strings.
 * Handles: backslash, double quotes, backticks, and $() subshell expressions.
 */
export function escapeAppleScript(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");
}

/**
 * Escapes a string for use as a POSIX shell argument.
 * Wraps in single quotes and handles embedded single quotes.
 */
export function escapeShellArg(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}
