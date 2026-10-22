import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter } from "@agency/providers";
import { connectToDaemon } from "@agency/rpc";
import type { RunTurnRpcResult } from "../src/daemon.ts";
import { inProcessClient } from "../src/headless.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

test("-p runs its turn on a daemon in its own process, which no other client finds and which ends with it", async () => {
  // As `claude -p` and `codex exec`: a shared daemon cost 0.25-0.65 s a cold run and served an older build.
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream() {
      yield { type: "text_delta", text: "in process" };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const instanceDir = temp("agency-inproc-instances-");
  const { port, client } = await inProcessClient({
    workspaceRoot: temp("agency-inproc-ws-"),
    instanceDir,
    log: () => {},
    daemon: {
      sessionsDir: temp("agency-inproc-sess-"),
      configDir: temp("agency-inproc-cfg-"),
      adapterFor: () => adapter,
      http: { fetch: async () => new Response() } satisfies HttpClient,
    },
  });
  const result = (await client.call("run_turn", {
    turnId: "inproc-1",
    provider: "anthropic",
    model: "test-model",
    apiKey: "key",
    systemPrompt: "sys",
    nonInteractive: true,
    session: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  })) as RunTurnRpcResult;
  expect(JSON.stringify(result.messages)).toContain("in process");
  expect(existsSync(instanceDir) ? readdirSync(instanceDir) : []).toEqual([]);
  await client.close();
  expect(
    await connectToDaemon(port, "127.0.0.1", { token: "x" }).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
}, 30000);
