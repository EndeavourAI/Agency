import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Untracked files above this size, or with a NUL byte, come back with no text. */
const MAX_UNTRACKED_BYTES = 512 * 1024;
const GIT_TIMEOUT_MS = 10_000;
/** A commit or push may run slow hooks or a big network transfer. */
const GIT_WRITE_TIMEOUT_MS = 10 * 60_000;
/** Pathspec magic (`:(top)`, `:/`) would reach outside the workspace; prompts would hang a daemon with no tty. */
const GIT_ENV = { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0" };

/** Raw output of one git call, or undefined when git fails: the core runner trims, which breaks `status -z`. */
async function git(root: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
      env: GIT_ENV,
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
  /** The path a staged rename or copy came from. */
  oldPath?: string;
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
    let oldPath: string | undefined;
    if (status.startsWith("R") || status.startsWith("C")) oldPath = (entries[++i] ?? "").slice(prefix.length);
    let [added, deleted] = counts.get(path) ?? [null, null];
    if (status === "??") {
      const text = readText(root, path);
      added = text === undefined ? null : text.split(/\n/).length - (text.endsWith("\n") ? 1 : 0);
      deleted = 0;
    }
    files.push({ path, ...(oldPath ? { oldPath } : {}), status, added, deleted });
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
      timeout: GIT_WRITE_TIMEOUT_MS,
      env: GIT_ENV,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string; message: string };
    throw new Error((e.stderr || e.stdout || e.message).trim());
  }
}

/** The exact git calls of one commit, so the permission rules judge what runs and not a stand-in. */
export interface CommitPlan {
  branch: string;
  upstream?: string;
  add: string[];
  commit: string[];
  push?: string[];
}

const quote = (arg: string): string => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg));
/** Also lists the short `git push origin main` form, which is what a deny rule is usually written against. */
export const commandLines = (plan: CommitPlan): string[] => {
  const [, remote = "", target = ""] = plan.push ?? [];
  const short = plan.push ? [["push", remote, target.replace(/^HEAD:(refs\/heads\/)?/, "")]] : [];
  const all = [plan.add, plan.commit, ...(plan.push ? [plan.push] : []), ...short];
  return all.map((args) => ["git", ...args].map(quote).join(" "));
};

/** A staged rename commits as two paths: leaving the old one out keeps the deletion staged. */
async function withRenameSources(root: string, paths: string[]): Promise<string[]> {
  const tokens = (
    (await git(root, ["diff", "--cached", "--relative", "--name-status", "-z", "-M"])) ?? ""
  ).split("\0");
  const out = [...paths];
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i]?.startsWith("R")) continue;
    const [from, to] = [tokens[i + 1], tokens[i + 2]];
    if (from && to && paths.includes(to) && !out.includes(from)) out.push(from);
    i += 2;
  }
  return out;
}

/** A hook runs as the user, so an unreviewed edit of one (a pulled `.husky/pre-commit`) must not run from here. */
async function dirtyHooksDir(root: string): Promise<string | undefined> {
  const top = ((await git(root, ["rev-parse", "--show-toplevel"])) ?? "").trim();
  const hooks = ((await git(root, ["rev-parse", "--git-path", "hooks"])) ?? "").trim();
  if (!top || !hooks) return undefined;
  const rel = relative(top, resolve(root, hooks)).replaceAll("\\", "/");
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  const changed = await git(top, ["status", "--porcelain", "--untracked-files=all", "--", rel]);
  return (changed ?? "").trim() === "" ? undefined : rel;
}

/** Validates a commit and returns the git calls it will run; throws before anything changed. */
export async function planCommit(
  root: string,
  opts: { message: string; paths?: string[]; push?: boolean },
): Promise<CommitPlan> {
  const message = opts.message.trim();
  if (message === "") throw new Error("commit message is empty");
  if ((await git(root, ["rev-parse", "--is-inside-work-tree"])) === undefined)
    throw new Error("not a git repository");
  if (lines(await git(root, ["diff", "--name-only", "--diff-filter=U"])).length > 0)
    throw new Error("the index has unmerged paths: resolve the conflict first");
  const given = opts.paths ?? [];
  for (const path of given)
    if (isAbsolute(path) || path.startsWith(":") || path.split(/[\\/]/).includes("..") || path === "")
      throw new Error(`path is outside the workspace: ${path}`);
  const hooks = await dirtyHooksDir(root);
  if (hooks)
    throw new Error(
      `${hooks} has uncommitted changes and git would run those hooks: review the hook, then commit from your terminal`,
    );
  const branch = ((await git(root, ["branch", "--show-current"])) ?? "").trim();
  const paths = given.length > 0 ? await withRenameSources(root, given) : undefined;
  const plan: CommitPlan = {
    branch,
    // The rename source is already staged and gone from the tree, so `add` would not match it.
    add: paths ? ["add", "--", ...given] : ["add", "-A", "--", "."],
    // `-- .` commits the workspace only: a bare commit would take files that were staged outside it.
    commit: ["commit", "-m", message, "--", ...(paths ?? ["."])],
  };
  if (opts.push) {
    if (branch === "") throw new Error("cannot push a detached HEAD");
    const upstream = ((await git(root, ["rev-parse", "--abbrev-ref", "@{upstream}"])) ?? "").trim();
    const remote = ((await git(root, ["config", "--get", `branch.${branch}.remote`])) ?? "").trim();
    const merge = ((await git(root, ["config", "--get", `branch.${branch}.merge`])) ?? "").trim();
    if (!upstream || !remote || !merge)
      throw new Error(`branch ${branch} has no upstream: nothing was committed`);
    // Bare `git push` obeys pushDefault, pushRemote and push.default, so it can go elsewhere than the upstream.
    plan.upstream = upstream;
    plan.push = ["push", remote, `HEAD:${merge}`];
  }
  return plan;
}

export async function runCommit(root: string, plan: CommitPlan): Promise<CommitResult> {
  await gitOrThrow(root, plan.add);
  await gitOrThrow(root, plan.commit);
  const sha = ((await git(root, ["rev-parse", "--short", "HEAD"])) ?? "").trim();
  if (plan.push) await gitOrThrow(root, plan.push);
  return {
    sha,
    branch: plan.branch,
    pushed: plan.push !== undefined,
    ...(plan.upstream ? { upstream: plan.upstream } : {}),
  };
}

/**
 * Commits `paths` (or every change of the workspace), then pushes to the upstream of the current branch when asked.
 * Never forces: a push that the remote refuses is an error after a commit that stays.
 */
export async function gitCommit(
  root: string,
  opts: { message: string; paths?: string[]; push?: boolean },
): Promise<CommitResult> {
  return runCommit(root, await planCommit(root, opts));
}
