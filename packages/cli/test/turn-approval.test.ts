import { expect, test } from "bun:test";
import { ApprovalManager, type ApprovalRequest, Redactor } from "@agency/guard";
import { createTurnApproval } from "../src/daemon/handlers/plan.ts";
import type { DaemonContext, RunTurnParams } from "../src/daemon/types.ts";

function approval(params: Partial<RunTurnParams>) {
  const ctx = {
    approvalsFor: () => new ApprovalManager(),
    broadcast: () => {},
    eventBus: { emit: () => {} },
    redactor: new Redactor(),
  } as unknown as DaemonContext;
  return createTurnApproval(ctx, { turnId: "t1", ...params } as RunTurnParams, "s1", "turn.t1");
}

const network: ApprovalRequest = {
  tool: "bash",
  title: "Run with the network: pip install requests",
  command: "pip install requests",
  source: "sandbox:network",
};

test("allow-all lets a command past the network limit of the sandbox, even with no one to ask", async () => {
  // Live: under bubblewrap a headless run refused `pip install` under allow-all, and the task could not be done.
  expect(await approval({ permissionMode: "allow-all", nonInteractive: true })(network)).toBe("once");
  expect(await approval({ nonInteractive: true })(network)).toBe("reject");
  expect(await approval({ permissionMode: "allow-edits", nonInteractive: true })(network)).toBe("reject");
  // Another ask under allow-all is still refused when no one can answer.
  const plan: ApprovalRequest = { tool: "plan_exit", title: "the plan", oneTime: true };
  expect(await approval({ permissionMode: "allow-all", nonInteractive: true })(plan)).toBe("reject");
});

test("allow-all lets a file tool past the edge of the workspace; other modes still ask", async () => {
  const outside: ApprovalRequest = {
    tool: "read",
    title: "access outside the workspace: /etc/hosts",
    path: "/etc/hosts",
    source: "external_directory",
  };
  expect(await approval({ permissionMode: "allow-all", nonInteractive: true })(outside)).toBe("once");
  expect(await approval({ permissionMode: "allow-edits", nonInteractive: true })(outside)).toBe("reject");
});
