import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cacheDir, workspaceId } from "./storage.ts";

/** Which tests ran which lines, at a commit: `files[path][test index]` holds ranges such as `1-14,20`. */
export interface TestMap {
  commit: string;
  tests: string[];
  files: Record<string, Record<string, string>>;
}

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

const git = (root: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });

export function testMapFile(root: string): string {
  return join(cacheDir(), "testmap", `${workspaceId(root)}.json`);
}

export function readTestMap(root: string): TestMap | undefined {
  try {
    return JSON.parse(readFileSync(testMapFile(root), "utf8")) as TestMap;
  } catch {
    return undefined;
  }
}

/** The lines that an lcov report saw run, by path from the root with forward slashes. */
export function parseLcov(text: string): Map<string, number[]> {
  const files = new Map<string, number[]>();
  let lines: number[] | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      lines = [];
      files.set(line.slice(3).trim().replace(/\\/g, "/"), lines);
    } else if (line.startsWith("DA:") && lines) {
      const [at, hits] = line.slice(3).split(",");
      if (Number(hits) > 0) lines.push(Number(at));
    }
  }
  return files;
}

function ranges(lines: number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i] as number;
    while (sorted[i + 1] === (sorted[i] as number) + 1) i++;
    out.push(start === sorted[i] ? `${start}` : `${start}-${sorted[i]}`);
  }
  return out.join(",");
}

const covers = (spans: string, line: number): boolean =>
  spans.split(",").some((span) => {
    const [from, to = from] = span.split("-").map(Number);
    return line >= (from as number) && line <= (to as number);
  });

/**
 * Runs each tracked test file alone under `bun test --coverage` and keeps the source lines that it ran. One run per
 * file is the only way to tell the tests apart: a coverage report of a whole run says what ran, not which test ran it.
 */
export async function buildTestMap(
  root: string,
  onTest?: (test: string, index: number, total: number) => void,
): Promise<TestMap> {
  const commit = git(root, ["rev-parse", "HEAD"]).trim();
  const tests = git(root, ["ls-files", "-z"])
    .split("\0")
    .filter((path) => TEST_FILE.test(path));
  const files: TestMap["files"] = {};
  const scratch = mkdtempSync(join(tmpdir(), "agency-testmap-"));
  try {
    for (const [index, test] of tests.entries()) {
      onTest?.(test, index, tests.length);
      const out = join(scratch, String(index));
      const run = Bun.spawn(
        ["bun", "test", "--coverage", "--coverage-reporter=lcov", "--coverage-dir", out, test],
        { cwd: root, stdout: "ignore", stderr: "ignore", windowsHide: true },
      );
      // ponytail: a fixed 2-minute limit a file. A slower suite gets no lines and is named by the import graph.
      const timer = setTimeout(() => run.kill(), 120_000);
      await run.exited;
      clearTimeout(timer);
      let report = "";
      try {
        report = readFileSync(join(out, "lcov.info"), "utf8");
      } catch {}
      for (const [path, lines] of parseLcov(report)) {
        if (
          lines.length === 0 ||
          TEST_FILE.test(path) ||
          path.startsWith("..") ||
          path.includes("node_modules/")
        )
          continue;
        files[path] ??= {};
        (files[path] as Record<string, string>)[index] = ranges(lines);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const map = { commit, tests, files };
  mkdirSync(dirname(testMapFile(root)), { recursive: true });
  writeFileSync(testMapFile(root), JSON.stringify(map));
  return map;
}

/**
 * The tests that ran a changed line, by each hunk's old lines (an insertion: both sides). Undefined when git fails,
 * a changed source is unmapped, or every changed line that ran is one that all tests of its file run (an import).
 */
export function coveringTests(map: TestMap, root: string, changed: string[]): string[] | undefined {
  const sources = changed.filter((path) => !TEST_FILE.test(path));
  if (sources.some((path) => map.files[path] === undefined)) return undefined;
  let diff: string;
  try {
    diff = git(root, ["diff", "-U0", "--no-color", "--no-ext-diff", map.commit, "--", ...sources]);
  } catch {
    return undefined;
  }
  const touched = new Map<Record<string, string>, number[]>();
  let file: Record<string, string> | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) file = map.files[line.slice(4).replace(/^a\//, "")];
    const hunk = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
    if (!hunk || file === undefined) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const lines = touched.get(file) ?? [];
    lines.push(...(count === 0 ? [start, start + 1] : Array.from({ length: count }, (_, i) => start + i)));
    touched.set(file, lines);
  }
  const found = new Set<string>();
  for (const [spansOf, lines] of touched) {
    const all = Object.keys(spansOf).length;
    // Live: an added import ran in each of 127 tests that load the file, the graph named 33 and the change needed 2.
    const runOf = (at: number) => Object.entries(spansOf).filter(([, spans]) => covers(spans, at));
    // Bun counts some statements with the line before: a `return` that ran can show as unrun.
    const ran = lines
      .map((at) => (runOf(at).length > 0 ? runOf(at) : runOf(at - 1)))
      .filter((tests) => tests.length > 0);
    const telling = ran.filter((tests) => all <= 2 || tests.length < all);
    if (telling.length === 0 && ran.length > 0) return undefined;
    for (const tests of telling) for (const [index] of tests) found.add(map.tests[Number(index)] as string);
  }
  return [...found];
}
