import { afterAll, afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSpec } from "@agency/core";
import { createFileTrustStore } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@agency/providers";
import { hashWorkspaceRoot } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

/**
 * One session driven the way a terminal UI drives it: over the HTTP gateway only, with the daemon owning the
 * session. If a TUI row needs a method that this test cannot call, the backend is missing it.
 */
const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const dirs: string[] = [];

const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-tui";
afterAll(() => {
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
});
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agency-tui-${name}-`));
  dirs.push(dir);
  return dir;
}

const LF = String.fromCharCode(10);
const usage = { inputTokens: 10, outputTokens: 5 };

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

test("a TUI runs a whole session over the HTTP gateway", async () => {
  const workspaceRoot = tmp("ws");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: workspaceRoot,
      stdio: "ignore",
    });
  git("init", "-q", "-b", "main");
  writeFileSync(join(workspaceRoot, "tracked.txt"), `one${LF}`);
  git("add", ".");
  git("commit", "-q", "-m", "first");
  writeFileSync(join(workspaceRoot, "tracked.txt"), `one${LF}two${LF}`);
  writeFileSync(join(workspaceRoot, "scratch.txt"), `new${LF}`);

  const trustStorePath = join(tmp("trust"), "trust.json");
  createFileTrustStore(trustStorePath).trust(workspaceRoot);

  const requests: ProviderRequest[] = [];
  const ran: string[] = [];
  const turn2Started = deferred();
  const turn2Release = deferred();
  let turn3Started = false;
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      requests.push(request);
      const n = requests.length;
      if (n === 1) {
        yield { type: "tool_call_start", id: "c1", name: "danger" };
        yield { type: "tool_call_delta", id: "c1", inputJsonDelta: "{}" };
        yield { type: "tool_call_end", id: "c1" };
        yield { type: "message_stop", stopReason: "tool_use", usage };
        return;
      }
      if (n === 3) {
        turn2Started.resolve();
        await turn2Release.promise;
        yield { type: "tool_call_start", id: "c2", name: "noop" };
        yield { type: "tool_call_delta", id: "c2", inputJsonDelta: "{}" };
        yield { type: "tool_call_end", id: "c2" };
        yield { type: "message_stop", stopReason: "tool_use", usage };
        return;
      }
      if (n === 5) {
        turn3Started = true;
        while (!request.signal?.aborted) await Bun.sleep(20);
      }
      yield { type: "text_delta", text: "done" };
      yield { type: "message_stop", stopReason: "end_turn", usage };
    },
  };
  const tool = (name: string, riskTier: "safe" | "dangerous"): ToolSpec => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    riskTier,
    handler: async () => {
      ran.push(name);
      return { content: `${name} ran` };
    },
  });
  const daemon = await createAgentDaemon({
    workspaceRoot,
    configDir: tmp("cfg"),
    trustStorePath,
    instanceFile: join(tmp("instances"), `${hashWorkspaceRoot(workspaceRoot)}.json`),
    sessionsDir: tmp("sess"),
    approvalsDir: tmp("approvals"),
    adapterFor: () => adapter,
    http: noopHttp,
    tools: [tool("danger", "dangerous"), tool("noop", "safe")],
  });
  daemons.push(daemon);

  const base = `http://127.0.0.1:${daemon.httpPort}`;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${daemon.server.token}` };
  const rpc = async <T = Record<string, unknown>>(method: string, params: unknown = {}): Promise<T> => {
    const res = await fetch(`${base}/rpc`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: method, method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  };

  // The event stream of the session, as a TUI subscribes before it sends.
  const events = await fetch(`${base}/events?stream=session.tui`, { headers });
  const reader = (events.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let sse = "";
  void (async () => {
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done) return;
      sse += decoder.decode(chunk.value, { stream: true });
    }
  })();

  await rpc("session_create", { sessionId: "tui" });

  // Turn 1: multi-line text, an image, a mode and an effort; the tool asks, the UI answers.
  const prompt = ["first line", "second line"].join(LF);
  const image = { type: "image" as const, mimeType: "image/png", data: "QUJD" };
  const send1 = rpc<{ stopReason: string }>("session_send", {
    sessionId: "tui",
    turnId: "t1",
    provider: "anthropic",
    model: "claude-test",
    systemPrompt: "sys",
    userText: prompt,
    images: [image],
    permissionMode: "ask",
    thinkingLevel: "high",
  });
  await waitFor(() => sse.includes("approval_requested"), "an approval request");
  const requestId = /"requestId":"([^"]+)"/.exec(sse)?.[1] ?? "";
  expect(ran).toEqual([]);
  const answer = await rpc<{ resolved: boolean }>("approval_respond", { requestId, decision: "once" });
  expect(answer.resolved).toBe(true);
  expect((await send1).stopReason).toBe("end_turn");
  expect(ran).toEqual(["danger"]);
  const firstUser = requests[0]?.messages.at(-1)?.content ?? [];
  expect((firstUser.find((b) => b.type === "text") as { text: string }).text).toContain(prompt);
  expect(firstUser.filter((b) => b.type === "image")).toHaveLength(1);

  // The checklist the UI shows.
  await rpc("todo_write", {
    sessionId: "tui",
    todos: [{ id: "1", content: "write tests", status: "in_progress" }],
  });
  const todos = await rpc<{ todos: Array<{ content: string }> }>("todo_read", { sessionId: "tui" });
  expect(todos.todos[0]?.content).toBe("write tests");

  // Turn 2: a message typed while the turn runs reaches the model before its next request.
  const send2 = rpc("session_send", {
    sessionId: "tui",
    turnId: "t2",
    provider: "anthropic",
    model: "claude-test",
    systemPrompt: "sys",
    userText: "second prompt",
    permissionMode: "allow-edits",
  });
  await turn2Started.promise;
  const steered = await rpc<{ queued: boolean }>("session_message", { sessionId: "tui", text: "steer-me" });
  expect(steered.queued).toBe(true);
  turn2Release.resolve();
  await send2;
  expect(JSON.stringify(requests[3]?.messages)).toContain("steer-me");

  // Turn 3: the UI cancels it.
  const send3 = rpc<{ cancelled: boolean }>("session_send", {
    sessionId: "tui",
    turnId: "t3",
    provider: "anthropic",
    model: "claude-test",
    systemPrompt: "sys",
    userText: "cancel me",
  });
  await waitFor(() => turn3Started, "the third turn");
  expect((await rpc<{ cancelled: boolean }>("cancel_turn", { turnId: "t3" })).cancelled).toBe(true);
  expect((await send3).cancelled).toBe(true);

  // Rewind to before the last prompt: the UI gets its text back for the input box.
  const rewound = await rpc<{ rewound: boolean; prompt: string }>("session_rewind", { sessionId: "tui" });
  expect(rewound).toMatchObject({ rewound: true, prompt: "cancel me" });

  // The picker, the status line, the @ list, the history and the diff.
  type Row = { id: string; lastPrompt: string; branch: string };
  const list = await rpc<{ sessions: Row[] }>("session_list", { query: "tui" });
  expect(list.sessions[0]).toMatchObject({ id: "tui", lastPrompt: "second prompt", branch: "main" });
  const status = (await rpc<{ status: Record<string, unknown> }>("status_get", { sessionId: "tui" })).status;
  expect(status).toMatchObject({ sessionId: "tui", model: "claude-test", branch: "main" });
  expect(status).toHaveProperty("costUsd");
  expect(status).toHaveProperty("contextTokens");
  const files = await rpc<{ files: string[] }>("files_list");
  expect(files.files).toEqual(expect.arrayContaining(["tracked.txt", "scratch.txt"]));
  const history = (await rpc<{ prompts: Array<{ text: string }> }>("history_list")).prompts.map(
    (p) => p.text,
  );
  expect(history).toEqual(["cancel me", "second prompt", prompt]);
  const diff = await rpc<{ diff: string; untracked: Array<{ path: string; text: string | null }> }>(
    "git_diff",
  );
  expect(diff.diff).toContain("+two");
  expect(diff.untracked).toEqual([{ path: "scratch.txt", text: `new${LF}` }]);

  await reader.cancel().catch(() => {});
}, 60_000);
