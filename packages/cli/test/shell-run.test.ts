import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-shell";
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
  const dir = mkdtempSync(join(tmpdir(), `agency-shell-${name}-`));
  dirs.push(dir);
  return dir;
}

async function setup(bashRule: "allow" | "deny") {
  const configDir = tmp("cfg");
  writeFileSync(join(configDir, "config.jsonc"), JSON.stringify({ permissions: { bash: bashRule } }));
  const workspaceRoot = tmp("ws");
  const trustStorePath = join(tmp("trust"), "trust.json");
  createFileTrustStore(trustStorePath).trust(workspaceRoot);
  const requests: string[] = [];
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      requests.push(JSON.stringify(request.messages));
      yield { type: "text_delta", text: "ok" };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const ran: string[] = [];
  const bash: ToolSpec = {
    name: "bash",
    description: "Runs a command.",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
    riskTier: "dangerous",
    handler: async (input) => {
      ran.push(String(input.command));
      return { content: `output of ${String(input.command)}` };
    },
  };
  const daemon = await createAgentDaemon({
    workspaceRoot,
    configDir,
    trustStorePath,
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir: tmp("sess"),
    adapterFor: () => adapter,
    http: noopHttp,
    tools: [bash],
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  return { client, requests, ran };
}

test("shell_run runs the command and its output reaches the next request", async () => {
  const { client, requests, ran } = await setup("allow");
  await client.call("session_create", { sessionId: "s1" });
  const result = (await client.call("shell_run", { sessionId: "s1", command: "echo hi" })) as {
    output: string;
  };
  expect(result.output).toBe("output of echo hi");
  expect(ran).toEqual(["echo hi"]);
  await client.call("session_send", {
    sessionId: "s1",
    provider: "anthropic",
    model: "m",
    systemPrompt: "sys",
    userText: "what did that print?",
  });
  expect(requests[0]).toContain("$ echo hi");
  expect(requests[0]).toContain("output of echo hi");
});

test("shell_run refuses a command that the permission rules deny", async () => {
  const { client, requests, ran } = await setup("deny");
  await client.call("session_create", { sessionId: "s1" });
  await expect(client.call("shell_run", { sessionId: "s1", command: "rm -rf x" })).rejects.toThrow("refuse");
  expect(ran).toEqual([]);
  await client.call("session_send", {
    sessionId: "s1",
    provider: "anthropic",
    model: "m",
    systemPrompt: "sys",
    userText: "hello",
  });
  expect(requests[0]).not.toContain("rm -rf x");
});
