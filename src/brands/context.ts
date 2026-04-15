import { formatBrandContext, loadBrandProfile } from "./loader.js";

/**
 * Resolve `{{brandContext}}` for a skill run. Async I/O so the loader
 * stays file-based; callers should await once per dispatch (or once
 * per app in the weekly orchestrator) and reuse the string across all
 * `preparePrompt` calls for that app.
 *
 * Returns an empty string when no `brand.yaml` exists so existing
 * skill tests (which do not stage profile fixtures) remain green.
 */
export async function resolveBrandContextForApp(
  appId: string,
): Promise<string> {
  try {
    const profile = await loadBrandProfile(appId);
    return formatBrandContext(profile);
  } catch {
    // Invalid yaml or disk errors — fall back to empty rather than
    // regressing a skill run just because one app's profile is broken.
    return "";
  }
}
