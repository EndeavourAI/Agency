import { expect, test } from "bun:test";
import { FULL_CAPABILITIES } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import { runTurn, type ToolSpec } from "../src/loop.ts";

const http: HttpClient = { fetch: async () => new Response() };
const usage = { inputTokens: 1, outputTokens: 1 };

/** One reply for each entry: the calls of that reply, then a final answer. */
function replies(
  steps: Array<Array<[string, Record<string, unknown>]>>,
  seen: ProviderRequest[],
): ProviderAdapter {
  return {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      seen.push(request);
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

const tool = (name: string, readOnly: boolean): ToolSpec => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
  riskTier: readOnly ? "safe" : "dangerous",
  readOnly: () => readOnly,
  handler: async () => ({ content: `${name} result` }),
});

async function notes(steps: Array<Array<[string, Record<string, unknown>]>>): Promise<string[]> {
  const seen: ProviderRequest[] = [];
  await runTurn(replies(steps, seen), new Scheduler({ maxAttempts: 1 }), http, {
    identity: { type: "user" },
    capabilities: FULL_CAPABILITIES,
    systemPrompt: "sys",
    model: "m",
    apiKey: "k",
    session: [{ role: "user", content: [{ type: "text", text: "look around" }] }],
    tools: [tool("read", true), tool("grep", true), tool("edit", false)],
  });
  return seen.flatMap((request) => {
    const block = request.messages.at(-1)?.content.at(-1);
    return block?.type === "tool_result" && block.content.includes("[harness:") ? [block.content] : [];
  });
}

test("three replies in a row of one read-only call each get one reminder that reads can share a reply", async () => {
  // Live: research sessions ran 21 reads in 22 replies, each reply a round trip that sent the whole history again.
  const serial = await notes([
    [["read", { path: "a" }]],
    [["grep", { pattern: "x" }]],
    [["read", { path: "b" }]],
    [["read", { path: "c" }]],
  ]);
  expect(serial).toHaveLength(1);
  expect(serial[0]).toContain("in one reply");
  expect(
    await notes([
      [["read", {}]],
      [
        ["read", {}],
        ["grep", {}],
      ],
      [["read", {}]],
    ]),
  ).toHaveLength(0);
  expect(await notes([[["read", {}]], [["edit", {}]], [["read", {}]]])).toHaveLength(0);
});
