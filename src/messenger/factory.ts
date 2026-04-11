/**
 * Messenger factory.
 *
 * adaria-ai v1 is Slack-only. The factory stays here (rather than
 * inlining `new SlackAdapter(...)` in `cli/daemon.ts`) so that when a
 * second platform ever lands, only this one file needs to grow a
 * switch, not every daemon entry point.
 */
import type { AdariaConfig } from "../config/schema.js";
import type { MessengerAdapter } from "./adapter.js";
import { SlackAdapter } from "./slack.js";

export function createMessengerAdapter(
  config: AdariaConfig,
): MessengerAdapter {
  return new SlackAdapter({
    botToken: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
  });
}
