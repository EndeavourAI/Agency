import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { triggerTokens } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];
const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-tui-events";
afterAll(() => {
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const d of daemons.splice(0)) await d.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Ev = Record<string, unknown>;

async function start(adapter: ProviderAdapter, window?: number) {
  const configDir = tempDir("agency-tuiev-cfg-");
  if (window)
    writeFileSync(
      join(configDir, "config.jsonc"),
      JSON.stringify({
        schemaVersion: 2,
        provider: {
          anthropic: { models: { "test-model": { contextWindow: window, maxOutputTokens: 500 } } },
        },
      }),
    );
  const ws = tempDir("agency-tuiev-ws-");
  const daemon = await createAgentDaemon({
    workspaceRoot: ws,
    instanceFile: join(ws, ".agency", "instance.json"),
    sessionsDir: tempDir("agency-tuiev-sess-"),
    approvalsDir: tempDir("agency-tuiev-appr-"),
    configDir,
    adapterFor: () => adapter,
    http: noopHttp,
    tools: [
      {
        name: "bash",
        description: "run a command",
        inputSchema: { type: "object", properties: { command: { type: "string" } } },
        riskTier: "dangerous",
        handler: async () => ({ content: "ok" }),
      },
    ],
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", {
    token: daemon.server.token as string,
  });
  clients.push(client);
  return { daemon, client };
}

function watch(client: DaemonClient, stream: string): Ev[] {
  const seen: Ev[] = [];
  client.on(stream, (p) => seen.push(p as Ev));
  client.subscribe(stream);
  return seen;
}

const send = (client: DaemonClient, params: Record<string, unknown>) =>
  client.call("session_send", {
    provider: "anthropic",
    model: "test-model",
    userText: "go",
    permissionMode: "ask",
    ...params,
  });

/** One request thinks, then calls bash (which waits for the person); the next answers. */
const thinker: ProviderAdapter = {
  family: "fake",
  async *stream(request): AsyncIterable<StreamEvent> {
    if (request.messages.some((m) => m.role === "assistant")) {
      yield { type: "text_delta", text: "done" } as StreamEvent;
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
      return;
    }
    yield { type: "thinking_delta", text: "hmm " } as StreamEvent;
    await sleep(40);
    yield { type: "thinking_delta", text: "ok" } as StreamEvent;
    yield { type: "tool_call_start", id: "c1", name: "bash" } as StreamEvent;
    yield {
      type: "tool_call_delta",
      id: "c1",
      inputJsonDelta: '{"command":"git push origin main"}',
    } as StreamEvent;
    yield { type: "tool_call_end", id: "c1" } as StreamEvent;
    yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 5, outputTokens: 5 } };
  },
};

describe("events a TUI client needs", () => {
  test("the reasoning of a request ends with thinking_end and its duration", async () => {
    const { client } = await start(thinker);
    const turn = watch(client, "turn.t0");
    const sent = send(client, { sessionId: "s0", turnId: "t0", permissionMode: "allow-all" });
    await sent;
    await sleep(20);
    const types = turn.map((e) => e.type);
    expect(types.indexOf("thinking_end")).toBeGreaterThan(types.indexOf("thinking_delta"));
    expect(types.indexOf("thinking_end")).toBeLessThan(types.indexOf("tool_start"));
    expect((turn.find((e) => e.type === "thinking_end")?.ms as number) >= 30).toBe(true);
  });

  test("status_get tells where the session compacts", async () => {
    const { client } = await start(thinker, 3000);
    await send(client, { sessionId: "s4", permissionMode: "allow-all" });
    const r = (await client.call("status_get", { sessionId: "s4" })) as {
      status: { compactAt: number | null };
    };
    expect(r.status.compactAt).toBe(Math.round(triggerTokens({ contextWindow: 3000 })));
  });

  test("the end of a compaction says what it replaced and how the size changed", async () => {
    const echo: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "text_delta", text: "n" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
      },
    };
    const { client } = await start(echo);
    for (let i = 0; i < 11; i++)
      await send(client, { sessionId: "s5", userText: `fill ${i} ${"x".repeat(1200)}` });
    const turn = watch(client, "turn.t5");
    await send(client, { sessionId: "s5", turnId: "t5", userText: "trigger", contextWindow: 3000 });
    await sleep(20);
    const end = turn.find((e) => e.type === "compaction" && e.phase === "end") as {
      replaced: number;
      tokensBefore: number;
      tokensAfter: number;
    };
    expect(end.replaced).toBeGreaterThan(0);
    expect(end.tokensAfter).toBeLessThan(end.tokensBefore);
    expect(turn.findIndex((e) => e.phase === "start")).toBeLessThan(turn.findIndex((e) => e.phase === "end"));
  }, 60_000);
});
