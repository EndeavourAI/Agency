import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Untracked files above this size, or with a NUL byte, come back with no text. */
const MAX_UNTRACKED_BYTES = 512 * 1024;
const GIT_TIMEOUT_MS = 10_000;

/** Raw output of one git call, or undefined when git fails: the core runner trims, which breaks `status -z`. */
function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
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

export function gitStatus(root: string): Record<string, unknown> {
  if (git(root, ["rev-parse", "--is-inside-work-tree"]) === undefined) return { repo: false };
  const branch = (git(root, ["branch", "--show-current"]) ?? "").trim();
  const [hash = "", subject = "", when = ""] = (git(root, ["log", "-1", "--format=%h%x00%s%x00%cr"]) ?? "")
    .trim()
    .split("\0");
  const [ahead = 0, behind = 0] = (
    git(root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]) ?? ""
  )
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  const counts = new Map<string, [number | null, number | null]>();
  for (const entry of (git(root, ["diff", "HEAD", "--numstat", "-z"]) ?? "").split("\0")) {
    const [add, del, path] = entry.split("\t");
    if (add !== undefined && del !== undefined && path)
      counts.set(path, [
        Number.isNaN(Number(add)) ? null : Number(add),
        Number.isNaN(Number(del)) ? null : Number(del),
      ]);
  }
  const files: GitFile[] = [];
  const entries = (git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]) ?? "").split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2).trim();
    const path = entry.slice(3);
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
  const gitDirs = lines(git(root, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]));
  return {
    repo: true,
    worktree: gitDirs[0] !== gitDirs[1],
    branch,
    branches: lines(git(root, ["branch", "--format=%(refname:short)"])),
    ahead,
    behind,
    lastCommit: { hash, subject, when },
    files,
  };
}

function readText(root: string, path: string): string | undefined {
  try {
    const bytes = readFileSync(join(root, path));
    return bytes.length > MAX_UNTRACKED_BYTES || bytes.includes(0) ? undefined : bytes.toString("utf8");
  } catch {
    return undefined;
  }
}

/** The diff against HEAD, plus the text of untracked files: git has no diff for them without touching the index. */
export function gitDiff(root: string): {
  diff: string;
  untracked: Array<{ path: string; text: string | null }>;
} {
  const diff = git(root, ["diff", "HEAD", "--no-color", "--no-ext-diff", "-U3"]) ?? "";
  const untracked = (git(root, ["ls-files", "--others", "--exclude-standard", "-z"]) ?? "")
    .split("\0")
    .filter(Boolean)
    .map((path) => ({ path, text: readText(root, path) ?? null }));
  return { diff, untracked };
}
