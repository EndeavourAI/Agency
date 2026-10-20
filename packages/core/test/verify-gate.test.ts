import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachTestGuard, attachVerifyGate, EventBus, HookBlock } from "../src/index.ts";
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

const edit = (bus: EventBus, root: string, path: string, content: string | undefined) => {
  bus.emit("tool.execute.before", { tool: "write", input: { path }, turnId: "t1" });
  if (content === undefined) rmSync(join(root, path));
  else writeFileSync(join(root, path), content);
  after(bus, "write", { path });
};

test("a turn that took assertions out of a test, skipped one or deleted a test file is sent back once", async () => {
  const root = mkdtempSync(join(tmpdir(), "agency-tg-"));
  try {
    writeFileSync(join(root, "a.test.ts"), "test('x', () => { expect(f()).toBe(1); expect(g()).toBe(2); });");
    writeFileSync(join(root, "test_b.py"), "def test_b():\n    assert b() == 1\n");
    writeFileSync(join(root, "c_test.go"), 'func TestC(t *testing.T) { if c() != 1 { t.Errorf("c") } }');
    const bus = new EventBus();
    attachTestGuard(bus, root);
    edit(bus, root, "a.test.ts", "test('x', () => { expect(f()).toBe(1); });");
    edit(bus, root, "test_b.py", "import pytest\n@pytest.mark.skip\ndef test_b():\n    assert b() == 1\n");
    edit(bus, root, "c_test.go", undefined);
    const first = await stop(bus);
    expect(first).toHaveLength(1);
    for (const name of ["a.test.ts", "test_b.py", "c_test.go"]) expect(first[0]).toContain(name);
    expect(await stop(bus)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new test, a test that gained assertions or a change outside tests passes the guard", async () => {
  const root = mkdtempSync(join(tmpdir(), "agency-tg-"));
  try {
    writeFileSync(join(root, "a.test.ts"), "expect(f()).toBe(1);");
    writeFileSync(join(root, "a.ts"), "export const f = () => 1;");
    const bus = new EventBus();
    attachTestGuard(bus, root);
    edit(bus, root, "a.test.ts", "expect(f()).toBe(1);\nexpect(f()).not.toBe(2);");
    edit(bus, root, "new.test.ts", "expect(1).toBe(1);");
    edit(bus, root, "a.ts", "");
    expect(await stop(bus)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the guard sees a change through any command: sed, rm, focus, an always-true assertion, a runner exclusion", async () => {
  for (const git of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "agency-tg-"));
    try {
      if (git) execFileSync("git", ["init", "-q"], { cwd: root });
      mkdirSync(join(root, "tests"));
      writeFileSync(join(root, "tests", "test_a.py"), "def test_a():\n    assert a() == 1\n");
      writeFileSync(join(root, "tests", "test_b.py"), "def test_b():\n    assert b() == 1\n");
      writeFileSync(
        join(root, "c.test.ts"),
        "test('c', () => { expect(c()).toBe(1); });\ntest('d', () => {});",
      );
      writeFileSync(join(root, "pytest.ini"), "[pytest]\n");
      writeFileSync(join(root, "d.test.ts"), "test('d', () => { expect(d()).toBe(1); });");
      const bus = new EventBus();
      attachTestGuard(bus, root);
      bus.emit("tool.execute.before", { tool: "bash", input: { command: "…" }, turnId: "t1" });
      writeFileSync(join(root, "tests", "test_a.py"), "def test_a():\n    assert True\n");
      rmSync(join(root, "tests", "test_b.py"));
      writeFileSync(
        join(root, "c.test.ts"),
        "test.only('c', () => { expect(c()).toBe(1); });\ntest('d', () => {});",
      );
      writeFileSync(join(root, "pytest.ini"), "[pytest]\naddopts = --ignore=tests/slow\n");
      // A moved file keeps its checks: no finding.
      rmSync(join(root, "d.test.ts"));
      writeFileSync(join(root, "e.test.ts"), "test('d', () => { expect(d()).toBe(1); });");
      const [note] = await stop(bus);
      for (const part of [
        "tests/test_a.py (1 more always true)",
        "tests/test_b.py (deleted)",
        "c.test.ts (1 more skipped)",
        "pytest.ini (1 more excluded)",
      ])
        expect(note).toContain(part);
      expect(note).not.toContain("d.test.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
