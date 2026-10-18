import { isAbsolute, relative } from "node:path";
import type { ContentBlock, Message } from "@agency/schema";

const PATH_KEYS = ["path", "file_path", "notebook_path", "cwd", "workdir"];

/**
 * The reply as the history keeps it: an absolute path inside the project written relative to it. The reply is new,
 * so no cached prefix changes; the tool still gets the path as sent.
 */
export function relativePaths(content: ContentBlock[], cwd: string | undefined): ContentBlock[] {
  if (cwd === undefined) return content;
  return content.map((block) => {
    if (block.type !== "tool_call") return block;
    let input = block.input;
    for (const key of PATH_KEYS) {
      const value = input[key];
      if (typeof value !== "string" || !isAbsolute(value)) continue;
      const inside = relative(cwd, value);
      if (inside.startsWith("..") || isAbsolute(inside)) continue;
      input = { ...input, [key]: inside.replace(/\\/g, "/") || "." };
    }
    return input === block.input ? block : { ...block, input };
  });
}

/**
 * Shows the first two replies of a turn, each one read-only call and nothing else, as one reply with both calls.
 * Only the history sent changes: the session keeps the replies as they came, so a next turn misses the cache once.
 */
export function foldFirstReads(
  messages: Message[],
  turnStart: number,
  results: Message,
  readOnly: (call: Extract<ContentBlock, { type: "tool_call" }>) => boolean,
): boolean {
  if (messages.slice(turnStart).filter((m) => m.role === "assistant").length !== 2) return false;
  const [first, firstResults, second] = messages.slice(-3);
  const single = (m: Message | undefined) =>
    m?.role === "assistant" &&
    m.content.length === 1 &&
    m.content[0]?.type === "tool_call" &&
    readOnly(m.content[0]);
  if (!single(first) || !single(second) || firstResults?.role !== "user") return false;
  if (!firstResults.content.every((block) => block.type === "tool_result")) return false;
  messages.splice(
    -3,
    3,
    { ...(first as Message), content: [...(first as Message).content, ...(second as Message).content] },
    { ...firstResults, content: [...firstResults.content, ...results.content] },
  );
  return true;
}
