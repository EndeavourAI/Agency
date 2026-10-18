import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { createGrepTool } from "../../src/builtins/grep.ts";
import type { ToolDeps } from "../../src/contract.ts";

function isMissingBinary(content: string): boolean {
  return content.includes("neither ripgrep") || content.includes("not installed or on PATH");
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-grep-test-")));
  dirs.push(root);
  const capabilities = { ...FULL_CAPABILITIES, pathScopes: [root] };
  const deps: ToolDeps = { identity: { type: "user" }, capabilities, sandbox: new SandboxBoundary(root) };
  return { deps, root };
}

const signal = new AbortController().signal;

describe("createGrepTool", () => {
  test("finds a matching line with its line number", async () => {
    const { deps, root } = setup();
    writeFileSync(join(root, "a.ts"), "line one\nconst target = 42;\nline three\n");

    const tool = createGrepTool(deps);
    const result = await tool.handler({ pattern: "target" }, { signal });
    if (isMissingBinary(result.content)) return;

    expect(result.content).toContain("const target = 42;");
    expect(result.content).toContain(":2:");
  });

  test("reports no matches without treating it as an error", async () => {
    const { deps, root } = setup();
    writeFileSync(join(root, "a.ts"), "nothing interesting here\n");

    const tool = createGrepTool(deps);
    const result = await tool.handler({ pattern: "definitely-not-present-xyz" }, { signal });
    if (isMissingBinary(result.content)) return;

    expect(result.content).toBe("no matches");
    expect(result.isError).toBeFalsy();
  });

  test("restricts results with a glob filter", async () => {
    const { deps, root } = setup();
    writeFileSync(join(root, "a.ts"), "shared_term\n");
    writeFileSync(join(root, "b.md"), "shared_term\n");

    const tool = createGrepTool(deps);
    const result = await tool.handler({ pattern: "shared_term", glob: "*.ts" }, { signal });
    if (isMissingBinary(result.content)) return;

    expect(result.content).toContain("a.ts");
    expect(result.content).not.toContain("b.md");
  });

  test("takes rg's regex and glob with or without rg: alternation, \\d, **/ and a leading dash; skips .git", async () => {
    const { deps, root } = setup();
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "src", "a.ts"), "const MAX_ITEMS = 200;\nfunction prune() {}\n-flag here\n");
    writeFileSync(join(root, "src", "b.md"), "prune\n");
    writeFileSync(join(root, ".git", "index"), "prune\0binary\n");

    const tool = createGrepTool(deps);
    const result = await tool.handler({ pattern: "MAX_\\w+ = \\d+|prune", glob: "**/*.ts" }, { signal });
    if (isMissingBinary(result.content)) return;
    expect(result.content).toContain("MAX_ITEMS = 200");
    expect(result.content).toContain("function prune()");
    expect(result.content).not.toContain("b.md");
    expect(result.content).not.toContain(".git");
    expect((await tool.handler({ pattern: "-flag" }, { signal })).content).toContain("-flag here");
  });

  test("rejects a search root outside the sandbox", async () => {
    const { deps } = setup();
    const tool = createGrepTool(deps);
    await expect(tool.handler({ pattern: "x", path: "../../etc" }, { signal })).rejects.toThrow();
  });

  test("with neither rg nor grep on PATH, as on Windows, it searches in process with the same output", async () => {
    const { deps, root } = setup();
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, ".gitignore"), "dist/\n");
    writeFileSync(join(root, "src", "a.ts"), "one\nconst MAX_ITEMS = 200;\nthree\nfunction prune() {}\n");
    writeFileSync(join(root, "src", "b.md"), "prune\n");
    writeFileSync(join(root, "dist", "a.ts"), "prune\n");
    writeFileSync(join(root, "src", "c.ts"), "prune\0binary\n");
    const original = Bun.spawn;
    (Bun as unknown as { spawn: unknown }).spawn = () => {
      throw new Error("not found");
    };
    try {
      const tool = createGrepTool(deps);
      const result = await tool.handler(
        { pattern: "(?i)max_\\w+ = \\d+|PRUNE\\(", glob: "*.ts" },
        { signal },
      );
      expect(result.content).toBe(
        [
          `${join(root, "src/a.ts")}:2:const MAX_ITEMS = 200;`,
          `${join(root, "src/a.ts")}:4:function prune() {}`,
        ].join("\n"),
      );
      const around = await tool.handler({ pattern: "three", context: 1, type: "ts" }, { signal });
      expect(around.content.split("\n").map((line) => line.slice(join(root, "src/a.ts").length))).toEqual([
        "-2-const MAX_ITEMS = 200;",
        ":3:three",
        "-4-function prune() {}",
      ]);
      const files = await tool.handler({ pattern: "prune", filesOnly: true }, { signal });
      expect(files.content.split("\n").sort()).toEqual(
        [join(root, "src/a.ts"), join(root, "src/b.md")].sort(),
      );
      expect((await tool.handler({ pattern: "(" }, { signal })).isError).toBe(true);
    } finally {
      (Bun as unknown as { spawn: unknown }).spawn = original;
    }
  });

  test("a long matching line keeps its start, so one minified file cannot fill the result", async () => {
    const { deps, root } = setup();
    writeFileSync(join(root, "bundle.min.js"), `var target=1;${"x".repeat(50_000)}\n`);
    writeFileSync(join(root, "b.ts"), "const target = 2;\n");

    const result = await createGrepTool(deps).handler({ pattern: "target" }, { signal });
    if (isMissingBinary(result.content)) return;

    expect(result.content.length).toBeLessThan(2_000);
    expect(result.content).toContain("var target=1;");
    expect(result.content).toContain("more characters on this line");
    expect(result.content).toContain("const target = 2;");
  });
});
