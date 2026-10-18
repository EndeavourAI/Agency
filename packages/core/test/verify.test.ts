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
import { untestedEdits, untestedNote } from "../src/verify.ts";

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
