import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachVerifyGate, EventBus, HookBlock } from "../src/index.ts";
import { uncheckedClaim } from "../src/verify-gate.ts";

const after = (bus: EventBus, tool: string, input: Record<string, unknown>, isError = false) =>
  bus.emit("tool.execute.after", { tool, input, result: { content: "", isError }, turnId: "t1" });

const stop = async (bus: EventBus, taskDepth = 0): Promise<string[]> => {
  const { errors } = await bus.emitCollect("turn.stop", { turnId: "t1", taskDepth, stopHookActive: false });
  return errors.filter((e): e is HookBlock => e instanceof HookBlock).map((e) => e.message);
};

test("a turn that changed code and ran no passing check after is sent back once", async () => {
  const bus = new EventBus();
  attachVerifyGate(bus);
  after(bus, "edit", { path: "src/a.ts" });
  after(bus, "bash", { command: "bun test" }, true); // a failing check does not count
  const first = await stop(bus);
  expect(first).toHaveLength(1);
  expect(first[0]).toContain("src/a.ts");
  // Once per turn: the model may say that no check applies.
  expect(await stop(bus)).toEqual([]);
});

test("a passing check after the last edit, a change of prose only, or a worker's turn ends at once", async () => {
  const passed = new EventBus();
  attachVerifyGate(passed);
  after(passed, "write", { path: "src/a.ts" });
  after(passed, "bash", { command: "npx tsc --noEmit && npm test" });
  expect(await stop(passed)).toEqual([]);

  const prose = new EventBus();
  attachVerifyGate(prose);
  after(prose, "edit", { path: "README.md" });
  after(prose, "write", { path: "index.html" });
  expect(await stop(prose)).toEqual([]);

  const worker = new EventBus();
  attachVerifyGate(worker);
  after(worker, "edit", { path: "src/a.ts" });
  expect(await stop(worker, 1)).toEqual([]);

  // An edit after the check opens the gate again.
  const late = new EventBus();
  attachVerifyGate(late);
  after(late, "bash", { command: "cargo test" });
  after(late, "edit", { path: "src/lib.rs" });
  expect(await stop(late)).toHaveLength(1);
});

test("a passing run of a changed script checks that script, and only that one", async () => {
  // Live: twice a model ran `python3 fetch.py`, saw 200, and the reminder still sent it back for two more calls.
  const ran = new EventBus();
  attachVerifyGate(ran);
  after(ran, "write", { path: "fetch.py" });
  after(ran, "bash", { command: "python3 fetch.py > /tmp/status.txt && cat /tmp/status.txt" });
  expect(await stop(ran)).toEqual([]);

  const partly = new EventBus();
  attachVerifyGate(partly);
  after(partly, "write", { path: "scripts/run.sh" });
  after(partly, "edit", { path: "src/lib.py" });
  after(partly, "bash", { command: "./scripts/run.sh" });
  after(partly, "bash", { command: "cat src/lib.py" });
  after(partly, "bash", { command: "node src/lib.py" }, true);
  const sent = await stop(partly);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("src/lib.py");
  expect(sent[0]).not.toContain("run.sh");
});

test("a workspace with no tests and no project file gets no reminder: no check applies there", async () => {
  // Live: in 6 of 12 headless runs on Linux the model spent one to three calls finding that no check existed.
  const bare = mkdtempSync(join(tmpdir(), "agency-gate-bare-"));
  const bus = new EventBus();
  attachVerifyGate(bus, bare);
  after(bus, "write", { path: "fetch.py" });
  expect(await stop(bus)).toEqual([]);

  const project = mkdtempSync(join(tmpdir(), "agency-gate-project-"));
  writeFileSync(join(project, "pyproject.toml"), "");
  const checked = new EventBus();
  attachVerifyGate(checked, project);
  after(checked, "write", { path: "fetch.py" });
  expect(await stop(checked)).toHaveLength(1);
  rmSync(bare, { recursive: true });
  rmSync(project, { recursive: true });
});

test("a passing command that runs a test file by its name is a check", async () => {
  // Live: `python3 -c "import test_stats as t; t.test_mean()"` passed, and the reminder still cost three calls.
  for (const command of ['python3 -c "import test_stats as t; t.test_mean()"', "python3 parser_test.py"]) {
    const bus = new EventBus();
    attachVerifyGate(bus);
    after(bus, "edit", { path: "stats.py" });
    after(bus, "bash", { command });
    expect(await stop(bus)).toEqual([]);
  }
});

test("an answer that says a check was left out is sent back once to do it", async () => {
  const bus = new EventBus();
  attachVerifyGate(bus);
  const answer =
    "The move is e4.\n\nI did not check every other move for mate. I also did not run a chess engine to confirm this.";
  const ask = async () => {
    const { errors } = await bus.emitCollect("turn.stop", {
      turnId: "t1",
      taskDepth: 0,
      stopHookActive: false,
      lastAssistantMessage: answer,
    });
    return errors.filter((e): e is HookBlock => e instanceof HookBlock).map((e) => e.message);
  };
  const first = await ask();
  expect(first).toHaveLength(1);
  expect(first[0]).toContain('"I did not check every other move for mate."');
  expect(await ask()).toEqual([]);
});

test("only the model's own word that it skipped a check counts", () => {
  expect(uncheckedClaim("- I could not confirm the reference's word size from the example.")).toBe(
    "I could not confirm the reference's word size from the example.",
  );
  for (const answer of [
    "Done. All 12 tests pass.",
    "I did not change the tests.",
    "The tests did not run before the fix; now they pass.",
  ])
    expect(uncheckedClaim(answer)).toBeUndefined();
});
