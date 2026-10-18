import { expect, test } from "bun:test";
import { join } from "node:path";
import { FULL_CAPABILITIES } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import { runTurn, type ToolSpec } from "../src/loop.ts";

const http: HttpClient = { fetch: async () => new Response() };
const usage = { inputTokens: 1, outputTokens: 1 };
const cwd = join(import.meta.dir, "ws");

/** One reply for each entry: the calls of that reply, then a final answer. */
function replies(
  steps: Array<Array<[string, Record<string, unknown>]>>,
  seen: ProviderRequest[],
): ProviderAdapter {
  return {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      seen.push({ ...request, messages: structuredClone(request.messages) });
      const step = steps[seen.length - 1];
      if (step === undefined) {
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage };
        return;
      }
      for (const [index, [name, input]] of step.entries()) {
        const id = `c${seen.length}_${index}`;
        yield { type: "tool_call_start", id, name };
        yield { type: "tool_call_delta", id, inputJsonDelta: JSON.stringify(input) };
        yield { type: "tool_call_end", id };
      }
      yield { type: "message_stop", stopReason: "tool_use", usage };
    },
  };
}

async function run(steps: Array<Array<[string, Record<string, unknown>]>>, deny?: string) {
  const seen: ProviderRequest[] = [];
  const inputs: Array<Record<string, unknown>> = [];
  const tool = (name: string, readOnly: boolean): ToolSpec => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    riskTier: readOnly ? "safe" : "dangerous",
    readOnly: () => readOnly,
    handler: async (input) => {
      inputs.push(input);
      return { content: `${name} result` };
    },
  });
  await runTurn(replies(steps, seen), new Scheduler({ maxAttempts: 1 }), http, {
    identity: { type: "user" },
    capabilities: FULL_CAPABILITIES,
    systemPrompt: "sys",
    model: "m",
    apiKey: "k",
    cwd,
    session: [{ role: "user", content: [{ type: "text", text: "look around" }] }],
    tools: [tool("read", true)],
    ...(deny === undefined
      ? {}
      : { toolPolicy: { check: async (request) => (request.path === deny ? "deny" : "allow") } }),
  });
  return { seen, inputs };
}

test("an absolute path inside the project reaches the model's history relative, and the tool as sent", async () => {
  const inside = join(cwd, "src", "a.ts");
  const outside = join(cwd, "..", "elsewhere.ts");
  const { seen, inputs } = await run([[["read", { path: inside }]], [["read", { path: outside }]]]);

  // Live: a session whose first call wrote the absolute root wrote it in every later call; the model copies itself.
  expect(inputs[0]).toEqual({ path: inside });
  const call = seen[1]?.messages[1]?.content[0];
  expect(call?.type === "tool_call" && call.input).toEqual({ path: "src/a.ts" });
  const last = seen[2]?.messages
    .flatMap((m) => m.content)
    .filter((b) => b.type === "tool_call")
    .at(-1);
  expect(last?.type === "tool_call" && last.input).toEqual({ path: outside });
});

test("a read of several paths runs as one read a path, each under the rules of a read", async () => {
  const { seen, inputs } = await run([[["read", { paths: ["a.ts", "secret.env", "b.ts"] }]]], "secret.env");

  // Live: runs that made one call a reply read unrelated files one reply each (truncate.ts, bash.ts, read.ts, grep.ts).
  expect(inputs).toEqual([{ path: "a.ts" }, { path: "b.ts" }]);
  const sent = seen[1]?.messages.flatMap((m) => m.content) ?? [];
  expect(sent.filter((b) => b.type === "tool_call").map((b) => b.type === "tool_call" && b.input)).toEqual([
    { path: "a.ts" },
    { path: "secret.env" },
    { path: "b.ts" },
  ]);
  const results = sent.filter((b) => b.type === "tool_result");
  expect(results.map((b) => b.type === "tool_result" && b.isError === true)).toEqual([false, true, false]);
});
