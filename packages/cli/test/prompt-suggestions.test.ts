import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-suggest";
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
  const dir = mkdtempSync(join(tmpdir(), `agency-suggest-${name}-`));
  dirs.push(dir);
  return dir;
}

async function turn(promptSuggestions: boolean) {
  const configDir = tmp("cfg");
  writeFileSync(
    join(configDir, "config.jsonc"),
    JSON.stringify({ small_model: "anthropic/test-small", promptSuggestions }),
  );
  const workspaceRoot = tmp("ws");
  let suggesterCalls = 0;
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      const suggesting = request.system?.includes("next prompt") === true;
      if (suggesting) suggesterCalls += 1;
      yield { type: "text_delta", text: suggesting ? "run the tests" : "done" };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const daemon = await createAgentDaemon({
    workspaceRoot,
    configDir,
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir: tmp("sess"),
    trustStorePath: join(tmp("trust"), "trust.json"),
    adapterFor: () => adapter,
    http: noopHttp,
    tools: [],
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  const suggestions: Array<{ text: string }> = [];
  client.on("session.s1", (payload) => {
    if ((payload as { type?: string }).type === "prompt_suggestion")
      suggestions.push(payload as { text: string });
  });
  client.subscribe("session.s1");
  await client.call("session_send", {
    sessionId: "s1",
    provider: "anthropic",
    model: "m",
    systemPrompt: "sys",
    userText: "hello",
  });
  await Bun.sleep(500);
  return { suggestions, suggesterCalls: () => suggesterCalls };
}

test("no prompt suggestion and no extra request by default", async () => {
  const { suggestions, suggesterCalls } = await turn(false);
  expect(suggestions).toEqual([]);
  expect(suggesterCalls()).toBe(0);
});

test("with promptSuggestions on, a finished turn sends one suggestion", async () => {
  const { suggestions, suggesterCalls } = await turn(true);
  expect(suggestions.map((s) => s.text)).toEqual(["run the tests"]);
  expect(suggesterCalls()).toBe(1);
});
