import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { createEditTool } from "../src/builtins/edit.ts";
import { applyChunks, parsePatch } from "../src/patch.ts";
import { SnapshotStore } from "../src/snapshot.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const signal = new AbortController().signal;
const patch = (...body: string[]) => ["*** Begin Patch", ...body, "*** End Patch"].join("\n");

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-patch-")));
  const snapshotDir = realpathSync(mkdtempSync(join(tmpdir(), "agency-patch-snap-")));
  dirs.push(root, snapshotDir);
  const tool = createEditTool(
    { identity: { type: "user" }, capabilities: FULL_CAPABILITIES, sandbox: new SandboxBoundary(root) },
    new SnapshotStore(snapshotDir),
    {},
  );
  return { root, tool };
}

test("an update places each change after its @@ line, and keeps the final newline", () => {
  const ops = parsePatch(
    patch(
      "*** Update File: a.py",
      "@@ def two():",
      "-    return 1",
      "+    return 2",
      "@@",
      " x = 0",
      "+y = 1",
    ),
  );
  if (typeof ops === "string") throw new Error(ops);
  expect(ops).toHaveLength(1);
  const file = "def one():\n    return 1\n\ndef two():\n    return 1\nx = 0\n";
  const update = ops[0] as Extract<(typeof ops)[0], { kind: "update" }>;
  expect(applyChunks(file, update.chunks)).toBe(
    "def one():\n    return 1\n\ndef two():\n    return 2\nx = 0\ny = 1\n",
  );
});

test("a fault names what is wrong", () => {
  expect(parsePatch("*** Update File: a")).toContain("Begin Patch");
  expect(parsePatch(patch("*** Rename File: a"))).toContain("expected");
  const ops = parsePatch(patch("*** Update File: a", "@@", "-nope", "+yes"));
  if (typeof ops === "string") throw new Error(ops);
  const update = ops[0] as Extract<(typeof ops)[0], { kind: "update" }>;
  expect(String(applyChunks("a\n", update.chunks))).toContain("does not have these lines");
});

test("edit takes a patch of one file: update, add and delete", async () => {
  const { root, tool } = setup();
  writeFileSync(join(root, "a.txt"), "one\ntwo\n");
  const updated = await tool.handler(
    { path: "a.txt", patch: patch("*** Update File: a.txt", "@@", " one", "-two", "+three") },
    { signal },
  );
  expect(updated.isError).toBeFalsy();
  expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\nthree\n");

  await tool.handler({ path: "new/b.txt", patch: patch("*** Add File: new/b.txt", "+hi") }, { signal });
  expect(readFileSync(join(root, "new/b.txt"), "utf8")).toBe("hi\n");

  await tool.handler({ path: "a.txt", patch: patch("*** Delete File: a.txt") }, { signal });
  expect(existsSync(join(root, "a.txt"))).toBe(false);
});

test("a patch of two files is refused: the permission rules check one path a call", async () => {
  const { root, tool } = setup();
  writeFileSync(join(root, "a.txt"), "one\n");
  const result = await tool.handler(
    { path: "a.txt", patch: patch("*** Delete File: a.txt", "*** Add File: b.txt", "+x") },
    { signal },
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("one apply_patch call for each of a.txt, b.txt");
  expect(existsSync(join(root, "a.txt"))).toBe(true);
});
