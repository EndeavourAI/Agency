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
