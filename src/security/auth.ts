import type { IncomingMessage } from "../messenger/adapter.js";
import type { AdariaConfig } from "../config/schema.js";

/**
 * Check whether the message sender is allowed to talk to the bot.
 * Messages from non-allowlisted users are silently ignored (no response,
 * no reaction, no audit entry) per the growth-agent threat model — we do
 * not want to leak the bot's existence to unauthorized users.
 *
 * TODO: adaria-ai v1 is Slack-only. If a second platform (Telegram, etc)
 * is added, split `allowedUsers` into a per-platform map and branch on
 * `msg.platform` here. Do not assume user IDs are unique across platforms.
 */
export function isAuthorizedUser(
  msg: IncomingMessage,
  config: AdariaConfig
): boolean {
  return config.security.allowedUsers.includes(msg.userId);
}
