import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import { runTurn } from "../src/loop.ts";
import { namedFiles } from "../src/prefetch.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-prefetch-")));
  dirs.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "render.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "README.md"), "# hi\n");
  return root;
}

test("names the files of the workspace that a prompt names, once each and at most four", () => {
  const root = workspace();
  for (const n of [1, 2, 3, 4]) writeFileSync(join(root, `f${n}.ts`), "x");
  expect(namedFiles("The test src/render.ts fails; see `./src/render.ts` and README.md.", root)).toEqual([
    "src/render.ts",
    "README.md",
  ]);
  expect(namedFiles("open https://x.test/src/render.ts, src/missing.ts or src", root)).toEqual([]);
  expect(namedFiles("f1.ts f2.ts f3.ts f4.ts README.md", root)).toHaveLength(4);
  expect(namedFiles("../outside.ts", root)).toEqual([]);
});

test("a named test file brings the files that it imports by a relative path", () => {
  const root = workspace();
  mkdirSync(join(root, "test"));
  writeFileSync(
    join(root, "test", "render.test.ts"),
    'import { expect } from "bun:test";\nimport { a } from "../src/render.ts";\nimport { b } from "../src/missing";\n',
  );
  writeFileSync(join(root, "src", "util.js"), "x");
  writeFileSync(join(root, "src", "util.test.js"), "const u = require('./util');\n");
  // Live: in each debug session the next read after the failing test was the file that it imports.
  expect(namedFiles("test/render.test.ts fails", root)).toEqual(["test/render.test.ts", "src/render.ts"]);
  expect(namedFiles("src/util.test.js fails", root)).toEqual(["src/util.test.js", "src/util.js"]);
  expect(namedFiles("src/render.ts", root)).toEqual(["src/render.ts"]);
});

test("a turn starts with the named files read, so the first reply need not ask for them", async () => {
  const root = workspace();
  const seen: ProviderRequest[] = [];
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      seen.push(request);
      yield { type: "text_delta", text: "done" };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const http: HttpClient = { fetch: async () => new Response() };
  const read = {
    name: "read",
    description: "read",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    riskTier: "safe" as const,
    readOnly: () => true,
    handler: async (input: Record<string, unknown>) => ({ content: `text of ${String(input.path)}` }),
  };
  const options = {
    identity: { type: "user" as const },
    capabilities: FULL_CAPABILITIES,
    systemPrompt: "sys",
    model: "m",
    apiKey: "k",
    cwd: root,
    session: [{ role: "user" as const, content: [{ type: "text" as const, text: "fix src/render.ts" }] }],
    tools: [read],
  };
  // Live: the first reply of each debug and edit session read only the files that the prompt named.
  const result = await runTurn(adapter, new Scheduler({ maxAttempts: 1 }), http, {
    ...options,
    prefetchNamedFiles: true,
  });
  const first = seen[0]?.messages ?? [];
  expect(first.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(first[1]?.content).toEqual([
    { type: "tool_call", id: expect.any(String), name: "read", input: { path: "src/render.ts" } },
  ]);
  expect(first[2]?.content[0]).toMatchObject({ type: "tool_result", content: "text of src/render.ts" });
  expect(result.messages).toHaveLength(4);

  seen.length = 0;
  await runTurn(adapter, new Scheduler({ maxAttempts: 1 }), http, options);
  expect(seen[0]?.messages).toHaveLength(1);
});
