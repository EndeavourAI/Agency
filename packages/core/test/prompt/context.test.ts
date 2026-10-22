import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEnvironmentBlock,
  defaultGitRunner,
  gatherEnvironmentInfo,
  parseGitStatus,
  warmGitRunner,
} from "../../src/prompt/context.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-context-"));
  dirs.push(dir);
  return dir;
}

describe("parseGitStatus", () => {
  test("clean repo: branch with upstream stripped, zero changed files", () => {
    expect(parseGitStatus("## main...origin/main\n")).toEqual({
      branch: "main",
      dirty: false,
      changedFiles: 0,
      detached: false,
    });
  });

  test("dirty repo: counts porcelain entries beyond the header", () => {
    const parsed = parseGitStatus("## main...origin/main [ahead 1]\n M a.ts\n?? b.txt\nR  c.md -> d.md\n");
    expect(parsed).toMatchObject({ branch: "main", dirty: true, changedFiles: 3, detached: false });
  });

  test("detached HEAD reports the detached state", () => {
    expect(parseGitStatus("## HEAD (no branch)\n M a.ts\n")).toMatchObject({
      branch: "HEAD",
      dirty: true,
      changedFiles: 1,
      detached: true,
    });
  });

  test("fresh repo with no commits keeps the unborn branch name", () => {
    expect(parseGitStatus("## No commits yet on master\n")).toMatchObject({
      branch: "master",
      dirty: false,
      changedFiles: 0,
      detached: false,
    });
  });

  test("output without a branch header is not git status", () => {
    expect(parseGitStatus("fatal: not a git repository")).toBeUndefined();
  });
});

describe("gatherEnvironmentInfo", () => {
  const now = new Date("2026-09-02T12:34:56");

  test("collects platform, cwd, date, and parsed git state", () => {
    const info = gatherEnvironmentInfo({
      cwd: "/repo",
      now,
      git: (_cwd, args) => (args.join(" ").includes("status") ? "## main\n M x.ts\n" : null),
    });
    expect(info.cwd).toBe("/repo");
    expect(info.platform).toContain(process.platform);
    expect(info.date).toBe("2026-09-02");
    expect(info.git).toEqual({ branch: "main", dirty: true, changedFiles: 1, detached: false });
  });

  test("date-only granularity keeps the environment block cache-stable within a day", () => {
    const noon = gatherEnvironmentInfo({
      cwd: "/repo",
      now: new Date("2026-09-02T12:34:56"),
      git: () => null,
    });
    const evening = gatherEnvironmentInfo({
      cwd: "/repo",
      now: new Date("2026-09-02T23:01:05"),
      git: () => null,
    });
    expect(noon.date).toBe("2026-09-02");
    expect(evening.date).toBe(noon.date);
    expect(buildEnvironmentBlock(noon)).toBe(buildEnvironmentBlock(evening));
  });

  test("a failing git runner (no repo, no git binary, timeout) just omits the git section", () => {
    const info = gatherEnvironmentInfo({ cwd: "/not-a-repo", now, git: () => null });
    expect(info.git).toBeUndefined();
    expect(info.platform).toContain(process.platform);
  });

  test("names the files and folders at the project root, with no hidden ones", () => {
    const root = tempDir();
    for (const dir of ["src", ".git", "node_modules"]) mkdirSync(join(root, dir));
    writeFileSync(join(root, "package.json"), "{}");
    const info = gatherEnvironmentInfo({ cwd: root, now, git: () => null });
    // Live: 34 of 233 sessions searched for Python or JavaScript files that the project lacks in their first replies.
    expect(buildEnvironmentBlock(info)).toContain("\nat the project root: package.json, src/\n");

    for (let index = 0; index < 70; index++)
      writeFileSync(join(root, `f${String(index).padStart(2, "0")}`), "");
    const many = buildEnvironmentBlock(gatherEnvironmentInfo({ cwd: root, now, git: () => null }));
    expect(many).toContain("f59, and 12 more\n");
  });

  test("a warm runner answers the first status from a spawn started earlier, then runs git again", async () => {
    const repo = tempDir();
    if (spawnSync("git", ["init"], { cwd: repo }).status !== 0) return;
    writeFileSync(join(repo, "a.txt"), "");
    const warm = warmGitRunner(repo);
    await Bun.sleep(1_500);
    const args = ["status", "--porcelain", "--branch"];
    let started = performance.now();
    const first = warm(repo, args);
    const warmMs = performance.now() - started;
    started = performance.now();
    const second = warm(repo, args);
    const coldMs = performance.now() - started;
    // On Windows the spawn took 36 ms of the 58 that a status cost before each session's first request.
    expect(first).toBe(second);
    expect(first).toContain("?? a.txt");
    expect(warmMs).toBeLessThan(coldMs);
  });

  test("the real runner degrades to null outside a repo", () => {
    expect(defaultGitRunner(tempDir(), ["status", "--porcelain", "--branch"])).toBeNull();
  });

  test("against a real git repo: fresh init is reported with its branch", () => {
    const repo = tempDir();
    const init = spawnSync("git", ["init"], { cwd: repo, encoding: "utf8" });
    // No git binary in this environment: the degradation path above covers it.
    if (init.status !== 0) return;

    const info = gatherEnvironmentInfo({ cwd: repo, now });
    expect(info.git?.branch.length ?? 0).toBeGreaterThan(0);
    expect(info.git?.dirty).toBe(false);

    writeFileSync(join(repo, "tracked.txt"), "hello");
    const dirty = gatherEnvironmentInfo({ cwd: repo, now });
    expect(dirty.git?.dirty).toBe(true);
    expect(dirty.git?.changedFiles).toBe(1);
  });
});

describe("buildEnvironmentBlock", () => {
  test("renders the tagged block with os, project root, and date lines", () => {
    const block = buildEnvironmentBlock({
      platform: "win32 10.0.26100 x64",
      cwd: "C:\\repo",
      date: "2026-09-02",
      git: { branch: "main", dirty: true, changedFiles: 2, detached: false },
    });
    expect(block).toBe(
      [
        "<environment>",
        "os: win32 10.0.26100 x64",
        // Live: the line said `cwd`, the prompt asked for paths from the project root, and models wrote the root out.
        "project root: C:\\repo (the shell starts each command here; give tools paths relative to it)",
        "date: 2026-09-02",
        "git at session start: branch main (dirty, 2 changed files)",
        "</environment>",
      ].join("\n"),
    );
  });

  test("omits the git line when there is no git information", () => {
    const block = buildEnvironmentBlock({
      platform: "linux 6.8 x64",
      cwd: "/tmp/x",
      date: "2026-09-02",
    });
    expect(block).not.toContain("git:");
    expect(block).not.toContain("branch");
  });

  test("marks detached HEAD and singular changed-file counts", () => {
    const detached = buildEnvironmentBlock({
      platform: "darwin 24 x64",
      cwd: "/repo",
      date: "2026-09-02",
      git: { branch: "HEAD", dirty: false, changedFiles: 0, detached: true },
    });
    expect(detached).toContain("git at session start: branch HEAD (detached, clean)");

    const one = buildEnvironmentBlock({
      platform: "darwin 24 x64",
      cwd: "/repo",
      date: "2026-09-02",
      git: { branch: "main", dirty: true, changedFiles: 1, detached: false },
    });
    expect(one).toContain("git at session start: branch main (dirty, 1 changed file)");
  });

  test("renders the shell line after the date when a shell label is known", () => {
    const block = buildEnvironmentBlock({
      platform: "win32 10.0.26100 x64",
      cwd: "C:\\repo",
      date: "2026-09-02",
      shell: "PowerShell",
    });
    const lines = block.split("\n");
    expect(lines).toContain("shell: PowerShell");
    expect(lines.indexOf("shell: PowerShell")).toBeGreaterThan(lines.indexOf("date: 2026-09-02"));
  });

  test("omits the shell line when the caller passes no label", () => {
    const info = gatherEnvironmentInfo({
      cwd: "/repo",
      now: new Date("2026-09-02T12:34:56"),
      git: () => null,
    });
    expect(info.shell).toBeUndefined();
    expect(buildEnvironmentBlock(info)).not.toContain("shell:");
  });

  test("carries the caller's shell label into the gathered info", () => {
    const info = gatherEnvironmentInfo({
      cwd: "/repo",
      now: new Date("2026-09-02T12:34:56"),
      git: () => null,
      shell: "POSIX sh",
    });
    expect(info.shell).toBe("POSIX sh");
    expect(buildEnvironmentBlock(info)).toContain("shell: POSIX sh");
  });
});
