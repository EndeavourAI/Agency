import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import type { Message } from "@agency/schema";
import { runTurn } from "../src/loop.ts";
import { buildTestMap, parseLcov } from "../src/testmap.ts";
import { missingOutputs, untestedEdits, untestedNote } from "../src/verify.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-verify-")));
  dirs.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "render.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "other.ts"), "export const b = 1;\n");
  writeFileSync(join(root, "test", "render.test.ts"), 'import { a } from "../src/render.ts";\n');
  writeFileSync(join(root, "test", "other.test.ts"), 'import { b } from "../src/other";\n');
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  return root;
}

const call = (id: string, name: string, input: Record<string, unknown>): Message => ({
  role: "assistant",
  content: [{ type: "tool_call", id, name, input }],
});
const result = (id: string, isError = false): Message => ({
  role: "user",
  content: [{ type: "tool_result", toolCallId: id, content: "ok", isError }],
});

test("names the tests that import a file the turn changed and that no command of the turn ran", () => {
  const root = repo();
  const edited = [call("e1", "edit", { path: "src/render.ts" }), result("e1")];
  // Live: a model changed grep.ts, ran only its new test, and left the test of grep.ts that it broke.
  expect(untestedEdits(edited, root)).toEqual(["test/render.test.ts"]);
  const ran = [...edited, call("b1", "bash", { command: "bun test test/render.test.ts" }), result("b1")];
  expect(untestedEdits(ran, root)).toEqual([]);
  const suite = [...edited, call("b2", "bash", { command: "cd test && bun test" }), result("b2", true)];
  expect(untestedEdits(suite, root)).toEqual([]);
  const failedEdit = [call("e2", "edit", { path: "src/other.ts" }), result("e2", true)];
  expect(untestedEdits(failedEdit, root)).toEqual([]);
  expect(untestedEdits([call("e3", "write", { path: "src/other.ts" }), result("e3")], root)).toEqual([
    "test/other.test.ts",
  ]);
  // Live: the test that a changed grep.ts broke imported it through builtin-set.ts, two hops away.
  writeFileSync(join(root, "src", "set.ts"), 'export * from "./other.ts";\n');
  writeFileSync(join(root, "test", "set.test.ts"), 'import "../src/set";\n');
  execFileSync("git", ["add", "."], { cwd: root });
  expect(untestedEdits([call("e4", "edit", { path: "src/other.ts" }), result("e4")], root)).toEqual([
    "test/other.test.ts",
    "test/set.test.ts",
  ]);
  // A file whose own test ran is tested: live, a list of 28 far tests had a model search four replies for the ones
  // that mattered after it had run the test of the file that it changed.
  const own = [
    call("e5", "edit", { path: "src/other.ts" }),
    result("e5"),
    call("b5", "bash", { command: "bun test test/other.test.ts" }),
    result("b5"),
  ];
  expect(untestedEdits(own, root)).toEqual([]);
});

test("with a coverage map, only the tests that ran a changed line are named", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-verify-map-")));
  dirs.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  const source = "export function one() {\n  return 1;\n}\n\nexport function two() {\n  return 2;\n}\n";
  writeFileSync(join(root, "src", "math.ts"), source);
  const testOf = (name: string, value: number) =>
    `import { expect, test } from "bun:test";\nimport { ${name} } from "../src/math.ts";\ntest("${name}", () => expect(${name}()).toBe(${value}));\n`;
  writeFileSync(join(root, "test", "one.test.ts"), testOf("one", 1));
  writeFileSync(join(root, "test", "two.test.ts"), testOf("two", 2));
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "x"],
  ])
    execFileSync("git", args, { cwd: root });
  // Both tests import math.ts: the import graph names both, the map only the test that runs `two`.
  const changed = source.replace("return 2;", "return 3;");
  const edited = [call("e1", "edit", { path: "src/math.ts" }), result("e1")];
  writeFileSync(join(root, "src", "math.ts"), changed);
  expect(untestedEdits(edited, root).sort()).toEqual(["test/one.test.ts", "test/two.test.ts"]);
  writeFileSync(join(root, "src", "math.ts"), source);
  const map = await buildTestMap(root);
  expect(map.tests.sort()).toEqual(["test/one.test.ts", "test/two.test.ts"]);
  writeFileSync(join(root, "src", "math.ts"), changed);
  expect(untestedEdits(edited, root)).toEqual(["test/two.test.ts"]);
  // A changed file that the map lacks falls back to the graph.
  writeFileSync(join(root, "src", "new.ts"), "export const n = 1;\n");
  const added = [...edited, call("w1", "write", { path: "src/new.ts" }), result("w1")];
  expect(untestedEdits(added, root, map).sort()).toEqual(["test/one.test.ts", "test/two.test.ts"]);
}, 60_000);

test("an lcov report gives the lines that ran, by path with forward slashes", () => {
  const report =
    "SF:src\\math.ts\nDA:1,3\nDA:2,0\nDA:5,1\nend_of_record\nSF:src/b.ts\nDA:1,0\nend_of_record\n";
  expect([...parseLcov(report)]).toEqual([
    ["src/math.ts", [1, 5]],
    ["src/b.ts", []],
  ]);
});

test("the note names five tests and the folders of the rest", () => {
  const note = untestedNote([
    "a/1.test.ts",
    "a/2.test.ts",
    "a/3.test.ts",
    "a/4.test.ts",
    "a/5.test.ts",
    "b/6.test.ts",
  ]);
  expect(note).toContain("a/5.test.ts and 1 more in b.");
  expect(note).not.toContain("6.test.ts");
});

test("a turn that would end with such a test unrun is told once, and goes on", async () => {
  const root = repo();
  const seen: ProviderRequest[] = [];
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      seen.push(request);
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (seen.length === 1) {
        yield { type: "tool_call_start", id: "c1", name: "edit" };
        yield {
          type: "tool_call_delta",
          id: "c1",
          inputJsonDelta: JSON.stringify({ path: "src/render.ts" }),
        };
        yield { type: "tool_call_end", id: "c1" };
        yield { type: "message_stop", stopReason: "tool_use", usage };
        return;
      }
      yield { type: "text_delta", text: "done" };
      yield { type: "message_stop", stopReason: "end_turn", usage };
    },
  };
  const http: HttpClient = { fetch: async () => new Response() };
  const edit = {
    name: "edit",
    description: "edit",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    handler: async () => ({ content: "edited" }),
  };
  await runTurn(adapter, new Scheduler({ maxAttempts: 1 }), http, {
    identity: { type: "user" },
    capabilities: FULL_CAPABILITIES,
    systemPrompt: "sys",
    model: "m",
    apiKey: "k",
    cwd: root,
    verifyEdits: true,
    session: [{ role: "user", content: [{ type: "text", text: "change render" }] }],
    tools: [edit],
  });
  expect(seen).toHaveLength(3);
  const note = seen[2]?.messages.at(-1)?.content[0];
  expect(note?.type === "text" ? note.text : "").toContain("test/render.test.ts");
});

test("the files a task names that do not exist, in a folder that does, are its missing outputs", () => {
  const root = repo();
  const prompt =
    "Compress /DATA/x into src/data.comp and write the word to src/solution.txt. Read src/render.ts. " +
    "See https://example.com/a/b.html, version 1.2, e.g. a sketch at /path/to/out.txt.";
  // Absolute and relative: the test uses the repo as the root of both.
  expect(missingOutputs(prompt.replace("/DATA/x", `${root}/src/render.ts`), root)).toEqual([
    "src/data.comp",
    "src/solution.txt",
  ]);
  // An absolute path, as Terminal-Bench names its outputs (/app/solution.txt): POSIX paths only.
  if (process.platform !== "win32")
    expect(missingOutputs(`write it to ${root}/src/out.json`, root)).toEqual([`${root}/src/out.json`]);
});

test("a turn that ends while a file the task named is missing is sent back once", async () => {
  const root = repo();
  const seen: ProviderRequest[] = [];
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      seen.push(request);
      yield { type: "text_delta", text: "I could not finish." };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  await runTurn(
    adapter,
    new Scheduler({ maxAttempts: 1 }),
    { fetch: async () => new Response() },
    {
      identity: { type: "user" },
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      model: "m",
      apiKey: "k",
      cwd: root,
      verifyEdits: true,
      session: [{ role: "user", content: [{ type: "text", text: "Write the answer to src/solution.txt" }] }],
      tools: [],
    },
  );
  expect(seen).toHaveLength(2);
  const note = seen[1]?.messages.at(-1)?.content[0];
  expect(note?.type === "text" ? note.text : "").toContain(
    "the task names src/solution.txt, and it does not exist",
  );
});

test("a headless turn that used tools looks back at the task once before it ends", async () => {
  const root = repo();
  const run = async (reviewTask: boolean) => {
    const seen: ProviderRequest[] = [];
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        seen.push(request);
        const usage = { inputTokens: 1, outputTokens: 1 };
        if (seen.length === 1) {
          yield { type: "tool_call_start", id: "c1", name: "noop" };
          yield { type: "tool_call_delta", id: "c1", inputJsonDelta: "{}" };
          yield { type: "tool_call_end", id: "c1" };
          yield { type: "message_stop", stopReason: "tool_use", usage };
          return;
        }
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage };
      },
    };
    await runTurn(
      adapter,
      new Scheduler({ maxAttempts: 1 }),
      { fetch: async () => new Response() },
      {
        identity: { type: "user" },
        capabilities: FULL_CAPABILITIES,
        systemPrompt: "sys",
        model: "m",
        apiKey: "k",
        cwd: root,
        verifyEdits: true,
        reviewTask,
        session: [
          { role: "user", content: [{ type: "text", text: "Build it from the Debian source in the root." }] },
        ],
        tools: [
          { name: "noop", description: "noop", inputSchema: {}, handler: async () => ({ content: "ok" }) },
        ],
      },
    );
    return seen;
  };
  const reviewed = await run(true);
  expect(reviewed).toHaveLength(3);
  const note = reviewed[2]?.messages.at(-1)?.content[0];
  expect(note?.type === "text" ? note.text : "").toContain(
    "The task was:\n\nBuild it from the Debian source in the root.",
  );
  expect(await run(false)).toHaveLength(2);
});
