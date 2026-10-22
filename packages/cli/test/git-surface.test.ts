import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitDiff, gitStatus } from "../src/daemon/handlers/git.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agency-git-${name}-`));
  dirs.push(dir);
  return dir;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
const lf = String.fromCharCode(10);

function repo() {
  const remote = tmp("remote");
  git(remote, "init", "-q", "--bare", "-b", "main");
  const root = tmp("work");
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), ["one", "two", "three"].join(lf) + lf);
  writeFileSync(join(root, "b.txt"), `b${lf}`);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "first");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "-u", "origin", "main");
  return root;
}

test("git_status reports modified, added and untracked files with line counts, and ahead after a commit", async () => {
  const root = repo();
  writeFileSync(join(root, "a.txt"), ["one", "TWO", "three", "four"].join(lf) + lf);
  writeFileSync(join(root, "added.txt"), `x${lf}`);
  git(root, "add", "added.txt");
  writeFileSync(join(root, "new.txt"), ["p", "q"].join(lf) + lf);
  const status = (await gitStatus(root)) as {
    repo: boolean;
    branch: string;
    ahead: number;
    files: Array<{ path: string; status: string; added: number | null; deleted: number | null }>;
  };
  expect(status.repo).toBe(true);
  expect(status.branch).toBe("main");
  expect(status.ahead).toBe(0);
  const byPath = Object.fromEntries(status.files.map((f) => [f.path, f]));
  expect(byPath["a.txt"]).toEqual({ path: "a.txt", status: "M", added: 2, deleted: 1 });
  expect(byPath["added.txt"]).toMatchObject({ status: "A", added: 1, deleted: 0 });
  expect(byPath["new.txt"]).toEqual({ path: "new.txt", status: "??", added: 2, deleted: 0 });

  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "second");
  expect(((await gitStatus(root)) as { ahead: number }).ahead).toBe(1);
});

test("git_diff gives the diff against HEAD and the text of untracked files", async () => {
  const root = repo();
  writeFileSync(join(root, "a.txt"), ["one", "TWO", "three"].join(lf) + lf);
  writeFileSync(join(root, "new.txt"), `fresh${lf}`);
  writeFileSync(join(root, "blob.bin"), Buffer.from([1, 0, 2]));
  const { diff, untracked } = await gitDiff(root);
  expect(diff).toContain("-two");
  expect(diff).toContain("+TWO");
  expect(untracked.find((u) => u.path === "new.txt")?.text).toBe(`fresh${lf}`);
  expect(untracked.find((u) => u.path === "blob.bin")?.text).toBeNull();
});

test("git_status says repo false outside a repository", async () => {
  expect(await gitStatus(tmp("plain"))).toEqual({ repo: false });
});

test("a workspace inside a repo gets workspace-relative paths and nothing from outside it", async () => {
  const root = repo();
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "x.txt"), `x${lf}`);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "sub");
  writeFileSync(join(root, "sub", "x.txt"), `x${lf}y${lf}`);
  writeFileSync(join(root, "sub", "new.txt"), `n${lf}`);
  writeFileSync(join(root, "a.txt"), `changed${lf}`);
  writeFileSync(join(root, "outside.txt"), `o${lf}`);
  const sub = join(root, "sub");
  const { files } = (await gitStatus(sub)) as { files: Array<{ path: string; added: number | null }> };
  expect(files.map((f) => f.path).sort()).toEqual(["new.txt", "x.txt"]);
  expect(files.find((f) => f.path === "x.txt")?.added).toBe(1);
  expect(files.find((f) => f.path === "new.txt")?.added).toBe(1);
  const { diff, untracked } = await gitDiff(sub);
  expect(diff).toContain("+y");
  expect(diff).not.toContain("changed");
  expect(untracked.map((u) => u.path)).toEqual(["new.txt"]);
});

test("an untracked symlink is not read", async () => {
  const root = repo();
  const secret = join(tmp("secret"), "secret.txt");
  writeFileSync(secret, `hunter2${lf}`);
  try {
    symlinkSync(secret, join(root, "link.txt"));
  } catch {
    return; // no symlink privilege on this machine
  }
  const { untracked } = await gitDiff(root);
  expect(untracked.find((u) => u.path === "link.txt")?.text).toBeNull();
  const { files } = (await gitStatus(root)) as { files: Array<{ path: string; added: number | null }> };
  expect(files.find((f) => f.path === "link.txt")?.added).toBeNull();
});

test("a staged rename keeps its line counts", async () => {
  const root = repo();
  git(root, "mv", "a.txt", "c.txt");
  writeFileSync(join(root, "c.txt"), ["one", "TWO", "three"].join(lf) + lf);
  git(root, "add", "c.txt");
  const { files } = (await gitStatus(root)) as {
    files: Array<{ path: string; added: number | null; deleted: number | null }>;
  };
  expect(files.find((f) => f.path === "c.txt")).toMatchObject({ added: 1, deleted: 1 });
});
