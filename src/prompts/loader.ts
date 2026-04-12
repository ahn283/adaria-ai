/**
 * Prompt template loader.
 *
 * Reads `.md` files from the bundled `prompts/` directory and performs
 * `{{variable}}` substitution. Template variables are double-braced to
 * avoid collision with Slack mrkdwn formatting.
 */

import fs from "node:fs";
import path from "node:path";
import { BUNDLED_PROMPTS_DIR } from "../utils/paths.js";

/**
 * Load a prompt template by name, substitute variables, and return the
 * final prompt string.
 *
 * @param name  Template name without extension (e.g. `"aso-metadata"`)
 * @param vars  Key-value pairs to substitute for `{{key}}` placeholders
 * @returns     Resolved prompt string
 * @throws      If the template file does not exist
 */
export function preparePrompt(
  name: string,
  vars: Record<string, string>,
): string {
  const filePath = path.join(BUNDLED_PROMPTS_DIR, `${name}.md`);
  let template = fs.readFileSync(filePath, "utf-8");

  for (const [key, value] of Object.entries(vars)) {
    template = template.replaceAll(`{{${key}}}`, value);
  }

  return template;
}
