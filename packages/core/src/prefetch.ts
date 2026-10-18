import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const MAX_FILES = 4;
const MAX_BYTES = 1_000_000;
/** A path with an extension as a prompt names a file (`src/a.ts`, `./a.ts`, `README.md`); none inside a URL. */
const PATH = /(?<![\w./\\:-])(?:\.{1,2}[\\/])?(?:[\w.-]+[\\/])*[\w-][\w.-]*\.[A-Za-z0-9]+/g;
const TEST_FILE = /(?:\.(?:test|spec)\.|_test\.|(?:^|\/)test_)[^/]*$/;
/** A relative import or require: `from "../src/a.ts"`, `require('./a')`. */
const RELATIVE_IMPORT = /(?:from\s+|require\(\s*|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"];

/** The path from the root when `path` is a file of the workspace that a read takes whole, else undefined. */
function workspaceFile(root: string, path: string): string | undefined {
  const name = relative(root, resolve(root, path)).replace(/\\/g, "/");
  if (name === "" || name.startsWith("..") || isAbsolute(name)) return undefined;
  try {
    const stat = statSync(resolve(root, name));
    return stat.isFile() && stat.size <= MAX_BYTES ? name : undefined;
  } catch {
    return undefined;
  }
}

/** The files that a test imports by a relative path: in each live debug session, the next read after the test. */
function testSubjects(root: string, test: string): string[] {
  let text: string;
  try {
    text = readFileSync(resolve(root, test), "utf8");
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const [, spec] of text.matchAll(RELATIVE_IMPORT)) {
    const base = `${dirname(test)}/${spec}`;
    const file = EXTENSIONS.map((ext) => workspaceFile(root, base + ext)).find((name) => name !== undefined);
    if (file !== undefined) found.push(file);
  }
  return found;
}

/** The files of the workspace that `text` names, and those that a named test imports, from the root, once each. */
export function namedFiles(text: string, root: string): string[] {
  const named: string[] = [];
  for (const [token] of text.matchAll(PATH)) {
    const file = workspaceFile(root, token);
    if (file !== undefined && !named.includes(file)) named.push(file);
  }
  const found = [...named];
  for (const test of named.filter((name) => TEST_FILE.test(name))) {
    for (const file of testSubjects(root, test)) if (!found.includes(file)) found.push(file);
  }
  return found.slice(0, MAX_FILES);
}
