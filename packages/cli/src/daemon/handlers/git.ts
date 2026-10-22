import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Untracked files above this size, or with a NUL byte, come back with no text. */
const MAX_UNTRACKED_BYTES = 512 * 1024;
const GIT_TIMEOUT_MS = 10_000;

/** Raw output of one git call, or undefined when git fails: the core runner trims, which breaks `status -z`. */
async function git(root: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

const lines = (text: string | undefined): string[] => (text ?? "").split(/\n/).filter(Boolean);

export interface GitFile {
  path: string;
  status: string;
  added: number | null;
  deleted: number | null;
}

export async function gitStatus(root: string): Promise<Record<string, unknown>> {
  if ((await git(root, ["rev-parse", "--is-inside-work-tree"])) === undefined) return { repo: false };
  // Status paths are repo-root-relative whatever the cwd: strip the workspace prefix, and `-- .` drops files outside it.
  const [prefixOut, branchOut, logOut, aheadOut, numstat, statusOut, dirsOut, branchesOut] =
    await Promise.all([
      git(root, ["rev-parse", "--show-prefix"]),
      git(root, ["branch", "--show-current"]),
      git(root, ["log", "-1", "--format=%h%x00%s%x00%cr"]),
      git(root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
      git(root, ["diff", "HEAD", "--relative", "--numstat", "-z"]),
      git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]),
      git(root, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]),
      git(root, ["branch", "--format=%(refname:short)"]),
    ]);
  const prefix = (prefixOut ?? "").trim();
  const branch = (branchOut ?? "").trim();
  const [hash = "", subject = "", when = ""] = (logOut ?? "").trim().split("\0");
  const [ahead = 0, behind = 0] = (aheadOut ?? "").split(/\s+/).filter(Boolean).map(Number);
  const num = (n: string): number | null => (Number.isNaN(Number(n)) ? null : Number(n));
  const counts = new Map<string, [number | null, number | null]>();
  const stats = (numstat ?? "").split("\0");
  for (let i = 0; i < stats.length; i++) {
    const [add, del, path] = (stats[i] ?? "").split("\t");
    if (add === undefined || del === undefined) continue;
    // A rename has an empty path here, then the old and the new path as entries of their own.
    if (path === "") {
      const renamed = stats[i + 2];
      if (renamed) counts.set(renamed, [num(add), num(del)]);
      i += 2;
    } else if (path) counts.set(path, [num(add), num(del)]);
  }
  const files: GitFile[] = [];
  const entries = (statusOut ?? "").split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2).trim();
    const path = entry.slice(3).slice(prefix.length);
    // A rename or a copy is followed by the path it came from.
    if (status.startsWith("R") || status.startsWith("C")) i++;
    let [added, deleted] = counts.get(path) ?? [null, null];
    if (status === "??") {
      const text = readText(root, path);
      added = text === undefined ? null : text.split(/\n/).length - (text.endsWith("\n") ? 1 : 0);
      deleted = 0;
    }
    files.push({ path, status, added, deleted });
  }
  const gitDirs = lines(dirsOut);
  return {
    repo: true,
    worktree: gitDirs[0] !== gitDirs[1],
    branch,
    branches: lines(branchesOut),
    ahead,
    behind,
    lastCommit: { hash, subject, when },
    files,
  };
}

function readText(root: string, path: string): string | undefined {
  try {
    // A symlink that an untrusted repo plants would read any file the daemon can.
    if (lstatSync(join(root, path)).isSymbolicLink()) return undefined;
    const bytes = readFileSync(join(root, path));
    return bytes.length > MAX_UNTRACKED_BYTES || bytes.includes(0) ? undefined : bytes.toString("utf8");
  } catch {
    return undefined;
  }
}

/** The diff against HEAD, plus the text of untracked files: git has no diff for them without touching the index. */
export async function gitDiff(root: string): Promise<{
  diff: string;
  untracked: Array<{ path: string; text: string | null }>;
}> {
  const [diff, others] = await Promise.all([
    git(root, ["diff", "HEAD", "--relative", "--no-color", "--no-ext-diff", "-U3"]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const untracked = (others ?? "")
    .split("\0")
    .filter(Boolean)
    .map((path) => ({ path, text: readText(root, path) ?? null }));
  return { diff: diff ?? "", untracked };
}

/** The line a commit of these files starts from: the session's own title or last prompt wins when it has one. */
export function suggestMessage(files: readonly GitFile[], hint?: string): string {
  const line = (hint ?? "").split(/\n/)[0]?.trim() ?? "";
  if (line !== "") return line.length > 72 ? `${line.slice(0, 71)}…` : line;
  if (files.length === 0) return "";
  const names = files.slice(0, 3).map((f) => f.path.split("/").pop());
  return `update ${names.join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}`;
}

export interface CommitResult {
  sha: string;
  branch: string;
  pushed: boolean;
  /** The remote branch that a push went to, as `origin/dev`. */
  upstream?: string;
}

/** Runs git and throws its own message on failure, which tells the person what refused. */
async function gitOrThrow(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: root,
      timeout: 60_000,
      windowsHide: true,
      encoding: "utf8",
    });
    return stdout;
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string; message: string };
    throw new Error((e.stderr || e.stdout || e.message).trim());
  }
}

/**
 * Commits `paths` (or every change of the workspace), then pushes to the upstream of the current branch when asked.
 * Never forces: a push that the remote refuses is an error after a commit that stays.
 */
export async function gitCommit(
  root: string,
  opts: { message: string; paths?: string[]; push?: boolean },
): Promise<CommitResult> {
  const message = opts.message.trim();
  if (message === "") throw new Error("commit message is empty");
  if ((await git(root, ["rev-parse", "--is-inside-work-tree"])) === undefined)
    throw new Error("not a git repository");
  if (lines(await git(root, ["diff", "--name-only", "--diff-filter=U"])).length > 0)
    throw new Error("the index has unmerged paths: resolve the conflict first");
  const paths = opts.paths ?? [];
  for (const path of paths)
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..") || path === "")
      throw new Error(`path is outside the workspace: ${path}`);
  const branch = ((await git(root, ["branch", "--show-current"])) ?? "").trim();
  let upstream: string | undefined;
  if (opts.push) {
    if (branch === "") throw new Error("cannot push a detached HEAD");
    upstream = (await git(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]))?.trim();
    if (!upstream) throw new Error(`branch ${branch} has no upstream: nothing was committed`);
  }
  if (paths.length > 0) {
    await gitOrThrow(root, ["add", "--", ...paths]);
    await gitOrThrow(root, ["commit", "-m", message, "--", ...paths]);
  } else {
    await gitOrThrow(root, ["add", "-A", "--", "."]);
    await gitOrThrow(root, ["commit", "-m", message]);
  }
  const sha = ((await git(root, ["rev-parse", "--short", "HEAD"])) ?? "").trim();
  if (opts.push) await gitOrThrow(root, ["push"]);
  return { sha, branch, pushed: opts.push === true, ...(upstream ? { upstream } : {}) };
}
