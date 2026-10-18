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
    expect(result.content).toContain("\n2:const");
  });

  test("names each file once, above its match lines, as rg --heading prints them", async () => {
    const { deps, root } = setup();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "hit one\nmiss\nhit two\n");
    writeFileSync(join(root, "src", "b.ts"), "miss\nhit three\n");

    const tool = createGrepTool(deps);
    const result = await tool.handler({ pattern: "hit" }, { signal });
    if (isMissingBinary(result.content)) return;

    // Live: broad greps sent 21K characters, and the path repeated on each line was a large part of them.
    expect(result.content).toContain("src/a.ts\n1:hit one\n3:hit two");
    expect(result.content).toContain("src/b.ts\n2:hit three");
    expect(result.content).not.toContain("src/a.ts:");
    expect(
      tool.renderResult!({ content: result.content, isError: false, input: { pattern: "hit" } }),
    ).toStartWith("grep hit: 3 matches");
  });

  test("a code-mode script gets the matches as objects, or the paths with filesOnly", async () => {
    const { deps, root } = setup();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "hit:7: one\nmiss\nhit two\n");

    const tool = createGrepTool(deps);
    const result = await tool.handler({ pattern: "hit" }, { signal });
    if (isMissingBinary(result.content)) return;
    expect(result.value).toEqual([
      { path: "src/a.ts", line: 1, text: "hit:7: one" },
      { path: "src/a.ts", line: 3, text: "hit two" },
    ]);
    expect((await tool.handler({ pattern: "hit", filesOnly: true }, { signal })).value).toEqual(["src/a.ts"]);
    expect((await tool.handler({ pattern: "nothing" }, { signal })).value).toEqual([]);
    expect((await tool.handler({ pattern: "hit", context: 1 }, { signal })).value).toBeUndefined();
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
    // A `\` with a `*` in the pattern: Git's grep on Windows got `+.*` and failed with "nothing to repeat".
    expect((await tool.handler({ pattern: "-\\w+.*here" }, { signal })).content).toContain("-flag here");
    expect((await tool.handler({ pattern: "\\(\\).*\\{" }, { signal })).content).toContain(
      "function prune()",
    );
    // Each path is relative to the workspace, which read takes, also for a folder or a file as the root.
    expect(result.content).toMatch(/^src[\\/]a\.ts\n1:const MAX_ITEMS/);
    for (const path of ["src", "src/a.ts"]) {
      const scoped = await tool.handler({ pattern: "prune", path }, { signal });
      expect([path, scoped.content]).toEqual([
        path,
        expect.stringMatching(/^src[\\/]a\.ts\n2:function prune/m),
      ]);
    }
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
      expect(result.content.split("\n\n[The code around")[0]).toBe(
        ["src/a.ts", "2:const MAX_ITEMS = 200;", "4:function prune() {}"].join("\n"),
      );
      const around = await tool.handler({ pattern: "three", context: 1, type: "ts" }, { signal });
      expect(around.content.split("\n").map((line) => line.slice("src/a.ts".length))).toEqual([
        "-2-const MAX_ITEMS = 200;",
        ":3:three",
        "-4-function prune() {}",
      ]);
      const files = await tool.handler({ pattern: "prune", filesOnly: true }, { signal });
      expect(files.content.split("\n").sort()).toEqual(["src/a.ts", "src/b.md"].sort());
      expect((await tool.handler({ pattern: "(" }, { signal })).isError).toBe(true);
    } finally {
      (Bun as unknown as { spawn: unknown }).spawn = original;
    }
  });

  test("a grep that hits one or two files shows the code around each match, from its declaration", async () => {
    const { deps, root } = setup();
    mkdirSync(join(root, "src"));
    const body = Array.from({ length: 30 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    writeFileSync(
      join(root, "src", "a.ts"),
      `import x from "./x";\n\nexport function first() {\n${body}\n  return target;\n}\n\nexport function second() {\n  return 2;\n}\n`,
    );
    const tool = createGrepTool(deps);
    const result = await tool.handler({ pattern: "target" }, { signal });
    if (isMissingBinary(result.content)) return;
    // Live: after such a grep, 82% of the next slice reads held a match line.
    const [matches, code] = result.content.split(
      "\n\n[The code around these matches, as a read of these lines gives it:]\n",
    );
    expect(matches).toBe("src/a.ts\n34:  return target;");
    expect(code?.split("\n")[0]).toBe("src/a.ts");
    expect(code?.split("\n")[1]).toBe("14\t  const v10 = 10;");
    expect(code?.split("\n").at(-1)).toBe("36\t");
    for (const many of ["b", "c"]) writeFileSync(join(root, "src", `${many}.ts`), "const target = 1;\n");
    expect((await tool.handler({ pattern: "target" }, { signal })).content).not.toContain("[The code around");
    expect(
      (await tool.handler({ pattern: "target", path: "src/a.ts", context: 1 }, { signal })).content,
    ).not.toContain("[The code around");
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
