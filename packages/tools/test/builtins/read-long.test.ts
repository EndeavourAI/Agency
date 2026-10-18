import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { createReadTool } from "../../src/builtins/read.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const signal = new AbortController().signal;

function readOf(name: string, text: string, range: { offset?: number; limit?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-read-long-")));
  dirs.push(root);
  writeFileSync(join(root, name), text);
  const tool = createReadTool({
    identity: { type: "user" },
    capabilities: FULL_CAPABILITIES,
    sandbox: new SandboxBoundary(root),
  });
  return tool.handler({ path: name, ...range }, { signal });
}

test("a whole read of a large source file gives its outline, and a range gives the lines", async () => {
  const body = Array.from({ length: 40 }, (_, i) => `  const v${i} = compute(${i}); // ${"pad ".repeat(20)}`);
  const text = [
    'import { a } from "./a.ts";',
    "",
    "export interface Options {",
    ...body,
    "}",
    "export async function runTurn(options: Options) {",
    ...body,
    ...body,
    "}",
    "class Store {",
    "  async load() {}",
    ...body,
    "}",
    "function helper() {",
    ...body,
    "}",
  ].join("\n");
  const { content } = await readOf("big.ts", text);
  // Live: whole reads of 20 to 45 KB files were most of the input of a research session, sent again in each request.
  expect(content).toContain("    45  export async function runTurn(options: Options) {");
  expect(content).toContain("   127  class Store {");
  expect(content).toContain("helper()");
  expect(content).not.toContain("compute(3)");
  expect(content).toMatch(/\[The file has 211 lines .* read with offset and limit/);
  expect(Buffer.byteLength(content)).toBeLessThan(3_000);
  const { content: whole } = await readOf("big.ts", text, { offset: 1, limit: 2000 });
  expect(whole).toContain("compute(3)");
});

test("a large file with no outline to give comes as its head", async () => {
  const text = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
  const { content } = await readOf("long.txt", text);
  expect(content).toContain("  1000  line 1000\n");
});

test("a read of a long file stops where the loop would cut it, and says where the rest starts", async () => {
  const text = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
  const { content } = await readOf("long.txt", text);
  expect(content.startsWith("     1  line 1\n     2  line 2\n")).toBe(true);
  expect(content).toContain("  2000  line 2000\n");
  expect(content).not.toContain("line 2001");
  expect(content).toContain("The file has 5000 lines: these are lines 1 to 2000. Read with offset 2001");
});

test("lines that are long make the read stop before 50 KB", async () => {
  const text = Array.from({ length: 300 }, (_, i) => `${i + 1} ${"x".repeat(400)}`).join("\n");
  const { content } = await readOf("wide.txt", text);
  expect(Buffer.byteLength(content)).toBeLessThan(50_000);
  expect(content).toMatch(/these are lines 1 to \d+\. Read with offset \d+/);
});

test("a file under both limits comes whole, with no note", async () => {
  expect((await readOf("short.txt", "a\nb\n")).content).toBe("     1  a\n     2  b");
});
