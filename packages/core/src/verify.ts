import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Message } from "@agency/schema";
import { coveringTests, readTestMap, type TestMap } from "./testmap.ts";

const EDIT_TOOLS = new Set(["edit", "write", "notebook_edit"]);
const TEST_COMMAND =
  /\b(?:bun|npm|pnpm|yarn|npx|vitest|jest|pytest|go|cargo|deno)\b.*\btest\b|\bvitest\b|\bjest\b|\bpytest\b/;
const TEST_FILE_ARG = /\.(?:test|spec)\.|_test\.|\btest_\w/;
const RELATIVE_IMPORT = /(?:from\s+|import\s+|require\(\s*|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
const MAX_LISTED = 5;
const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

const withoutExtension = (path: string): string => path.replace(/\.[cm]?[jt]sx?$/, "");

/** The test files that git tracks: a repository with none, or no git, gets no check. */
function trackedTests(root: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", "*.test.*", "*.spec.*", "*_test.*", "test_*"], {
      cwd: root,
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter(Boolean).slice(0, 5_000);
  } catch {
    return [];
  }
}

/**
 * Unrun tests that ran a changed line, by the `agency testmap` map; with none, the importers one or two hops away.
 * ponytail: the graph reads relative JS/TS imports only; a Python or Go test of a changed file goes unnamed.
 */
export function untestedEdits(
  turn: Message[],
  root: string,
  map: TestMap | undefined = readTestMap(root),
): string[] {
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const edited = new Set<string>();
  const commands: string[] = [];
  for (const message of turn) {
    for (const block of message.content) {
      if (block.type === "tool_call") calls.set(block.id, block);
      if (block.type !== "tool_result") continue;
      const call = calls.get(block.toolCallId);
      // A failing test command still ran the tests.
      if (call?.name === "bash") commands.push(String(call.input.command ?? ""));
      if (call === undefined || block.isError) continue;
      if (EDIT_TOOLS.has(call.name) && typeof call.input.path === "string") {
        const path = relative(root, resolve(root, call.input.path)).replace(/\\/g, "/");
        if (!path.startsWith("..") && !isAbsolute(path)) edited.add(path);
      }
    }
  }
  if (edited.size === 0) return [];
  const sources = new Set([...edited].map(withoutExtension));
  const imports = new Map<string, string[]>();
  /** What `file` imports by a relative path, from the root with no extension. */
  const importsOf = (file: string): string[] => {
    const cached = imports.get(file);
    if (cached !== undefined) return cached;
    const found: string[] = [];
    imports.set(file, found);
    let text = "";
    for (const extension of SOURCE_EXTENSIONS) {
      try {
        text = readFileSync(join(root, file + extension), "utf8");
        break;
      } catch {}
    }
    for (const [, spec] of text.matchAll(RELATIVE_IMPORT))
      found.push(
        withoutExtension(relative(root, resolve(root, dirname(file), spec ?? "")).replace(/\\/g, "/")),
      );
    return found;
  };
  const tests = commands.filter((command) => TEST_COMMAND.test(command));
  const ran = (test: string): boolean =>
    tests.some((command) => {
      const name = test.split("/").at(-1) ?? test;
      // A run with no test file named runs a whole suite or folder: it counts for each test.
      return command.includes(name) || !TEST_FILE_ARG.test(command);
    });
  const all = trackedTests(root);
  // Live: 28 tests import render.ts, and few of them run the lines of a change in it.
  const covering = map === undefined ? undefined : coveringTests(map, root, [...edited]);
  if (covering !== undefined) {
    const named = new Set(covering);
    return [
      ...all.filter((test) => edited.has(test) && !ran(test)),
      ...all.filter((test) => named.has(test) && !edited.has(test) && !ran(test)),
    ];
  }
  // A file whose own test ran is tested: live, a list of 28 far tests had a model search four replies for the ones
  // that mattered after it had run the test of the file that it changed.
  for (const test of all.filter(ran)) for (const file of importsOf(test)) sources.delete(file);
  // Live: the test that a changed grep.ts broke imported it through builtin-set.ts, two hops away.
  const hops = (test: string): number => {
    if (edited.has(test)) return 0;
    const direct = importsOf(test);
    if (direct.some((file) => sources.has(file))) return 1;
    return direct.some((file) => importsOf(file).some((next) => sources.has(next))) ? 2 : 3;
  };
  return all
    .filter((test) => !ran(test))
    .map((test) => ({ test, hops: hops(test) }))
    .filter(({ hops }) => hops < 3)
    .sort((a, b) => a.hops - b.hops)
    .map(({ test }) => test);
}

/** The note for the model: the first tests by name, the folders of the rest, as running a folder runs them all. */
export function untestedNote(unrun: string[]): string {
  const rest = unrun.slice(MAX_LISTED);
  const folders = [...new Set(rest.map((test) => dirname(test).replace(/\\/g, "/")))];
  const more = rest.length === 0 ? "" : ` and ${rest.length} more in ${folders.join(", ")}`;
  return `[harness: these tests import a file that you changed in this turn, and no command of this turn ran them: ${unrun.slice(0, MAX_LISTED).join(", ")}${more}. Run them before you finish, or say why they need not run.]`;
}
