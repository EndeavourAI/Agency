/**
 * Live cost bench: each task of this folder runs through `agency -p` with a real model, in a fresh copy and a fresh
 * AGENCY_HOME. It reports whether the check passes with the tests unchanged, the model calls, the tokens and the cost.
 * Usage: bun packages/eval/bench/bench.ts --model <provider/model> [--config layer.json] [--only a,b] [--runs n]
 *        [--agency label=path/to/entrypoint.ts|binary ...] [--out file]
 * Several --agency builds run each task in turn, so a before/after comparison shares the time of day.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTasks, prepareWorkspace, shell, testHashes } from "./tasks.ts";

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};
const args = (flag: string): string[] =>
  process.argv.flatMap((a, i) => (a === flag ? [process.argv[i + 1] ?? ""] : []));
const model = arg("--model");
if (!model) throw new Error("--model <provider/model> is required");
const layer = arg("--config") ? readFileSync(arg("--config") as string, "utf8") : "{}";
const only = arg("--only")?.split(",");
const runs = Number(arg("--runs") ?? 1);
const here = import.meta.dir;
const builds = (
  args("--agency").length
    ? args("--agency")
    : [`head=${join(here, "..", "..", "cli", "src", "entrypoint.ts")}`]
).map((spec) => {
  const at = spec.indexOf("=");
  const path = spec.slice(at + 1);
  // A compiled binary runs itself; an entrypoint runs under bun.
  return { label: spec.slice(0, at), argv: path.endsWith(".ts") ? ["bun", path] : [path] };
});

const tasks = loadTasks(only);

interface Row {
  task: string;
  build: string;
  run: number;
  solved: boolean;
  calls: number;
  input: number;
  cached: number;
  output: number;
  costUsd: number;
  seconds: number;
  note?: string;
}

const rows: Row[] = [];
for (const { name: task, spec } of tasks) {
  for (let run = 1; run <= runs; run++) {
    for (const build of builds) {
      const dir = mkdtempSync(join(tmpdir(), `agency-bench-${task}-`));
      const ws = join(dir, "ws");
      prepareWorkspace({ name: task, spec }, ws);
      mkdirSync(join(dir, "home", "config"), { recursive: true });
      mkdirSync(join(dir, "agents"));
      writeFileSync(join(dir, "home", "config", "config.jsonc"), layer);
      const before = testHashes(ws);
      const started = Date.now();
      const out = spawnSync(
        build.argv[0] as string,
        [
          ...build.argv.slice(1),
          "-p",
          spec.hideCheck ? spec.prompt : `${spec.prompt}\nThe tests run with \`${spec.check}\`.`,
          "--model",
          model,
          "--permission-mode",
          "allow-all",
          "--format",
          "json",
        ],
        {
          cwd: ws,
          encoding: "utf8",
          timeout: 600_000,
          env: {
            ...process.env,
            AGENCY_HOME: join(dir, "home"),
            AGENCY_AGENTS_HOME: join(dir, "agents"),
            AGENCY_PARENT_PID: String(process.pid),
            AGENCY_OPENROUTER_API_KEY:
              process.env.AGENCY_OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY,
          },
        },
      );
      const seconds = Math.round((Date.now() - started) / 1000);
      let result: {
        result?: string;
        num_turns?: number;
        usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; costUsd?: number };
        error?: { message: string };
      } = {};
      try {
        result = JSON.parse(out.stdout.slice(out.stdout.indexOf("{")));
      } catch {}
      const answer = join(dir, "answer.txt");
      writeFileSync(answer, result.result ?? "");
      const passed = shell(spec.check, ws, { ANSWER: answer }).status === 0;
      if (spec.cleanup) shell(spec.cleanup, ws);
      const untouched = testHashes(ws) === before;
      rows.push({
        task,
        build: build.label,
        run,
        solved: passed && untouched,
        calls: result.num_turns ?? 0,
        input: result.usage?.inputTokens ?? 0,
        cached: result.usage?.cachedInputTokens ?? 0,
        output: result.usage?.outputTokens ?? 0,
        costUsd: result.usage?.costUsd ?? 0,
        seconds,
        ...(untouched ? {} : { note: "edited the tests" }),
        ...(result.error ? { note: result.error.message.slice(0, 80) } : {}),
      });
      console.log(JSON.stringify(rows.at(-1)));
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A process of the run may still hold the folder; the temporary folder of the system keeps it.
      }
    }
  }
}

const summaries = builds.map(({ label }) => {
  const mine = rows.filter((r) => r.build === label);
  const sum = (key: "calls" | "input" | "cached" | "output" | "costUsd" | "seconds") =>
    mine.reduce((n, r) => n + r[key], 0);
  return {
    build: label,
    model,
    config: JSON.parse(layer),
    solved: `${mine.filter((r) => r.solved).length}/${mine.length}`,
    calls: sum("calls"),
    input: sum("input"),
    cached: sum("cached"),
    output: sum("output"),
    costUsd: Number(sum("costUsd").toFixed(4)),
    seconds: sum("seconds"),
  };
});
for (const summary of summaries) console.log(JSON.stringify(summary));
const outFile = arg("--out");
if (outFile) writeFileSync(outFile, `${JSON.stringify({ summaries, rows }, null, 2)}\n`);
