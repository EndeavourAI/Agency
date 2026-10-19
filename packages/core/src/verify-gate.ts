import { readdirSync } from "node:fs";
import { type AgencyEvents, type EventBus, HookBlock } from "./events.ts";

const EDIT_TOOLS = new Set(["edit", "write", "notebook_edit"]);
/** A change of prose, a page or data needs no check: live, a written index.html was sent back twice for none. */
const DOC_FILE = /\.(md|mdx|txt|rst|adoc|html?|css|csv|svg)$/i;
/** A command that checks code: a test run, type check, linter or build. A false match only spares the reminder. */
const CHECK_COMMAND =
  /\b(tests?|spec|pytest|jest|vitest|mocha|tsc|typecheck|type-check|lint|eslint|biome|ruff|flake8|mypy|pyright|clippy|check|build|compile|make|gradlew?|mvn|cargo|go\s+(?:test|vet|build)|dotnet|ctest|phpunit|rspec)\b/i;
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

/**
 * Verify before done, as a harness rule: a turn that changed code since its last passing check is sent back once
 * before it ends. Measured on SWT-Bench, keeping only patches that pass a check roughly doubled precision.
 */
export function attachVerifyGate(bus: EventBus, root?: string): () => void {
  // The files that each turn changed since its last passing check.
  const changed = new Map<string, Set<string>>();
  const reminded = new Set<string>();
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
