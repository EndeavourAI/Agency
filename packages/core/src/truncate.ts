/**
 * Tool output truncation. Oversized tool results are the single biggest
 * source of silent context-window waste, so every result flowing back into
 * the conversation goes through these caps at the `runTools` seam in
 * loop.ts. Both caps are configurable per call; the constants are the
 * session-wide defaults.
 */

/** Hard cap on a single tool result's size, in UTF-8 bytes. */
export const TRUNCATE_MAX_BYTES = 50_000;

/** Hard cap on a single tool result's line count. */
export const TRUNCATE_MAX_LINES = 2_000;

/** A quarter of a cut result is its end, as Codex keeps head and tail: the error of a build or a run is there. */
const TAIL_SHARE = 0.25;

/** The text cut to both caps with a notice where the middle went, or undefined when it fits. */
function cut(content: string, maxBytes: number, maxLines: number, label: string): string | undefined {
  const lines = content.split("\n");
  let out = content;
  let cutAny = false;

  if (lines.length > maxLines) {
    const tail = Math.floor(maxLines * TAIL_SHARE);
    out = [
      ...lines.slice(0, maxLines - tail),
      `[${label} truncated: ${lines.length - maxLines} lines omitted here]`,
      ...lines.slice(lines.length - tail),
    ].join("\n");
    cutAny = true;
  }

  const bytes = Buffer.from(out, "utf8");
  if (bytes.length > maxBytes) {
    const tailBytes = Math.floor(maxBytes * TAIL_SHARE);
    const head = sliceAtCharBoundary(bytes, maxBytes - tailBytes);
    let start = bytes.length - tailBytes;
    while (start < bytes.length && ((bytes.at(start) ?? 0) & 0xc0) === 0x80) start += 1;
    const omitted = bytes.length - Buffer.byteLength(head) - (bytes.length - start);
    const tail = bytes.subarray(start).toString("utf8");
    out = `${head}\n[${label} truncated: ${omitted} bytes omitted here]${tail ? `\n${tail}` : ""}`;
    cutAny = true;
  }

  return cutAny ? out : undefined;
}

/**
 * Caps `content` at `maxLines` lines and `maxBytes` UTF-8 bytes, whichever
 * limit is hit first. A truncated result keeps its head and its end, with a
 * notice where the middle was cut; content within both limits is returned
 * untouched.
 */
export function truncateOutput(
  content: string,
  maxBytes: number = TRUNCATE_MAX_BYTES,
  maxLines: number = TRUNCATE_MAX_LINES,
): { content: string; truncated: boolean } {
  const out = cut(content, maxBytes, maxLines, "Output");
  return out === undefined ? { content, truncated: false } : { content: out, truncated: true };
}

/**
 * Truncates every tool result's content to the same caps. Successful results
 * carry the standard `[Output truncated: ...]` notice; error results keep
 * the identical caps but mark the cut as `[Error output truncated: ...]`
 * so a model can tell a truncated failure apart from a truncated success.
 * Results within both limits are passed through unchanged, images included.
 */
export function truncateToolResults<
  T extends { content: string; isError?: boolean; images?: Array<unknown> },
>(results: Array<T>, maxBytes: number = TRUNCATE_MAX_BYTES, maxLines: number = TRUNCATE_MAX_LINES): Array<T> {
  return results.map((result) => {
    const out = cut(result.content, maxBytes, maxLines, result.isError ? "Error output" : "Output");
    return out === undefined ? result : { ...result, content: out };
  });
}

/**
 * Cuts a UTF-8 buffer to at most `maxBytes` bytes without splitting a
 * character: any continuation bytes (10xxxxxx) at the cut point are walked
 * back to the start of the containing character.
 */
function sliceAtCharBoundary(buf: Buffer, maxBytes: number): string {
  let end = Math.min(maxBytes, buf.length);
  while (end > 0) {
    const byte = buf.at(end);
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return buf.subarray(0, end).toString("utf8");
}
