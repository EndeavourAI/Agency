import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listUnignoredFiles, parseGitignoreLine } from "../src/gitignore.ts";

function matcher(lines: string[]): (rel: string) => boolean {
  const rules = lines
    .map(parseGitignoreLine)
    .filter((rule): rule is NonNullable<typeof rule> => rule !== undefined);
  return (relPath: string) => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.test(relPath)) ignored = !rule.negated;
    }
    return ignored;
  };
}

describe("parseGitignoreLine / gitignore filtering", () => {
  test("basename patterns match at any depth", () => {
    const ignore = matcher(["*.log"]);
    expect(ignore("debug.log")).toBe(true);
    expect(ignore("logs/nested/debug.log")).toBe(true);
    expect(ignore("src/app.ts")).toBe(false);
  });

  test("directory patterns cover the directory and everything under it", () => {
    const ignore = matcher(["node_modules/"]);
    expect(ignore("node_modules")).toBe(true);
    expect(ignore("node_modules/pkg/index.js")).toBe(true);
    expect(ignore("src/node_modules-ish")).toBe(false);
  });

  test("anchored patterns (leading slash) match only at the root", () => {
    const ignore = matcher(["/build"]);
    expect(ignore("build")).toBe(true);
    expect(ignore("build/out.js")).toBe(true);
    expect(ignore("sub/build")).toBe(false);
  });

  test("negation overrides an earlier ignore (later match wins)", () => {
    const ignore = matcher(["*.log", "!keep.log"]);
    expect(ignore("debug.log")).toBe(true);
    expect(ignore("keep.log")).toBe(false);
  });

  test("comments and blank lines are skipped", () => {
    expect(parseGitignoreLine("# comment")).toBeUndefined();
    expect(parseGitignoreLine("   ")).toBeUndefined();
  });

  test("double-star globs work through the guard compiler", () => {
    const ignore = matcher(["**/generated/**"]);
    expect(ignore("src/generated/out.ts")).toBe(true);
    expect(ignore("src/handwritten.ts")).toBe(false);
  });
});

describe("listUnignoredFiles", () => {
  const put = (root: string, rel: string, text = "x") => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };

  test("a nested .gitignore hides paths of its own folder only, and a new file shows on the next call", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-files-"));
    try {
      put(root, ".gitignore", "*.log\n");
      put(root, "a.ts");
      put(root, "run.log");
      put(root, "pkg/.gitignore", "gen/\nsecret.txt\n");
      put(root, "pkg/gen/out.ts");
      put(root, "pkg/secret.txt");
      put(root, "pkg/keep.ts");
      put(root, "other/secret.txt");
      put(root, "pkg/deep/x.log");
      put(root, ".git/config");
      expect(listUnignoredFiles(root, 100).files).toEqual([
        ".gitignore",
        "a.ts",
        "other/secret.txt",
        "pkg/.gitignore",
        "pkg/keep.ts",
      ]);
      put(root, "new.ts");
      expect(listUnignoredFiles(root, 100).files).toContain("new.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the limit cuts the list and says so", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-files-"));
    try {
      for (const name of ["a", "b", "c"]) put(root, name);
      expect(listUnignoredFiles(root, 3)).toEqual({ files: ["a", "b", "c"], truncated: false });
      expect(listUnignoredFiles(root, 2)).toEqual({ files: ["a", "b"], truncated: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
