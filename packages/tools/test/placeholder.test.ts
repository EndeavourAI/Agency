import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { createWriteTool } from "../src/builtins/write.ts";
import { newPlaceholder } from "../src/placeholder.ts";
import { SnapshotStore } from "../src/snapshot.ts";

test("a line that stands for left-out code is found, code and prose are not", () => {
  for (const line of [
    "// ... rest of code ...",
    "    # rest of the file ...",
    "(rest of methods ...)",
    "// ... existing code ...",
    "/* unchanged code ... */",
    "<!-- … remaining content … -->",
  ])
    expect(newPlaceholder(`a\n${line}\nb`)).toBe(line.trim());
  for (const text of [
    "const rest = args.slice(1); // rest of args",
    "print('loading...')",
    "// The rest of the code handles errors...and retries",
    "# existing code paths are kept",
  ])
    expect(newPlaceholder(text)).toBeUndefined();
  // A placeholder that the file had already is the file's own text.
  expect(newPlaceholder("x\n// ... existing code ...", "// ... existing code ...\n")).toBeUndefined();
});

test("write refuses a placeholder and leaves the file", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-placeholder-")));
  const snaps = realpathSync(mkdtempSync(join(tmpdir(), "agency-placeholder-snap-")));
  try {
    writeFileSync(join(root, "a.py"), "def a():\n    return 1\n\ndef b():\n    return 2\n");
    const tool = createWriteTool(
      { identity: { type: "user" }, capabilities: FULL_CAPABILITIES, sandbox: new SandboxBoundary(root) },
      new SnapshotStore(snaps),
      {},
    );
    const result = await tool.handler(
      { path: "a.py", content: "def a():\n    return 10\n\n# ... rest of code ...\n" },
      { signal: new AbortController().signal },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"# ... rest of code ..."');
    expect(readFileSync(join(root, "a.py"), "utf8")).toContain("def b()");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(snaps, { recursive: true, force: true });
  }
});
