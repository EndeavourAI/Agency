import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { createReadTool } from "../src/builtins/read.ts";
import { createWriteTool } from "../src/builtins/write.ts";
import type { ToolDeps } from "../src/contract.ts";
import { lineDelta } from "../src/hashline.ts";
import { SnapshotStore } from "../src/snapshot.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const signal = new AbortController().signal;

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-meta-")));
  const snap = realpathSync(mkdtempSync(join(tmpdir(), "agency-meta-snap-")));
  dirs.push(root, snap);
  const deps: ToolDeps = {
    identity: { type: "user" },
    capabilities: { ...FULL_CAPABILITIES, pathScopes: [root] },
    sandbox: new SandboxBoundary(root),
  };
  return { deps, root, snapshots: new SnapshotStore(snap) };
}

describe("lineDelta", () => {
  test("counts what changed, not the lines around it", () => {
    expect(lineDelta("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({ added: 2, removed: 1 });
    expect(lineDelta("", "x\ny\n")).toEqual({ added: 2, removed: 0 });
    expect(lineDelta("same\n", "same\n")).toEqual({ added: 0, removed: 0 });
  });

  test("a line added at the top and one at the bottom of a big file count as two", () => {
    const big = `${Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n")}\n`;
    expect(lineDelta(big, `TOP\n${big}BOTTOM\n`)).toEqual({ added: 2, removed: 0 });
  });

  test("a huge rewrite stays cheap and a CRLF to LF rewrite is not a no-op", () => {
    const huge = `${Array.from({ length: 300_000 }, (_, i) => `line ${i}`).join("\n")}\n`;
    const started = performance.now();
    expect(lineDelta(huge, "replacement\n")).toEqual({ added: 1, removed: 300_000 });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(lineDelta("a\r\nb\r\n", "a\nb\n")).toEqual({ added: 2, removed: 2 });
  });
});

describe("tool meta", () => {
  test("write reports +N -M against the old file", async () => {
    const { deps, root, snapshots } = setup();
    writeFileSync(join(root, "a.ts"), "one\ntwo\nthree\n");
    const r = await createWriteTool(deps, snapshots, {}).handler(
      { path: "a.ts", content: "one\n2\nthree\nfour\n" },
      { signal },
    );
    expect(r.meta).toEqual({ added: 2, removed: 1 });
  });

  test("read reports the line count of the file", async () => {
    const { deps, root } = setup();
    writeFileSync(join(root, "a.ts"), "1\n2\n3\n4\n");
    const r = await createReadTool(deps, {}).handler({ path: "a.ts" }, { signal });
    expect(r.meta).toEqual({ lines: 4 });
  });
});
