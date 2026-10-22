/**
 * A real daemon (real handlers, real approval gate, real session store) with a scripted provider and two fake tools.
 * No network and no key: the provider is the only fake part. Used by the e2e test and by record-fixture.ts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentDaemon, createAgentDaemon } from "@agency/cli";
import type { ToolSpec } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import type { Message } from "@agency/schema";

const noopHttp: HttpClient = { fetch: async () => new Response() };

const usage = (inputTokens: number, outputTokens: number, costUsd: number) => ({
  inputTokens,
  outputTokens,
  cachedInputTokens: Math.floor(inputTokens / 2),
  costUsd,
});

const call = (id: string, name: string, input: Record<string, unknown>): StreamEvent[] => [
  { type: "tool_call_start", id, name } as StreamEvent,
  { type: "tool_call_delta", id, inputJsonDelta: JSON.stringify(input) } as StreamEvent,
  { type: "tool_call_end", id } as StreamEvent,
];

export const ANSWER =
  "Retries replace the failed trial in place:\n```sh\nharbor run -r 2 --retry-include RuntimeError\n```\n- `AgentSetupTimeoutError` is a machine fault too\n- a task that fails twice still counts as a fail\n";

/** One model request per entry, in order across all turns of the scenario. */
const REQUESTS: StreamEvent[][] = [
  // Turn 1: read, edit, then a command that waits for the person, then the answer.
  [
    { type: "thinking_delta", text: "Read the run script first, " } as StreamEvent,
    { type: "thinking_delta", text: "then change the retry flags." } as StreamEvent,
    { type: "text_delta", text: "Looking at the run script.\n" } as StreamEvent,
    ...call("c1", "read", { path: "packages/eval/harbor/run.sh" }),
    { type: "message_stop", stopReason: "tool_use", usage: usage(1200, 40, 0.004) } as StreamEvent,
  ],
  [
    ...call("c2", "edit", {
      path: "packages/eval/harbor/run.sh",
      oldText: '-o "$jobs" -y',
      newText: '-o "$jobs" -y \\\n  -r 2 --retry-include RuntimeError',
    }),
    ...call("c3", "bash", { command: "bash scripts/dry-run.sh" }),
    { type: "message_stop", stopReason: "tool_use", usage: usage(1500, 90, 0.006) } as StreamEvent,
  ],
  [
    ...ANSWER.split(/(?<=\n)/).map((text) => ({ type: "text_delta", text }) as StreamEvent),
    { type: "message_stop", stopReason: "end_turn", usage: usage(1800, 70, 0.005) } as StreamEvent,
  ],
  // Turn 2: a command that the person denies; the model answers after the refusal.
  [
    ...call("c4", "bash", { command: "rm -rf build" }),
    { type: "message_stop", stopReason: "tool_use", usage: usage(300, 20, 0.001) } as StreamEvent,
  ],
  [
    { type: "text_delta", text: "I did not run it.\n" } as StreamEvent,
    { type: "message_stop", stopReason: "end_turn", usage: usage(350, 12, 0.001) } as StreamEvent,
  ],
  // Turn 3 (reconnect test): a command that waits for an answer that never comes.
  [
    ...call("c5", "bash", { command: "git push origin main" }),
    { type: "message_stop", stopReason: "tool_use", usage: usage(100, 10, 0.001) } as StreamEvent,
  ],
  [
    { type: "text_delta", text: "Ran it.\n" } as StreamEvent,
    { type: "message_stop", stopReason: "end_turn", usage: usage(120, 5, 0.001) } as StreamEvent,
  ],
];

/** The scripted requests of each prompt start at these offsets; a request is picked by the prompt and its step. */
const STARTS: Array<[RegExp, number]> = [
  [/^Make the 54/, 0],
  [/^Now clean/, 3],
  [/./, 5],
];

function adapter(): ProviderAdapter {
  return {
    family: "fake",
    async *stream(request: { messages: Message[] }): AsyncIterable<StreamEvent> {
      const { messages } = request;
      const promptAt = messages.findLastIndex(
        (m) => m.role === "user" && m.content.some((c) => c.type === "text"),
      );
      const prompt = messages[promptAt]?.content.find((c) => c.type === "text");
      const text = prompt?.type === "text" ? prompt.text : "";
      const step = messages.slice(promptAt + 1).filter((m) => m.role === "assistant").length;
      const start = STARTS.find(([re]) => re.test(text))?.[1] ?? 5;
      for (const e of REQUESTS[start + step] ?? []) {
        yield e;
        // A little spacing keeps the recorded timings from all being zero.
        if (e.type === "text_delta" || e.type === "thinking_delta")
          await new Promise((r) => setTimeout(r, 2));
      }
    },
  } as unknown as ProviderAdapter;
}

const tools: ToolSpec[] = [
  {
    name: "read",
    description: "read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    riskTier: "safe",
    handler: async () => ({
      content: '#!/usr/bin/env bash\nset -euo pipefail\nharbor run --path tasks \\\n  -o "$jobs" -y\n',
    }),
  },
  {
    name: "edit",
    description: "edit a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    riskTier: "moderate",
    handler: async () => ({ content: "edited" }),
  },
  {
    name: "bash",
    description: "run a command",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
    riskTier: "dangerous",
    handler: async (input) => ({ content: `ran ${String(input.command)}\nexit 0` }),
  },
];

export interface Scenario {
  daemon: AgentDaemon;
  client: DaemonClient;
  /** Same daemon, new connection: for the reconnect test. */
  connect: (onConnection?: (online: boolean) => void) => Promise<DaemonClient>;
  workspace: string;
  stop: () => Promise<void>;
}

export async function startScenario(): Promise<Scenario> {
  const prev = {
    key: process.env.AGENCY_ANTHROPIC_API_KEY,
    offline: process.env.AGENCY_DISABLE_MODELS_FETCH,
  };
  process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-not-real";
  process.env.AGENCY_DISABLE_MODELS_FETCH = "1";
  const dirs = [
    mkdtempSync(join(tmpdir(), "agency-tui-ws-")),
    mkdtempSync(join(tmpdir(), "agency-tui-appr-")),
  ];
  const workspace = dirs[0] as string;
  const scripted = adapter();
  const daemon = await createAgentDaemon({
    workspaceRoot: workspace,
    instanceFile: join(workspace, "instance.json"),
    adapterFor: () => scripted,
    tools,
    http: noopHttp,
    approvalsDir: dirs[1] as string,
  });
  const connect = (onConnection?: (online: boolean) => void) =>
    connectToDaemon(daemon.server.port, "127.0.0.1", {
      token: daemon.server.token as string,
      ...(onConnection ? { onConnection, heartbeatMs: 200 } : {}),
    });
  const client = await connect();
  return {
    daemon,
    client,
    connect,
    workspace,
    stop: async () => {
      await client.close();
      await daemon.stop();
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
      if (prev.key === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
      else process.env.AGENCY_ANTHROPIC_API_KEY = prev.key;
      if (prev.offline === undefined) delete process.env.AGENCY_DISABLE_MODELS_FETCH;
      else process.env.AGENCY_DISABLE_MODELS_FETCH = prev.offline;
    },
  };
}
