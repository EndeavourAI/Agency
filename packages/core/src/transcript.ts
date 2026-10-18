import { isAbsolute, relative } from "node:path";
import type { ContentBlock } from "@agency/schema";

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
 * A read of several paths runs as one read a path, in the reply itself: each passes the rules, the sandbox, the
 * dedupe and the pruning of a read. The reply is new, so no cached prefix changes.
 */
export function expandReads(content: ContentBlock[]): ContentBlock[] {
  return content.flatMap((block) => {
    if (block.type !== "tool_call" || !isMultiRead(block)) return [block];
    const { paths, path, ...rest } = block.input;
    const all = [
      ...new Set([path, ...(paths as unknown[])].filter((p): p is string => typeof p === "string")),
    ];
    if (all.length === 0) return [block];
    return all.map((one, index) => ({ ...block, id: `${block.id}_${index}`, input: { ...rest, path: one } }));
  });
}

/** A read call that names several paths: it runs only once expanded, never as it streams. */
export function isMultiRead(call: { name: string; input: Record<string, unknown> }): boolean {
  return call.name === "read" && Array.isArray(call.input.paths);
}
