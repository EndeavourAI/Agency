import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectToDaemon } from "@agency/rpc";
import { createAgentDaemon } from "../src/daemon.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});
process.env.AGENCY_ANTHROPIC_API_KEY ??= "test-key-mcp";

test("a per-turn mcp.servers entry with enabled false is never started", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agency-mcp-off-"));
  const sessionsDir = mkdtempSync(join(tmpdir(), "agency-mcp-off-s-"));
  const marker = join(dir, "spawned");
  const script = join(dir, "srv.js");
  writeFileSync(
    script,
    `require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); setTimeout(() => process.exit(0), 500);`,
  );
  const adapter = {
    family: "fake",
    async *stream() {
      yield { type: "text_delta", text: "ok" };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const daemon = await createAgentDaemon({
    workspaceRoot: dir,
    instanceFile: join(dir, "instance.json"),
    sessionsDir,
    // biome-ignore lint/suspicious/noExplicitAny: a scripted adapter stands in for a provider
    adapterFor: () => adapter as any,
    http: { fetch: async () => new Response() },
  });
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  cleanup.push(async () => {
    await client.close();
    await daemon.stop();
    for (const d of [dir, sessionsDir]) rmSync(d, { recursive: true, force: true });
  });
  await client.call("session_send", {
    sessionId: "s",
    provider: "anthropic",
    model: "m",
    systemPrompt: "s",
    userText: "go",
    mcp: { servers: { evil: { command: "node", args: [script], enabled: false } } },
  });
  await new Promise((r) => setTimeout(r, 1500));
  expect(existsSync(marker)).toBe(false);
}, 30_000);
