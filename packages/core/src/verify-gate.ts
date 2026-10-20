import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type AgencyEvents, type EventBus, HookBlock } from "./events.ts";

const EDIT_TOOLS = new Set(["edit", "write", "notebook_edit"]);
/** A change of prose, a page or data needs no check: live, a written index.html was sent back twice for none. */
const DOC_FILE = /\.(md|mdx|txt|rst|adoc|html?|css|csv|svg)$/i;
/** A command that checks code: a test run, type check, linter or build. A false match only spares the reminder. */
const CHECK_COMMAND =
  /\b(tests?|test_\w+|\w+_test|spec|pytest|jest|vitest|mocha|tsc|typecheck|type-check|lint|eslint|biome|ruff|flake8|mypy|pyright|clippy|check|build|compile|make|gradlew?|mvn|cargo|go\s+(?:test|vet|build)|dotnet|ctest|phpunit|rspec)\b/i;
const LISTED_FILES = 5;
/** A name at the root of a workspace that has checks: a project file, a test folder or a test file. */
const CHECK_INFRA =
  /^(package\.json|pyproject\.toml|setup\.(py|cfg)|tox\.ini|pytest\.ini|noxfile\.py|[Mm]akefile|GNUmakefile|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|CMakeLists\.txt|.+\.(csproj|sln)|Gemfile|composer\.json|deno\.jsonc?|tsconfig\.json|tests?|spec|__tests__|test_.+\.py|.+_test\.\w+|.+\.(test|spec)\.\w+)$/;

/** True when the root of `root` has something to check with; unreadable counts as yes. */
function hasChecks(root: string): boolean {
  try {
    return readdirSync(root).some((name) => CHECK_INFRA.test(name));
  } catch {
    return true;
  }
}

/** A command that runs `path` as a program: `python3 fetch.py`, `./run.sh`. Reading it (`cat`) is no run. */
function runsFile(command: string, path: string): boolean {
  const name = (path.split(/[\\/]/).at(-1) ?? path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:\\b(?:python3?|node|bun|deno|ruby|perl|php|bash|sh|Rscript|go\\s+run)(?:\\s+-\\S+)*\\s+|\\./)\\S*?\\b${name}(?![\\w.])`,
  ).test(command);
}

/** The reminder of a turn that changed code and ran no passing check after. */
export function verifyReminder(files: readonly string[]): string {
  const shown = files.slice(0, LISTED_FILES).join(", ");
  const more = files.length > LISTED_FILES ? ` and ${files.length - LISTED_FILES} more` : "";
  return (
    `You changed ${shown}${more} and ran no passing test, type check or build after. ` +
    "Run the checks of the project now and fix what fails. If no check applies, say so in one line and stop."
  );
}

/** The model's own word that it left a check out: "I did not run a chess engine to confirm this." */
const UNCHECKED =
  /\b(?:I|we)\s+(?:did not|didn't|could not|couldn't|was unable to|have not|haven't|cannot|can't)\s+(?:yet\s+)?(?:run|test|check|verify|confirm|validate|execute|compile|try)\b/i;

/** The sentence of `answer` that says a check was left out, if one does. */
export function uncheckedClaim(answer: string): string | undefined {
  return answer
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.replace(/^[\s*_>#-]+/, "").trim())
    .find((sentence) => UNCHECKED.test(sentence));
}

/** Live (Terminal-Bench, Haiku 5.5): 2 of 3 failed tasks ended with such a sentence and nearly all steps unused. */
export function doubtReminder(sentence: string): string {
  return (
    `Your answer says: "${sentence}" Do that check now with the tools, fix what it shows, ` +
    "then answer. If it cannot be done here, say why in one line and stop."
  );
}

/**
 * Verify before done, as a harness rule: a turn that changed code since its last passing check is sent back once
 * before it ends. Measured on SWT-Bench, keeping only patches that pass a check roughly doubled precision.
 */
export function attachVerifyGate(bus: EventBus, root?: string): () => void {
  // The files that each turn changed since its last passing check.
  const changed = new Map<string, Set<string>>();
  const reminded = new Set<string>();
  const doubted = new Set<string>();
  const offAfter = bus.on("tool.execute.after", (payload) => {
    const p = payload as AgencyEvents["tool.execute.after"];
    if (p.turnId === undefined || p.result.isError) return;
    const path = p.input.path;
    if (EDIT_TOOLS.has(p.tool) && typeof path === "string" && !DOC_FILE.test(path)) {
      const files = changed.get(p.turnId) ?? new Set<string>();
      changed.set(p.turnId, files.add(path));
    } else if (
      p.tool === "bash" &&
      typeof p.input.command === "string" &&
      CHECK_COMMAND.test(p.input.command)
    ) {
      changed.delete(p.turnId);
    } else if (p.tool === "bash" && typeof p.input.command === "string") {
      // Live: twice a model ran its changed script, saw the right output, and the reminder sent it back anyway.
      const files = changed.get(p.turnId);
      for (const file of files ?? []) if (runsFile(p.input.command, file)) files?.delete(file);
    }
  });
  const offStop = bus.on("turn.stop", (payload) => {
    const p = payload as AgencyEvents["turn.stop"];
    // A worker reports to its lead, which checks the whole change.
    if (p.turnId === undefined || p.taskDepth > 0) return;
    const unchecked = doubted.has(p.turnId) ? undefined : uncheckedClaim(p.lastAssistantMessage ?? "");
    if (unchecked !== undefined) {
      doubted.add(p.turnId);
      throw new HookBlock(doubtReminder(unchecked));
    }
    doubted.delete(p.turnId);
    const files = changed.get(p.turnId);
    // Live: in 6 of 12 headless runs with no tests or project file, the model spent calls to find no check.
    if (
      files === undefined ||
      files.size === 0 ||
      reminded.has(p.turnId) ||
      (root !== undefined && !hasChecks(root))
    ) {
      changed.delete(p.turnId);
      reminded.delete(p.turnId);
      return;
    }
    reminded.add(p.turnId);
    throw new HookBlock(verifyReminder([...files]));
  });
  return () => {
    offAfter();
    offStop();
  };
}

/** A test file by its name: `a.test.ts`, `a_test.go`, `test_a.py`, or a file under `tests/`, `spec/` or `__tests__/`. */
const TEST_PATH =
  /(?:^|[\\/])(?:tests?|spec|__tests__)[\\/]|\.(?:test|spec)\.\w+$|_test\.\w+$|(?:^|[\\/])test_\w+\.\w+$/;
/** A file that can tell the test runner to leave tests out. */
const RUNNER_CONFIG =
  /(?:^|[\\/])(?:pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini|conftest\.py|package\.json|(?:jest|vitest|karma|playwright)\.config\.\w+|\.mocharc\.\w+)$/;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
]);
const MAX_LISTED_PATHS = 50_000;
const MAX_SCANNED = 5_000;

/** Each kind of check that a test file holds; a change that lowers one (or raises a `less` one) weakens it. */
const KINDS = {
  tests: /\b(?:it|test)(?:\.\w+)?\s*\(|\bdef\s+test_|\bfunc\s+Test|#\[test\]|@Test\b|\[(?:Test|Fact)\]/g,
  assertions:
    /\b[Aa]ssert\w*|\bexpect\s*\(|\bt\.(?:Error|Fatal)f?\s*\(|\brequire\.\w+\s*\(|\.should\b|\bXCTAssert/g,
  skipped:
    /\.(?:skip|todo|only)\s*\(|\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(|@pytest\.mark\.(?:skip|xfail)|@unittest\.skip|\bpytest\.skip\s*\(|#\[ignore\]|\bt\.Skip\w*\s*\(|@Disabled\b|@Ignore\b|\[Ignore\]|\bpending\s*\(/g,
  "always true":
    /\bassert\s+(?:True|1)\b|\.toBeTruthy\(\)|\.toBeDefined\(\)|\bexpect\(\s*true\s*\)|\bassert!\(\s*true\s*\)/g,
  excluded:
    /--ignore\b|--deselect\b|\bcollect_ignore|testPathIgnorePatterns|\bexclude\s*[:=]|\bnorecursedirs\b/g,
} as const;
type Kind = keyof typeof KINDS;
type Counts = Record<Kind, number>;
type Scanned = { counts: Counts; hash: string };
const LESS: readonly Kind[] = ["tests", "assertions"];

function countsOf(text: string): Counts {
  const counts = {} as Counts;
  for (const kind of Object.keys(KINDS) as Kind[]) counts[kind] = text.match(KINDS[kind])?.length ?? 0;
  return counts;
}

/** Every path under `root`: git's list (tracked and new) in a repository, else a walk that skips build folders. */
function listFiles(root: string): string[] {
  try {
    return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 5_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter(Boolean);
  } catch {}
  const files: string[] = [];
  const dirs = [""];
  while (dirs.length > 0 && files.length < MAX_LISTED_PATHS) {
    const dir = dirs.pop() ?? "";
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) dirs.push(path);
      } else files.push(path);
    }
  }
  return files;
}

/** Each test file and runner config under `root`; an unchanged file comes from `cache`. ponytail: the first 5,000. */
function scanTests(root: string, cache: Map<string, Scanned & { stamp: string }>): Map<string, Scanned> {
  const scan = new Map<string, Scanned>();
  for (const path of listFiles(root)) {
    if (scan.size >= MAX_SCANNED) break;
    if (!TEST_PATH.test(path) && !RUNNER_CONFIG.test(path)) continue;
    try {
      const full = join(root, path);
      const { size, mtimeMs } = statSync(full);
      const stamp = `${size}:${mtimeMs}`;
      let file = cache.get(path);
      if (file?.stamp !== stamp) {
        const text = readFileSync(full, "utf8");
        file = { counts: countsOf(text), hash: createHash("sha1").update(text).digest("hex"), stamp };
        cache.set(path, file);
      }
      scan.set(path, file);
    } catch {}
  }
  return scan;
}

/** How a file checks less than it did, if it does. */
function weakening(before: Counts, after: Counts): string | undefined {
  const how = (Object.keys(KINDS) as Kind[]).flatMap((kind) => {
    const change = LESS.includes(kind) ? before[kind] - after[kind] : after[kind] - before[kind];
    return change > 0 ? [`${change} ${LESS.includes(kind) ? "fewer" : "more"} ${kind}`] : [];
  });
  return how.length === 0 ? undefined : how.join(", ");
}

/** The weakened files between two scans; a deleted file whose text a new file holds was moved, not dropped. */
export function weakenedTests(before: Map<string, Scanned>, after: Map<string, Scanned>): string[] {
  const added = new Set([...after].filter(([path]) => !before.has(path)).map(([, file]) => file.hash));
  return [...before].flatMap(([path, file]) => {
    const now = after.get(path);
    if (now === undefined) return added.has(file.hash) || !TEST_PATH.test(path) ? [] : [`${path} (deleted)`];
    const how = weakening(file.counts, now.counts);
    return how === undefined ? [] : [`${path} (${how})`];
  });
}

export function testGuardReminder(changes: readonly string[]): string {
  return (
    `You changed tests so that they check less: ${changes.join(", ")}. Unless the task asked for that, restore ` +
    "them and fix the code instead. If it did, say so in one line and stop."
  );
}

/**
 * A turn that weakened tests is sent back once: a model can make a check pass that way instead of fixing the code.
 * The test files are scanned before the first tool of the turn, so a change through any tool or command is seen.
 */
export function attachTestGuard(bus: EventBus, root = process.cwd()): () => void {
  const before = new Map<string, Map<string, Scanned>>();
  const reminded = new Set<string>();
  // Later scans only stat the files: the first full read took 318 ms on a repository with 365 test files.
  const cache = new Map<string, Scanned & { stamp: string }>();
  const warm = setTimeout(() => scanTests(root, cache), 0);
  const offBefore = bus.on("tool.execute.before", (payload) => {
    const p = payload as AgencyEvents["tool.execute.before"];
    if (p.turnId !== undefined && !before.has(p.turnId)) before.set(p.turnId, scanTests(root, cache));
  });
  const offStop = bus.on("turn.stop", (payload) => {
    const p = payload as AgencyEvents["turn.stop"];
    if (p.turnId === undefined) return;
    const scan = before.get(p.turnId);
    // A worker's change is judged at its lead's end, against the scan from before the lead's first tool.
    const changes =
      p.taskDepth > 0 || reminded.has(p.turnId) || scan === undefined
        ? []
        : weakenedTests(scan, scanTests(root, cache));
    if (changes.length === 0) {
      before.delete(p.turnId);
      reminded.delete(p.turnId);
      return;
    }
    reminded.add(p.turnId);
    throw new HookBlock(testGuardReminder(changes));
  });
  return () => {
    clearTimeout(warm);
    offBefore();
    offStop();
  };
}
