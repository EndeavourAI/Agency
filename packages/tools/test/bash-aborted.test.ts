import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { createBashTool } from "../src/builtins/bash.ts";
import { ProcessManager } from "../src/process-manager.ts";
import { resolveShell } from "../src/shell.ts";

test("a command that timed out reports no exit code, not 0", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-bash-abort-")));
  const manager = new ProcessManager();
  const tool = createBashTool(
    {
      identity: { type: "user" },
      capabilities: { ...FULL_CAPABILITIES, pathScopes: [root] },
      sandbox: new SandboxBoundary(root),
    },
    resolveShell(process.platform),
    { cwd: root },
    manager,
  );
  const result = await tool.handler(
    { command: process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30", timeout: 1500 },
    { signal: new AbortController().signal } as never,
  );
  manager.killAll();
  expect(result.isError).toBe(true);
  expect(result.meta?.exitCode).toBeUndefined();
}, 30_000);
