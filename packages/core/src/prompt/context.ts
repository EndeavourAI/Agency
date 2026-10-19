import { execFile, execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { release } from "node:os";

export interface GitStatusInfo {
  branch: string;
  dirty: boolean;
  changedFiles: number;
  detached: boolean;
}

export interface EnvironmentInfo {
  platform: string;
  cwd: string;
  date: string;
  /** Absent when the directory isn't a git repo, or git itself is unavailable. */
  git?: GitStatusInfo;
  /** Human-readable shell label (e.g. "PowerShell", "POSIX sh"): the dialect
   *  the model must write commands in. Absent when the caller doesn't know. */
  shell?: string;
  /** Names at the project root, a folder with a trailing slash; hidden ones and node_modules left out. */
  entries?: string[];
}

/** Returns trimmed stdout, or null when the command fails (no git, not a
 *  repo, timeout) — callers treat null as "no git information". */
export type GitRunner = (cwd: string, args: string[]) => string | null;

export const GIT_TIMEOUT_MS = 2_000;

/** Real runner: `git` must be on PATH; any failure (ENOENT, non-zero exit for
 *  not-a-repo, timeout on a pathological status) degrades to null. */
export function defaultGitRunner(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

const STATUS_ARGS = ["status", "--porcelain", "--branch"];

/**
 * Starts the status at once and hands it to the first call within `maxAgeMs`, then runs git as before: on Windows the
 * status cost 58 ms, 36 of them the spawn, before the first request of each session of a new daemon.
 */
export function warmGitRunner(root: string, maxAgeMs = 10_000): GitRunner & { settled: Promise<void> } {
  const started = Date.now();
  let warm: string | null | undefined;
  // A stop waits for the spawn: on Windows a git still running in the folder keeps it from being deleted.
  const settled = new Promise<void>((resolve) =>
    execFile(
      "git",
      STATUS_ARGS,
      { cwd: root, timeout: GIT_TIMEOUT_MS, windowsHide: true, encoding: "utf8" },
      (error, stdout) => {
        warm = error ? null : stdout.trim() || null;
        resolve();
      },
    ),
  );
  const run: GitRunner = (cwd, args) => {
    const fresh = warm !== undefined && cwd === root && args.join(" ") === STATUS_ARGS.join(" ");
    if (!fresh || Date.now() - started > maxAgeMs) return defaultGitRunner(cwd, args);
    const out = warm as string | null;
    warm = undefined;
    return out;
  };
  return Object.assign(run, { settled });
}

/**
 * Parses `git status --porcelain --branch`. One command answers both A9b
 * questions (branch + dirty state): the `## ` header carries the branch, every
 * remaining line is a changed path.
 */
export function parseGitStatus(output: string): GitStatusInfo | undefined {
  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const header = lines.find((line) => line.startsWith("## "));
  if (header === undefined) return undefined;

  let branch = header.slice(3);
  let detached = false;
  if (branch === "HEAD (no branch)") {
    detached = true;
    branch = "HEAD";
  } else if (branch.startsWith("No commits yet on ")) {
    branch = branch.slice("No commits yet on ".length);
  } else {
    const upstreamSeparator = branch.indexOf("...");
    if (upstreamSeparator >= 0) branch = branch.slice(0, upstreamSeparator);
  }

  const changedFiles = Math.max(lines.length - 1, 0);
  return { branch, dirty: changedFiles > 0, changedFiles, detached };
}

export interface GatherEnvironmentOptions {
  cwd: string;
  now?: Date;
  /** Test seam; defaults to `defaultGitRunner`. */
  git?: GitRunner;
  /** Shell label to report in the block; defaults to absent. */
  shell?: string;
}

/** Collects what the model needs to orient itself: platform, working
 *  directory, current date/time, and git state. Never throws — a hostile cwd
 *  or missing git yields a block with the git section omitted. */
export function gatherEnvironmentInfo(options: GatherEnvironmentOptions): EnvironmentInfo {
  const runGit = options.git ?? defaultGitRunner;
  const info: EnvironmentInfo = {
    platform: `${process.platform} ${release()} ${process.arch}`,
    cwd: options.cwd,
    date: environmentDate(options.now ?? new Date()),
    ...(options.shell === undefined ? {} : { shell: options.shell }),
  };

  try {
    info.entries = readdirSync(options.cwd, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
  } catch {}

  const status = runGit(options.cwd, STATUS_ARGS);
  if (status !== null) {
    const parsed = parseGitStatus(status);
    if (parsed !== undefined) info.git = parsed;
  }
  return info;
}

const ROOT_ENTRIES = 60;

export function buildEnvironmentBlock(info: EnvironmentInfo): string {
  // The words of the path rule of the prompt: with `cwd: <path>`, models wrote that path out in most calls.
  const root = `project root: ${info.cwd} (the shell starts each command here; give tools paths relative to it)`;
  const lines = [`<environment>`, `os: ${info.platform}`, root, `date: ${info.date}`];
  // Live: 34 of 233 sessions searched for Python or JavaScript files that the project lacks in their first replies.
  if (info.entries?.length) {
    const shown = info.entries.slice(0, ROOT_ENTRIES).join(", ");
    const more = info.entries.length - ROOT_ENTRIES;
    lines.push(`at the project root: ${shown}${more > 0 ? `, and ${more} more` : ""}`);
  }
  if (info.shell !== undefined) lines.push(`shell: ${info.shell}`);
  if (info.git) {
    const state = info.git.detached ? ["detached"] : [];
    state.push(
      info.git.dirty
        ? `dirty, ${info.git.changedFiles} changed file${info.git.changedFiles === 1 ? "" : "s"}`
        : "clean",
    );
    lines.push(`git at session start: branch ${info.git.branch} (${state.join(", ")})`);
  }
  lines.push("</environment>");
  return lines.join("\n");
}

/** Local date only, e.g. "2026-09-02": coarse enough to keep the system cache. */
export function environmentDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
