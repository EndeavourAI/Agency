import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSpec } from "@agency/core";
import { connectToDaemon } from "@agency/rpc";
import { createAgentDaemon } from "../src/daemon.ts";

const KEY = "sk-ant-api03-SECRETSECRETSECRET1234567890";
const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = KEY;
const cleanup: Array<() => Promise<void> | void> = [];
afterAll(() => {
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
});
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

// biome-ignore lint/suspicious/noExplicitAny: a scripted adapter stands in for a provider
type Adapter = any;

/** The model asks for each command in turn, then finishes; `fail` makes the provider throw instead. */
function adapter(commands: string[], fail?: Error): Adapter {
  let call = 0;
  return {
    family: "fake",
    async *stream() {
      if (fail) throw fail;
      const i = call++;
      if (i < commands.length) {
        yield { type: "tool_call_start", id: `c${i}`, name: "bash" };
        yield {
          type: "tool_call_delta",
          id: `c${i}`,
          inputJsonDelta: JSON.stringify({ command: commands[i] }),
        };
        yield { type: "tool_call_end", id: `c${i}` };
        yield {
          type: "message_stop",
          stopReason: "tool_use",
          usage: { inputTokens: 1000, outputTokens: 1000 },
        };
      } else {
        yield { type: "text_delta", text: "finished" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      }
    },
  };
}

async function start(commands: string[], fail?: Error) {
  const ws = mkdtempSync(join(tmpdir(), "agency-outcome-ws-"));
  const sessionsDir = mkdtempSync(join(tmpdir(), "agency-outcome-s-"));
  const approvalsDir = mkdtempSync(join(tmpdir(), "agency-outcome-a-"));
  const bash: ToolSpec = {
    name: "bash",
    description: "d",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
    riskTier: "dangerous",
    handler: async () => ({ content: "ok" }),
  };
  const daemon = await createAgentDaemon({
    workspaceRoot: ws,
    instanceFile: join(ws, "instance.json"),
    sessionsDir,
    approvalsDir,
    adapterFor: () => adapter(commands, fail),
    tools: [bash],
    http: { fetch: async () => new Response() },
  });
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  cleanup.push(async () => {
    await client.close();
    await daemon.stop();
    for (const d of [ws, sessionsDir, approvalsDir]) rmSync(d, { recursive: true, force: true });
  });
  return { client, sessionsDir };
}
const base = { provider: "anthropic", model: "m", systemPrompt: "s" };
// biome-ignore lint/suspicious/noExplicitAny: events are loose records
type Ev = Record<string, any>;

test("a provider error that echoes the key is redacted in the entry, the broadcast and the error event", async () => {
  const { client, sessionsDir } = await start([], new Error(`401 invalid x-api-key: ${KEY}`));
  const events: Ev[] = [];
  client.on("turn.tk", (p) => events.push(p as Ev));
  await client
    .call("session_send", { ...base, sessionId: "k", turnId: "tk", userText: "go" })
    .catch(() => undefined);
  const stored = readdirSync(sessionsDir)
    .map((f) => readFileSync(join(sessionsDir, f), "utf8"))
    .join("\n");
  expect(stored).not.toContain("SECRETSECRET");
  expect(JSON.stringify(events)).not.toContain("SECRETSECRET");
  expect(events.some((e) => e.type === "turn_end")).toBe(true);
});

test("a turn that its budget stopped is recorded as stopped with a reason", async () => {
  const { client } = await start(["echo hi"]);
  const r = (await client.call("session_send", {
    ...base,
    sessionId: "a",
    userText: "go",
    permissionMode: "allow-all",
    budget: { maxTokens: 10 },
  })) as Ev;
  expect(r.budgetExceeded).toBe(true);
  expect(r.end.outcome).toBe("stopped");
  expect(r.end.stopReason).toBe("budget");
});

test("cancelling a turn that waits on an ask records stopped, not denied", async () => {
  const { client } = await start(["rm x"]);
  const events: Ev[] = [];
  client.on("turn.tc", (p) => events.push(p as Ev));
  const run = client.call("session_send", { ...base, sessionId: "c", turnId: "tc", userText: "go" });
  for (let i = 0; i < 100 && !events.some((e) => e.type === "approval_requested"); i++)
    await new Promise((r) => setTimeout(r, 50));
  await client.call("cancel_turn", { turnId: "tc" });
  const r = (await run) as Ev;
  expect(r.end.outcome).toBe("stopped");
  expect(r.end.deniedBy).toBeUndefined();
});

test("a non-interactive refusal is a denial and the ask is resolved", async () => {
  const { client } = await start(["rm x"]);
  const events: Ev[] = [];
  client.on("turn.td", (p) => events.push(p as Ev));
  const r = (await client.call("session_send", {
    ...base,
    sessionId: "d",
    turnId: "td",
    userText: "go",
    nonInteractive: true,
  })) as Ev;
  expect(r.end.outcome).toBe("denied");
  expect(r.end.deniedBy).toContain("rm x");
  const types = events.map((e) => e.type);
  expect(types).toContain("approval_requested");
  expect(types).toContain("approval_resolved");
});
