import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentDaemon, createAgentDaemon } from "@agency/cli";
import type { HttpClient } from "@agency/net";
import { connectWorkspaceDaemon } from "../src/client/index.ts";

process.env.AGENCY_DISABLE_MODELS_FETCH = "1";
const noopHttp: HttpClient = { fetch: async () => new Response() };
const dirs: string[] = [];
const daemons: AgentDaemon[] = [];
afterAll(async () => {
  for (const d of daemons) await d.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("find or start the workspace daemon", () => {
  test("the first call starts one, the second finds it, both get working clients", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agency-tui-conn-ws-"));
    const instanceDir = mkdtempSync(join(tmpdir(), "agency-tui-conn-inst-"));
    dirs.push(workspaceRoot, instanceDir);
    let spawned = 0;
    const options = {
      workspaceRoot,
      instanceDir,
      spawnDaemon: (instanceFile: string) => {
        spawned += 1;
        void createAgentDaemon({
          workspaceRoot,
          instanceFile,
          http: noopHttp,
          approvalsDir: instanceDir,
        }).then((d) => daemons.push(d));
      },
    };
    const a = await connectWorkspaceDaemon(options);
    const b = await connectWorkspaceDaemon(options);
    expect(spawned).toBe(1);
    expect(await a.call("turns_list", {})).toEqual({ turns: [] });
    expect(await b.call("session_list", {})).toEqual({ sessions: [] });
    await a.close();
    await b.close();
  }, 30_000);
});
