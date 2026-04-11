/**
 * MCP launcher — minimal M1 skeleton.
 *
 * adaria-ai's Mode B tools are in-process code bundled with the package,
 * not external npm servers the user installs. That removes the main thing
 * pilot-ai's mcp-launcher handles: generating bash wrapper scripts that
 * resolve npx, pull Keychain secrets, and exec a third-party MCP server.
 *
 * What M1 actually needs is just a builder that, given the path to
 * adaria-ai's bundled tool-host entry point, produces the
 * `{ command, args, env? }` triple that `mcp-manager` drops into the
 * `mcpServers.adaria` slot of `mcp-config.json`. M5.5 will plug the real
 * tool-host script path in; until then this module exposes the type
 * contract plus a single helper.
 */

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ToolHostLaunchSpec {
  /** Absolute path to the Node entry point that runs the MCP tool server. */
  entryPoint: string;
  /** Extra args appended after the entry point. Usually empty for M1. */
  extraArgs?: string[];
  /** Non-secret env vars forwarded to the subprocess. */
  env?: Record<string, string>;
}

/**
 * Builds the `mcpServers.<id>` value that mcp-manager writes into the
 * config file consumed by `claude --mcp-config`.
 *
 * We launch the tool host with `process.execPath` rather than `npx`
 * because:
 *   1. launchd inherits a near-empty PATH, so `npx` may not resolve.
 *   2. `process.execPath` is always an absolute path to the currently
 *      running Node binary — no lookup, no reinstall.
 *   3. Global-install via npm + nvm multi-version stays consistent:
 *      whichever Node launched the daemon also launches the tool host.
 */
export function buildToolHostServerConfig(
  spec: ToolHostLaunchSpec,
): McpServerConfig {
  const config: McpServerConfig = {
    command: process.execPath,
    args: [spec.entryPoint, ...(spec.extraArgs ?? [])],
  };
  if (spec.env && Object.keys(spec.env).length > 0) {
    config.env = { ...spec.env };
  }
  return config;
}
