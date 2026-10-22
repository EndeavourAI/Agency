import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A task folder: its files are the workspace; task.json says what to ask and how to check. */
export interface TaskSpec {
  prompt: string;
  /** Exit 0 when solved. Runs in the workspace, with $ANSWER naming a file that holds the agent's reply. */
  check: string;
  /** Runs in the workspace after its first commit: state that a file cannot hold (git branches, a big file). */
  setup?: string;
  /** Runs after the check: stops what the agent left running. */
  cleanup?: string;
  /** A known answer for the self-test, which checks that `check` fails at the start and passes after it. */
  solution?: string;
  /** Terminal-Bench does not show its tests: leave the check out of the prompt. */
  hideCheck?: boolean;
  /** Platforms the task runs on (POSIX tools, a server): all when absent. */
  platforms?: string[];
}

export const BENCH_DIR = import.meta.dir;

/** The tasks of the bench folder that run on this platform, `only` those when given. */
export function loadTasks(only?: string[]): { name: string; spec: TaskSpec }[] {
  return readdirSync(BENCH_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (!only || only.includes(d.name)))
    .map((d) => ({
      name: d.name,
      spec: JSON.parse(readFileSync(join(BENCH_DIR, d.name, "task.json"), "utf8")) as TaskSpec,
    }))
    .filter(({ spec }) => !spec.platforms || spec.platforms.includes(process.platform));
}

/** A check or setup line: through sh where there is one, so it can use pipes and `&&`. */
export function shell(line: string, cwd: string, env: Record<string, string> = {}) {
  const [bin, ...rest] = process.platform === "win32" ? line.split(" ") : ["sh", "-c", line];
  return spawnSync(bin as string, rest, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

/** Copies the task to `ws`, commits it as the start, and runs its setup. */
export function prepareWorkspace(task: { name: string; spec: TaskSpec }, ws: string): void {
  cpSync(join(BENCH_DIR, task.name), ws, { recursive: true, filter: (src) => !src.endsWith("task.json") });
  for (const git of [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.name=b", "-c", "user.email=b@b", "commit", "-qm", "start"],
  ])
    spawnSync("git", git, { cwd: ws });
  if (task.spec.setup) shell(task.spec.setup, ws);
}

/** Hashes of the check files: a run that edits them does not count as solved. */
export function testHashes(ws: string): string {
  if (!existsSync(join(ws, "test"))) return "";
  // Files only: a run of Python tests leaves a __pycache__ folder there.
  return readdirSync(join(ws, "test"), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
    .map((f) =>
      createHash("sha256")
        .update(readFileSync(join(ws, "test", f)))
        .digest("hex"),
    )
    .join();
}
