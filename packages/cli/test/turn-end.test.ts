import { afterAll, afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-turn-end";
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

/** One request calls bash with `command`; the next answers. */
const caller = (command: string): ProviderAdapter => ({
  family: "fake",
  async *stream(request): AsyncIterable<StreamEvent> {
    if (request.messages.some((m) => m.role === "assistant")) {
      yield { type: "text_delta", text: "done" } as StreamEvent;
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
      return;
    }
    yield { type: "tool_call_start", id: "c1", name: "bash" } as StreamEvent;
    yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify({ command }) } as StreamEvent;
    yield { type: "tool_call_end", id: "c1" } as StreamEvent;
    yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 5, outputTokens: 5 } };
  },
});

async function start(adapter: ProviderAdapter, onBash: (cwd: string) => { isError?: boolean } = () => ({})) {
  const ws = tempDir("agency-turnend-ws-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: ws, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(ws, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "first");
  const daemon = await createAgentDaemon({
    workspaceRoot: ws,
    instanceFile: join(ws, ".agency", "instance.json"),
    sessionsDir: tempDir("agency-turnend-sess-"),
    approvalsDir: tempDir("agency-turnend-appr-"),
    configDir: tempDir("agency-turnend-cfg-"),
    adapterFor: () => adapter,
    http: noopHttp,
    tools: [
      {
        name: "bash",
        description: "run a command",
        inputSchema: { type: "object", properties: { command: { type: "string" } } },
        riskTier: "dangerous",
        handler: async () => ({ content: "ran", ...onBash(ws) }),
      },
    ],
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", {
    token: daemon.server.token as string,
  });
  clients.push(client);
  return { client, git };
}

const send = (client: DaemonClient, params: Record<string, unknown>) =>
  client.call("session_send", {
    provider: "anthropic",
    model: "test-model",
    userText: "go",
    permissionMode: "allow-all",
    ...params,
  });

interface End {
  type: string;
  forTurn: string;
  outcome: string;
  checks: string;
  head?: { before: string; after: string };
}
const ends = async (client: DaemonClient, sessionId: string): Promise<End[]> => {
  const exported = (await client.call("session_export", { sessionId })) as { entries: End[] };
  return exported.entries.filter((e) => e.type === "turn_end");
};
interface Listed {
  sessions: Array<{ id: string; outcome: string | null }>;
}

test("a finished turn writes its end: outcome, a check that passed, and the commit it made", async () => {
  const { client, git } = await start(caller("bun test"), () => {
    return {};
  });
  void git;
  await send(client, { sessionId: "s0", turnId: "t0" });
  const [plain] = await ends(client, "s0");
  expect(plain).toMatchObject({ forTurn: "t0", outcome: "done", checks: "passed" });
  expect(plain?.head?.before).toBe(plain?.head?.after);
  const list = (await client.call("session_list", {})) as Listed;
  expect(list.sessions.find((s) => s.id === "s0")?.outcome).toBe("done");
});

test("a commit made inside the turn shows in head", async () => {
  const { client } = await start(caller("git commit"), (cwd) => {
    writeFileSync(join(cwd, "a.txt"), "two\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "in turn"], {
      cwd,
      stdio: "ignore",
    });
    return {};
  });
  const sent = (await send(client, { sessionId: "s1", turnId: "t1" })) as { end: End };
  const [end] = await ends(client, "s1");
  expect(end?.head?.before).not.toBe(end?.head?.after);
  expect(end?.checks).toBe("none");
  expect(sent.end.head).toEqual(end?.head);
});

test("a failing check is recorded", async () => {
  const { client } = await start(caller("bun test"), () => ({ isError: true }));
  await send(client, { sessionId: "s2", turnId: "t2" });
  const [end] = await ends(client, "s2");
  expect(end).toMatchObject({ outcome: "done", checks: "failed" });
});

test("a stopped turn writes its end, and session_list tells running from stopped", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const slow: ProviderAdapter = {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      await held;
      yield { type: "text_delta", text: "x" } as StreamEvent;
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const { client } = await start(slow);
  const pending = send(client, { sessionId: "s4", turnId: "t4" }).catch(() => undefined);
  await sleep(150);
  const during = (await client.call("session_list", {})) as Listed;
  expect(during.sessions.find((s) => s.id === "s4")?.outcome).toBe("running");
  await client.call("cancel_turn", { turnId: "t4" });
  release();
  await pending;
  const [end] = await ends(client, "s4");
  expect(end?.outcome).toBe("stopped");
  const after = (await client.call("session_list", {})) as Listed;
  expect(after.sessions.find((s) => s.id === "s4")?.outcome).toBe("stopped");
});

test("cost_report since counts only the turns after that time", async () => {
  const { client } = await start(caller("echo"));
  await send(client, { sessionId: "s5" });
  const all = (await client.call("cost_report", { since: new Date(0).toISOString() })) as {
    since: { turns: number };
  };
  expect(all.since.turns).toBe(1);
  const none = (await client.call("cost_report", { since: Date.now() + 60_000 })) as {
    since: { turns: number; costUsd: number };
  };
  expect(none.since).toEqual({ turns: 0, costUsd: 0 });
  await expect(client.call("cost_report", { since: "never" })).rejects.toThrow("since");
});

test("a refused ask marks the turn denied and names what was refused", async () => {
  const { client } = await start(caller("rm -rf build"));
  const seen: Array<{ type: string; requestId?: string }> = [];
  client.on("turn.t6", (p) => seen.push(p as { type: string; requestId?: string }));
  client.subscribe("turn.t6");
  const pending = send(client, { sessionId: "s6", turnId: "t6", permissionMode: "ask" });
  while (!seen.some((e) => e.type === "approval_requested")) await sleep(10);
  const requestId = seen.find((e) => e.type === "approval_requested")?.requestId;
  await client.call("approval_respond", { requestId, decision: "reject", sessionId: "s6" });
  await pending;
  const [end] = (await ends(client, "s6")) as Array<End & { deniedBy?: string }>;
  expect(end?.outcome).toBe("denied");
  expect(end?.deniedBy).toContain("rm -rf build");
  const list = (await client.call("session_list", {})) as Listed;
  expect(list.sessions.find((s) => s.id === "s6")?.outcome).toBe("stopped");
});
