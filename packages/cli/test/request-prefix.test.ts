import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, ProviderRequest, StreamEvent, Usage } from "@agency/providers";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const daemons: AgentDaemon[] = [];
const dirs: string[] = [];
const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
const prevHome = process.env.AGENCY_HOME;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-prefix";
// The memory file of the workspace goes under AGENCY_HOME, not in the data of the user.
process.env.AGENCY_HOME = mkdtempSync(join(tmpdir(), "agency-prefix-home-"));
afterAll(() => {
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
  rmSync(process.env.AGENCY_HOME as string, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.AGENCY_HOME;
  else process.env.AGENCY_HOME = prevHome;
});
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

type Call = { name: string; input: Record<string, unknown> };

/** Plays the calls of each turn in order, one per request, then ends the turn; records every request. */
function recorder(
  turns: Call[][],
  seen: ProviderRequest[],
  usage: Usage = { inputTokens: 1, outputTokens: 1 },
): ProviderAdapter {
  let step = 0;
  return {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      seen.push(structuredClone({ ...request, signal: undefined }));
      const last = request.messages.at(-1);
      if (last?.role === "user" && last.content.some((c) => c.type === "text")) step = 0;
      const turn = turns[0];
      const call = turn?.[step];
      if (call) {
        step += 1;
        const id = `c${seen.length}`;
        yield { type: "tool_call_start", id, name: call.name };
        yield { type: "tool_call_delta", id, inputJsonDelta: JSON.stringify(call.input) };
        yield { type: "tool_call_end", id };
        yield { type: "message_stop", stopReason: "tool_use", usage };
        return;
      }
      turns.shift();
      yield { type: "text_delta", text: "done" };
      yield { type: "message_stop", stopReason: "end_turn", usage };
    },
  };
}

test("every request of a session only appends to the one before it", async () => {
  const ws = tempDir("agency-prefix-ws-");
  writeFileSync(join(ws, "a.ts"), "export const a = 1;\n");
  const seen: ProviderRequest[] = [];
  const turns: Call[][] = [
    [
      { name: "read", input: { path: "a.ts" } },
      { name: "glob", input: { pattern: "*.ts" } },
    ],
    [
      { name: "bash", input: { command: "echo hi" } },
      // A note saved in the session reaches later sessions, not the system prompt of this one.
      { name: "memory", input: { action: "add", note: "tests run with bun test" } },
    ],
    [],
  ];
  const daemon = await createAgentDaemon({
    workspaceRoot: ws,
    instanceFile: join(ws, ".agency", "instance.json"),
    sessionsDir: tempDir("agency-prefix-sess-"),
    approvalsDir: tempDir("agency-prefix-appr-"),
    configDir: tempDir("agency-prefix-cfg-"),
    adapterFor: () => recorder(turns, seen),
    http: { fetch: async () => new Response() } satisfies HttpClient,
  });
  daemons.push(daemon);
  for (const userText of ["look around", "run it", "thanks"]) {
    const res = await fetch(`http://127.0.0.1:${daemon.httpPort}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemon.server.token}` },
      body: JSON.stringify({
        id: 1,
        method: "session_send",
        params: { sessionId: "s", provider: "anthropic", model: "m", userText, permissionMode: "allow-all" },
      }),
    });
    expect(((await res.json()) as { error?: unknown }).error).toBeUndefined();
  }

  const report = seen.map((r, i) => {
    const prev = seen[i - 1];
    const prefixOk =
      prev === undefined ||
      JSON.stringify(r.messages.slice(0, prev.messages.length)) === JSON.stringify(prev.messages);
    return {
      i,
      messages: r.messages.length,
      systemSame: prev === undefined || prev.system === r.system,
      segmentsSame:
        prev === undefined || JSON.stringify(prev.systemSegments) === JSON.stringify(r.systemSegments),
      toolsSame: prev === undefined || JSON.stringify(prev.tools) === JSON.stringify(r.tools),
      prefixOk,
    };
  });
  // PREFIX_DUMP=<file> keeps the requests, to measure what each one sends.
  if (process.env.PREFIX_DUMP) writeFileSync(process.env.PREFIX_DUMP, JSON.stringify(seen, null, 1));
  expect(report.filter((r) => !(r.systemSame && r.segmentsSame && r.toolsSame && r.prefixOk))).toEqual([]);
  // A session with no team sends no tools of the team.
  expect(seen[0]?.tools?.map((t) => t.name)).not.toContain("board_read");
}, 60_000);

test("plan mode goes with the prompt, so a switch keeps the system prompt and its cache", async () => {
  const ws = tempDir("agency-prefix-ws-");
  const seen: ProviderRequest[] = [];
  const turns: Call[][] = [[], [], []];
  const daemon = await createAgentDaemon({
    workspaceRoot: ws,
    instanceFile: join(ws, ".agency", "instance.json"),
    sessionsDir: tempDir("agency-prefix-sess-"),
    approvalsDir: tempDir("agency-prefix-appr-"),
    configDir: tempDir("agency-prefix-cfg-"),
    adapterFor: () => recorder(turns, seen),
    http: { fetch: async () => new Response() } satisfies HttpClient,
  });
  daemons.push(daemon);
  for (const [userText, permissionMode] of [
    ["look", "allow-all"],
    ["plan it", "plan"],
    ["do it", "allow-all"],
  ]) {
    const res = await fetch(`http://127.0.0.1:${daemon.httpPort}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemon.server.token}` },
      body: JSON.stringify({
        id: 1,
        method: "session_send",
        params: { sessionId: "s", provider: "anthropic", model: "m", userText, permissionMode },
      }),
    });
    expect(((await res.json()) as { error?: unknown }).error).toBeUndefined();
  }
  expect(new Set(seen.map((r) => r.system)).size).toBe(1);
  const prompt = (r: ProviderRequest | undefined) => JSON.stringify(r?.messages.at(-1));
  expect(prompt(seen[0])).not.toContain("plan) mode");
  expect(prompt(seen[1])).toContain("Read-only (plan) mode is active");
  expect(prompt(seen[2])).toContain("Read-only (plan) mode is off");
  expect(JSON.stringify(seen[2]?.messages.slice(0, seen[1]?.messages.length))).toBe(
    JSON.stringify(seen[1]?.messages),
  );
}, 60_000);

/** Reads f0..f7 in one turn, one a request, then thanks in a second turn; returns every request. */
async function readsThenThanks(usage: Usage): Promise<ProviderRequest[]> {
  const ws = tempDir("agency-prefix-ws-");
  for (let i = 0; i < 8; i++)
    writeFileSync(
      join(ws, `f${i}.ts`),
      `// ${i}
${"x".repeat(12_000)}
`,
    );
  const seen: ProviderRequest[] = [];
  const turns: Call[][] = [
    Array.from({ length: 8 }, (_, i) => ({ name: "read", input: { path: `f${i}.ts` } })),
    [],
  ];
  const daemon = await createAgentDaemon({
    workspaceRoot: ws,
    instanceFile: join(ws, ".agency", "instance.json"),
    sessionsDir: tempDir("agency-prefix-sess-"),
    approvalsDir: tempDir("agency-prefix-appr-"),
    configDir: tempDir("agency-prefix-cfg-"),
    adapterFor: () => recorder(turns, seen, usage),
    http: { fetch: async () => new Response() } satisfies HttpClient,
  });
  daemons.push(daemon);
  for (const userText of ["read them", "thanks"]) {
    const res = await fetch(`http://127.0.0.1:${daemon.httpPort}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemon.server.token}` },
      body: JSON.stringify({
        id: 1,
        method: "session_send",
        params: { sessionId: "s", provider: "anthropic", model: "m", userText, permissionMode: "allow-all" },
      }),
    });
    expect(((await res.json()) as { error?: unknown }).error).toBeUndefined();
  }
  return seen;
}

const removed = (request: ProviderRequest | undefined) =>
  (request?.messages ?? []).flatMap((m) =>
    m.content.flatMap((b) =>
      b.type === "tool_result" && b.content.includes("was removed") ? [b.toolCallId] : [],
    ),
  ).length;

test("with no cache, old results go at age 6 one by one, and the next turn keeps them out", async () => {
  const seen = await readsThenThanks({ inputTokens: 1000, outputTokens: 1 });
  // A result counts its age from the reply after its call: by the ninth request the first read is 7 calls old.
  expect(removed(seen[8])).toBe(1);
  expect(removed(seen[9])).toBe(2);
}, 60_000);

test("with a cache that holds, the same session sends each request as an append to the one before", async () => {
  const seen = await readsThenThanks({
    inputTokens: 1000,
    cachedInputTokens: 900,
    cacheWriteInputTokens: 100,
    outputTokens: 1,
  });
  expect(seen.map(removed)).toEqual(seen.map(() => 0));
  for (const [i, request] of seen.entries()) {
    const prev = seen[i - 1];
    if (prev)
      expect(JSON.stringify(request.messages.slice(0, prev.messages.length))).toBe(
        JSON.stringify(prev.messages),
      );
  }
}, 60_000);

test("sessions in two folders send one system prompt; the environment goes in the first user message", async () => {
  const seen: ProviderRequest[] = [];
  const roots: string[] = [];
  for (const userText of ["hi", "hello"]) {
    const ws = tempDir("agency-prefix-ws-");
    roots.push(ws);
    const turns: Call[][] = [[]];
    const daemon = await createAgentDaemon({
      workspaceRoot: ws,
      instanceFile: join(ws, ".agency", "instance.json"),
      sessionsDir: tempDir("agency-prefix-sess-"),
      approvalsDir: tempDir("agency-prefix-appr-"),
      configDir: tempDir("agency-prefix-cfg-"),
      adapterFor: () => recorder(turns, seen),
      http: { fetch: async () => new Response() } satisfies HttpClient,
    });
    daemons.push(daemon);
    const res = await fetch(`http://127.0.0.1:${daemon.httpPort}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemon.server.token}` },
      body: JSON.stringify({
        id: 1,
        method: "session_send",
        params: { sessionId: "s", provider: "anthropic", model: "m", userText, permissionMode: "allow-all" },
      }),
    });
    expect(((await res.json()) as { error?: unknown }).error).toBeUndefined();
  }
  expect(seen).toHaveLength(2);
  expect(seen[1]?.system).toBe(seen[0]?.system as string);
  expect(JSON.stringify(seen[1]?.systemSegments)).toBe(JSON.stringify(seen[0]?.systemSegments));
  for (const [i, request] of seen.entries()) {
    const [prompt, env] = request.messages[0]?.content ?? [];
    expect(env?.type === "text" && env.text).toContain(`project root: ${roots[i]}`);
    expect(prompt).toEqual({ type: "text", text: i === 0 ? "hi" : "hello" });
  }
}, 60_000);
