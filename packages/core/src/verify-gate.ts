import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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
/** Only the count before and after matters, so an import of `assert` counts on both sides. */
const ASSERTION = /\bassert\w*|\bexpect\s*\(|\bt\.(?:Error|Fatal)f?\s*\(|\bXCTAssert/g;
const SKIP =
  /\.(?:skip|todo)\s*\(|\b(?:xit|xdescribe|xtest)\s*\(|@pytest\.mark\.(?:skip|xfail)|@unittest\.skip|\bpytest\.skip\s*\(|#\[ignore\]|\bt\.Skip\w*\s*\(/g;

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** How a test file checks less than it did, if it does. */
function weakening(before: string, after: string | undefined): string | undefined {
  if (after === undefined) return "deleted";
  const lost = count(before, ASSERTION) - count(after, ASSERTION);
  if (lost > 0) return `${lost} fewer assertions`;
  const skipped = count(after, SKIP) - count(before, SKIP);
  return skipped > 0 ? `${skipped} more skipped` : undefined;
}

export function testGuardReminder(changes: readonly string[]): string {
  return (
    `You changed tests so that they check less: ${changes.join(", ")}. Unless the task asked for that, restore ` +
    "them and fix the code instead. If it did, say so in one line and stop."
  );
}

/**
 * A turn that deleted a test file, took assertions out or skipped a test is sent back once: a model can make a check
 * pass by weakening the test instead of fixing the code. A change through bash (`sed -i`, `rm`) is not seen.
 */
export function attachTestGuard(bus: EventBus, root = process.cwd()): () => void {
  // Per turn, each test file as it was before the turn first changed it; undefined when it did not exist.
  const originals = new Map<string, Map<string, string | undefined>>();
  const reminded = new Set<string>();
  const offBefore = bus.on("tool.execute.before", (payload) => {
    const p = payload as AgencyEvents["tool.execute.before"];
    const path = p.input.path;
    if (
      p.turnId === undefined ||
      !EDIT_TOOLS.has(p.tool) ||
      typeof path !== "string" ||
      !TEST_PATH.test(path)
    )
      return;
    const files = originals.get(p.turnId) ?? new Map<string, string | undefined>();
    originals.set(p.turnId, files);
    if (!files.has(path)) files.set(path, readText(resolve(root, path)));
  });
  const offStop = bus.on("turn.stop", (payload) => {
    const p = payload as AgencyEvents["turn.stop"];
    if (p.turnId === undefined || p.taskDepth > 0) return;
    const files = originals.get(p.turnId);
    const changes = reminded.has(p.turnId)
      ? []
      : [...(files ?? [])].flatMap(([path, before]) => {
          const how = before === undefined ? undefined : weakening(before, readText(resolve(root, path)));
          return how === undefined ? [] : [`${path} (${how})`];
        });
    if (changes.length === 0) {
      originals.delete(p.turnId);
      reminded.delete(p.turnId);
      return;
    }
    reminded.add(p.turnId);
    throw new HookBlock(testGuardReminder(changes));
  });
  return () => {
    offBefore();
    offStop();
  };
}
