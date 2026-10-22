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
