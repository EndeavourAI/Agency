import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Message } from "@agency/schema";

const EDIT_TOOLS = new Set(["edit", "write", "notebook_edit"]);
const TEST_COMMAND =
  /\b(?:bun|npm|pnpm|yarn|npx|vitest|jest|pytest|go|cargo|deno)\b.*\btest\b|\bvitest\b|\bjest\b|\bpytest\b/;
const TEST_FILE_ARG = /\.(?:test|spec)\.|_test\.|\btest_\w/;
const RELATIVE_IMPORT = /(?:from\s+|require\(\s*|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
const MAX_LISTED = 5;

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
 * The tests that import a file that `turn` changed (or that it changed itself) and that no test command of the turn
 * ran. Imports by a relative path of JS and TS only.
 * ponytail: one import hop, JS/TS only; a Python or Go test of a changed file goes unnamed.
 */
export function untestedEdits(turn: Message[], root: string): string[] {
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
  const related = trackedTests(root).filter((test) => {
    if (edited.has(test)) return true;
    let text: string;
    try {
      text = readFileSync(join(root, test), "utf8");
    } catch {
      return false;
    }
    for (const [, spec] of text.matchAll(RELATIVE_IMPORT)) {
      const target = relative(root, resolve(root, dirname(test), spec ?? "")).replace(/\\/g, "/");
      if (sources.has(withoutExtension(target))) return true;
    }
    return false;
  });
  const tests = commands.filter((command) => TEST_COMMAND.test(command));
  const ran = (test: string): boolean =>
    tests.some((command) => {
      const name = test.split("/").at(-1) ?? test;
      // A run with no test file named runs a whole suite or folder: it counts for each test.
      return command.includes(name) || !TEST_FILE_ARG.test(command);
    });
  return related.filter((test) => !ran(test)).slice(0, MAX_LISTED);
}
