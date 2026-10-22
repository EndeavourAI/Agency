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
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-status";
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
  const dir = mkdtempSync(join(tmpdir(), `agency-status-${name}-`));
  dirs.push(dir);
  return dir;
}

const adapter: ProviderAdapter = {
  family: "fake",
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", text: "ok" };
    yield {
      type: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 },
    };
  },
};

function managedFile(layer: Record<string, unknown>): string {
  const file = join(tmp("managed"), "managed.jsonc");
  writeFileSync(file, JSON.stringify(layer));
  return file;
}

async function setup(statusLine?: { command: string }, managed?: Record<string, unknown>) {
  const configDir = tmp("cfg");
  writeFileSync(join(configDir, "config.jsonc"), JSON.stringify(statusLine ? { statusLine } : {}));
  const workspaceRoot = tmp("ws");
  const daemon = await createAgentDaemon({
    workspaceRoot,
    configDir,
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir: tmp("sess"),
    trustStorePath: join(tmp("trust"), "trust.json"),
    ...(managed ? { managedPath: managedFile(managed) } : {}),
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
    userText: "hello",
    permissionMode: "allow-edits",
    thinkingLevel: "high",
  });
  return client;
}

test("status_get has every field of the status", async () => {
  const client = await setup();
  const { status, line } = (await client.call("status_get", { sessionId: "s1" })) as {
    status: Record<string, unknown>;
    line?: string;
  };
  expect(Object.keys(status).sort()).toEqual(
    [
      "branch",
      "cacheHitRate",
      "compactAt",
      "contextLimit",
      "contextTokens",
      "costUsd",
      "effort",
      "mode",
      "model",
      "sessionId",
    ].sort(),
  );
  expect(status).toMatchObject({
    sessionId: "s1",
    model: "claude-test",
    mode: "allow-edits",
    effort: "high",
  });
  expect(status.cacheHitRate).toBeCloseTo(0.4);
  expect(line).toBeUndefined();
});

test("effort set by the client persists over a turn that omits it", async () => {
  const client = await setup();
  await client.call("session_send", {
    sessionId: "s1",
    provider: "anthropic",
    model: "claude-test",
    systemPrompt: "sys",
    userText: "again",
    permissionMode: "allow-edits",
  });
  const { status } = (await client.call("status_get", { sessionId: "s1" })) as {
    status: { effort: string | null };
  };
  expect(status.effort).toBe("high");
});

test("the statusLine command gets the status JSON on stdin and its output comes back", async () => {
  const script = join(tmp("script"), "line.js");
  writeFileSync(
    script,
    'let s=""; process.stdin.on("data",(d)=>(s+=d)); process.stdin.on("end",()=>{const j=JSON.parse(s); console.log("LINE "+j.model+" "+j.mode);});',
  );
  const client = await setup({ command: `"${process.execPath}" "${script}"` });
  const { line } = (await client.call("status_get", { sessionId: "s1" })) as { line: string };
  expect(line).toBe("LINE claude-test allow-edits");
});

test("allowManagedHooksOnly does not run a user statusLine command", async () => {
  const client = await setup(
    { command: `"${process.execPath}" -e "console.log('USER')"` },
    {
      allowManagedHooksOnly: true,
    },
  );
  const { line } = (await client.call("status_get", { sessionId: "s1" })) as { line?: string };
  expect(line).toBeUndefined();
});

test("allowManagedHooksOnly still runs a managed statusLine command", async () => {
  const client = await setup(undefined, {
    allowManagedHooksOnly: true,
    statusLine: { command: `"${process.execPath}" -e "console.log('MANAGED')"` },
  });
  const { line } = (await client.call("status_get", { sessionId: "s1" })) as { line?: string };
  expect(line?.trim()).toBe("MANAGED");
});
