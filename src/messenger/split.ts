/**
 * Message splitting utility for messenger adapters.
 *
 * Platform limits and code-block continuity preservation come from
 * pilot-ai. Telegram is dropped — adaria-ai ships Slack only in v1.
 */

export const MAX_MESSAGE_LENGTH = {
  slack: 4000,
} as const;

/**
 * Splits a long message into chunks that fit within `maxLength`.
 * Preserves Markdown code blocks (```) across split boundaries by
 * closing them at the end of one chunk and reopening at the start
 * of the next.
 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    const splitAt = findSplitPoint(remaining, maxLength);
    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt);

    // If chunk ends mid-code-block, close it and reopen on the next chunk.
    const openBlocks = countCodeBlockMarkers(chunk);
    if (openBlocks % 2 === 1) {
      chunk += "\n```";
      remaining = "```\n" + remaining;
    }

    chunks.push(chunk);
  }

  return chunks;
}

/** Prefer line-boundary splits, then space, then hard cut. */
function findSplitPoint(text: string, maxLength: number): number {
  const lastNewline = text.lastIndexOf("\n", maxLength);
  if (lastNewline > maxLength * 0.5) {
    return lastNewline + 1;
  }
  const lastSpace = text.lastIndexOf(" ", maxLength);
  if (lastSpace > maxLength * 0.5) {
    return lastSpace + 1;
  }
  return maxLength;
}

/** Counts ``` markers. Odd count means the text ends inside a block. */
function countCodeBlockMarkers(text: string): number {
  const matches = text.match(/```/g);
  return matches ? matches.length : 0;
}
