import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTasks, prepareWorkspace, shell } from "../bench/tasks.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// A check that cannot fail measures nothing, and one that its own answer fails measures the wrong thing.
for (const task of loadTasks().filter((t) => t.spec.solution !== undefined)) {
  test(`bench task ${task.name}: the check fails at the start and passes on the known answer`, () => {
    const dir = mkdtempSync(join(tmpdir(), `agency-bench-self-${task.name}-`));
    dirs.push(dir);
    const ws = join(dir, "ws");
    prepareWorkspace(task, ws);
    const answer = join(dir, "answer.txt");
    writeFileSync(answer, "");
    try {
      expect(shell(task.spec.check, ws, { ANSWER: answer }).status).not.toBe(0);
      const solved = shell(task.spec.solution as string, ws, { ANSWER: answer });
      expect(solved.stderr).toBe("");
      expect(shell(task.spec.check, ws, { ANSWER: answer }).status).toBe(0);
    } finally {
      if (task.spec.cleanup) shell(task.spec.cleanup, ws);
    }
  }, 30_000);
}
