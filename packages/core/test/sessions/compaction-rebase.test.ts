import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApproximateTokenizer } from "@agency/providers";
import { compact } from "../../src/sessions/compaction.ts";
import { SessionStore } from "../../src/sessions/store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a compaction keeps createdAt and carries no second copy of a usage or turn_end entry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agency-rebase-"));
  dirs.push(dir);
  const store = new SessionStore(dir);
  let tip: string | null = null;
  const add = async (entry: Record<string, unknown>, at: string) => {
    tip = (await store.append("s", { parentId: tip, createdAt: at, ...entry } as never)).id;
  };
  for (let t = 1; t <= 4; t++) {
    const at = `2020-01-0${t}T00:00:00.000Z`;
    const text = (s: string) => [{ type: "text" as const, text: s + "x".repeat(400) }];
    await add(
      { type: "message", message: { role: "user", content: text(`prompt ${t} `) }, turnId: `t${t}` },
      at,
    );
    await add({ type: "message", message: { role: "assistant", content: text(`answer ${t} `) } }, at);
    await add({ type: "turn_end", forTurn: `t${t}`, outcome: "done", checks: "none" }, at);
    await add(
      { type: "usage", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 1, cacheHitRate: 0 },
      at,
    );
  }
  const result = await compact(
    store,
    "s",
    tip as unknown as string,
    createApproximateTokenizer(),
    { contextWindow: 100_000 },
    Object.assign(async () => "summary", {}) as never,
    4,
    { force: true, trigger: "manual" },
  );
  expect(result.compacted).toBe(true);
  const after = store.load("s");
  expect(after.filter((e) => e.type === "usage")).toHaveLength(4);
  expect(after.filter((e) => e.type === "turn_end")).toHaveLength(4);
  const carried = after.filter((e) => e.type === "message").slice(8);
  expect(carried.length).toBeGreaterThan(0);
  for (const e of carried) expect(e.createdAt.startsWith("2020-01-0")).toBe(true);
});
