import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const MAX_FILES = 4;
const MAX_BYTES = 1_000_000;
/** A path with an extension as a prompt names a file (`src/a.ts`, `./a.ts`, `README.md`); none inside a URL. */
const PATH = /(?<![\w./\\:-])(?:\.{1,2}[\\/])?(?:[\w.-]+[\\/])*[\w-][\w.-]*\.[A-Za-z0-9]+/g;

/** The files of the workspace that `text` names, from the root with forward slashes, once each. */
export function namedFiles(text: string, root: string): string[] {
  const found: string[] = [];
  for (const [token] of text.matchAll(PATH)) {
    const path = relative(root, resolve(root, token)).replace(/\\/g, "/");
    if (path === "" || path.startsWith("..") || isAbsolute(path) || found.includes(path)) continue;
    try {
      const stat = statSync(resolve(root, path));
      if (!stat.isFile() || stat.size > MAX_BYTES) continue;
    } catch {
      continue;
    }
    found.push(path);
    if (found.length === MAX_FILES) break;
  }
  return found;
}
