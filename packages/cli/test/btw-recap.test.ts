import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-btw";
afterAll(() => {
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agency-btw-${name}-`));
  dirs.push(dir);
  return dir;
}

async function setup() {
  const requests: ProviderRequest[] = [];
  const longRecap = `${"Fixed the parser bug and added a test. ".repeat(10)}${String.fromCharCode(10)}second line`;
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      requests.push(request);
      const recap = request.system?.includes("one line") === true;
      yield { type: "text_delta", text: recap ? longRecap : "the answer" };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const workspaceRoot = tmp("ws");
  const configDir = tmp("cfg");
  writeFileSync(join(configDir, "config.jsonc"), JSON.stringify({ model: "anthropic/claude-test" }));
  const daemon = await createAgentDaemon({
    workspaceRoot,
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir: tmp("sess"),
    configDir,
    trustStorePath: join(tmp("trust"), "trust.json"),
    adapterFor: () => adapter,
    http: noopHttp,
    tools: [],
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  await client.call("session_send", {
    sessionId: "s1",
    provider: "anthropic",
    model: "claude-test",
    systemPrompt: "sys",
    userText: "fix the parser",
  });
  requests.length = 0;
  const entries = async () =>
    ((await client.call("session_export", { sessionId: "s1" })) as { entries: unknown[] }).entries.length;
  return { client, requests, entries };
}

test("/btw answers from the session with no tools and stores nothing", async () => {
  const { client, requests, entries } = await setup();
  const before = await entries();
  const out = (await client.call("command_run", {
    name: "btw",
    args: "s1 which file did we touch?",
  })) as { text: string };
  expect(out.text).toBe("the answer");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.tools ?? []).toEqual([]);
  expect(JSON.stringify(requests[0]?.messages)).toContain("fix the parser");
  expect(JSON.stringify(requests[0]?.messages)).toContain("which file did we touch?");
  expect(await entries()).toBe(before);
});

test("/recap returns one line of at most 200 characters", async () => {
  const { client, entries } = await setup();
  const before = await entries();
  const out = (await client.call("command_run", { name: "recap", args: "s1" })) as { text: string };
  expect(out.text.length).toBeGreaterThan(0);
  expect(out.text.length).toBeLessThanOrEqual(200);
  expect(out.text).not.toContain(String.fromCharCode(10));
  expect(await entries()).toBe(before);
});
