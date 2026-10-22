/**
 * A daemon entry for the PTY tests: the real daemon with the scripted provider of scenario.ts, started by `ensureDaemon`
 * exactly as the real one is (`bun run <entry> --workspace <dir> --instance-file <file>`).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentDaemon } from "@agency/cli";
import type { HttpClient } from "@agency/net";
import { adapter, tools } from "./scenario.ts";

const arg = (flag: string): string => {
  const i = process.argv.indexOf(flag);
  const v = i === -1 ? undefined : process.argv[i + 1];
  if (!v) throw new Error(`missing ${flag}`);
  return v;
};

const noopHttp: HttpClient = { fetch: async () => new Response() };
const scripted = adapter();
const daemon = await createAgentDaemon({
  workspaceRoot: arg("--workspace"),
  instanceFile: arg("--instance-file"),
  adapterFor: () => scripted,
  tools,
  http: noopHttp,
  approvalsDir: mkdtempSync(join(tmpdir(), "agency-tui-pty-appr-")),
});
process.on("SIGTERM", () => void daemon.stop().then(() => process.exit(0)));
