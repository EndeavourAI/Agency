import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSpec } from "@agency/core";
import { createFileTrustStore } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
const prevHome = process.env.AGENCY_AGENTS_HOME;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-managed";
afterAll(() => {
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
  if (prevHome === undefined) delete process.env.AGENCY_AGENTS_HOME;
  else process.env.AGENCY_AGENTS_HOME = prevHome;
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agency-managed-${name}-`));
  dirs.push(dir);
  return dir;
}

const usage = { inputTokens: 5, outputTokens: 5 };

/** A daemon whose model calls the `note` tool once; `ran` shows whether the tool ran. */
async function setup(layers: {
  user?: Record<string, unknown>;
  managed?: Record<string, unknown>;
  claudeAllow?: string[];
}): Promise<{ ran: string[]; turn: () => Promise<unknown> }> {
  const configDir = tmp("cfg");
  const workspaceRoot = tmp("ws");
  // The settings of Claude Code in the real home must not leak into the test.
  process.env.AGENCY_AGENTS_HOME = "off";
  const trustStorePath = join(tmp("trust"), "trust.json");
  createFileTrustStore(trustStorePath).trust(workspaceRoot);
  const managedPath = join(tmp("managed"), "managed.jsonc");
  writeFileSync(join(configDir, "config.jsonc"), JSON.stringify(layers.user ?? {}));
  writeFileSync(managedPath, JSON.stringify(layers.managed ?? {}));
  if (layers.claudeAllow) {
    mkdirSync(join(workspaceRoot, ".claude"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: layers.claudeAllow } }),
    );
  }
  let requests = 0;
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      requests += 1;
      if (requests === 1) {
        yield { type: "tool_call_start", id: "call-1", name: "note" };
        yield { type: "tool_call_delta", id: "call-1", inputJsonDelta: '{"text":"hi"}' };
        yield { type: "tool_call_end", id: "call-1" };
        yield { type: "message_stop", stopReason: "tool_use", usage };
        return;
      }
      yield { type: "text_delta", text: "done" };
      yield { type: "message_stop", stopReason: "end_turn", usage };
    },
  };
  const ran: string[] = [];
  const note: ToolSpec = {
    name: "note",
    description: "Records a note.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    riskTier: "safe",
    handler: async () => {
      ran.push("note");
      return { content: "noted" };
    },
  };
  const daemon = await createAgentDaemon({
    workspaceRoot,
    configDir,
    trustStorePath,
    managedPath,
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir: tmp("sess"),
    adapterFor: () => adapter,
    http: noopHttp,
    tools: [note],
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  const turn = () =>
    client.call("session_send", {
      sessionId: "managed-s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "take a note",
    });
  return { ran, turn };
}

const denyNote = {
  PreToolUse: [
    { matcher: "Note", hooks: [{ type: "command", command: `"${process.execPath}" -e "process.exit(2)"` }] },
  ],
};

describe("managed policy in a daemon", () => {
  test("a managed deny beats a user allow and a project .claude allow", async () => {
    const { ran, turn } = await setup({
      user: { permissions: { note: "allow" } },
      claudeAllow: ["Note"],
      managed: { permissions: { note: "deny" } },
    });
    await turn();
    expect(ran).toEqual([]);
  }, 30000);

  test("without a managed rule the same allows run the tool", async () => {
    const { ran, turn } = await setup({ user: { permissions: { note: "allow" } }, claudeAllow: ["Note"] });
    await turn();
    expect(ran).toEqual(["note"]);
  }, 30000);

  test("allowManagedPermissionRulesOnly drops the rules of the user and of Claude settings", async () => {
    const { ran, turn } = await setup({
      user: { permissions: { note: "deny" } },
      managed: { allowManagedPermissionRulesOnly: true },
    });
    await turn();
    expect(ran).toEqual(["note"]);
  }, 30000);

  test("a user hook blocks the tool, and allowManagedHooksOnly drops it", async () => {
    const blocked = await setup({ user: { hooks: denyNote } });
    await blocked.turn();
    expect(blocked.ran).toEqual([]);

    const only = await setup({ user: { hooks: denyNote }, managed: { allowManagedHooksOnly: true } });
    await only.turn();
    expect(only.ran).toEqual(["note"]);
  }, 30000);

  test("allowManagedHooksOnly still runs the hooks of the managed file", async () => {
    const { ran, turn } = await setup({ managed: { allowManagedHooksOnly: true, hooks: denyNote } });
    await turn();
    expect(ran).toEqual([]);
  }, 30000);
});
