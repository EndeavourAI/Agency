import { expect, test } from "bun:test";
import { FULL_CAPABILITIES } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import { runTurn } from "../src/loop.ts";

const http: HttpClient = { fetch: async () => new Response() };
const usage = { inputTokens: 1, outputTokens: 1 };

test("a reply that the network cuts is asked for again, and the turn ends with the answer", async () => {
  let requests = 0;
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      requests += 1;
      if (requests === 1) {
        yield { type: "text_delta", text: "Let me look" };
        // Live: "The socket connection was closed unexpectedly" ended 3 of 31 sessions in the middle of a reply.
        throw new Error("The socket connection was closed unexpectedly");
      }
      yield { type: "text_delta", text: "done" };
      yield { type: "message_stop", stopReason: "end_turn", usage };
    },
  };
  const result = await runTurn(adapter, new Scheduler({ maxAttempts: 1 }), http, {
    identity: { type: "user" },
    capabilities: FULL_CAPABILITIES,
    systemPrompt: "sys",
    model: "m",
    apiKey: "k",
    session: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    tools: [],
  });
  expect(requests).toBe(2);
  expect(result.error).toBeUndefined();
  expect(result.messages.at(-1)?.content).toEqual([{ type: "text", text: "done" }]);
});
