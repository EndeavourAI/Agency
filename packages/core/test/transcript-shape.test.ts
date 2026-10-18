import { expect, test } from "bun:test";
import { join } from "node:path";
import { FULL_CAPABILITIES } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import type { Message } from "@agency/schema";
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

async function run(steps: Array<Array<[string, Record<string, unknown>]>>) {
  const seen: ProviderRequest[] = [];
  const stored: Message[] = [];
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
    tools: [tool("read", true), tool("grep", true), tool("edit", false)],
    onMessage: (message) => {
      stored.push(structuredClone(message));
    },
  });
  const shape = (messages: Message[]) =>
    messages.map((m) => `${m.role}:${m.content.map((b) => b.type).join(",")}`);
  return { seen, stored, inputs, shape };
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

test("the first two serial read-only replies of a turn are shown to the model as one reply with both calls", async () => {
  const { seen, stored, shape } = await run([[["read", { path: "a.ts" }]], [["grep", { pattern: "x" }]]]);

  // Live: sessions whose first reply made one call went on at 1.1 calls a reply (26.7 replies), the others at 2.6.
  expect(shape(seen[2]?.messages ?? [])).toEqual([
    "user:text",
    "assistant:tool_call,tool_call",
    "user:tool_result,tool_result",
  ]);
  // The session stores what the model saw, so the next turn of the session appends to the same prefix.
  expect(shape(stored)).toEqual([
    "assistant:tool_call,tool_call",
    "user:tool_result,tool_result",
    "assistant:text",
  ]);
});

test("a first reply that writes, or a later pair, is not folded", async () => {
  const writes = await run([[["edit", { path: "a.ts" }]], [["read", { path: "a.ts" }]]]);
  expect(writes.shape(writes.seen[2]?.messages ?? [])).toHaveLength(5);
  const later = await run([
    [
      ["read", { path: "a.ts" }],
      ["grep", { pattern: "x" }],
    ],
    [["read", { path: "b.ts" }]],
    [["read", { path: "c.ts" }]],
  ]);
  expect(later.shape(later.seen[3]?.messages ?? [])).toHaveLength(7);
});
