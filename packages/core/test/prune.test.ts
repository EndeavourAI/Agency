import { expect, test } from "bun:test";
import type { Message } from "@agency/schema";
import { type CacheSeen, dedupeReads, pruneRule, pruneStaleResults, seeCache } from "../src/prune.ts";

const AGE_10: Parameters<typeof pruneStaleResults>[1] = { age: 10, batchTokens: 20_000 };

/** A history of `calls` model calls, each a call of `tool` with a result of `size` characters. */
function history(calls: number, tool: string, size: number): Message[] {
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
  for (let i = 0; i < calls; i++) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_call", id: `c${i}`, name: tool, input: {} }],
    });
    messages.push({
      role: "user",
      content: [
        { type: "tool_result", toolCallId: `c${i}`, content: `${i}:`.padEnd(size, "x"), isError: false },
      ],
    });
  }
  return messages;
}

const notes = (messages: Message[]) =>
  messages.flatMap((m) =>
    m.content.flatMap((b) =>
      b.type === "tool_result" && b.content.startsWith("[The ") ? [b.toolCallId] : [],
    ),
  );

test("old results of re-runnable tools become a note, in batches, and the same history gives the same request", () => {
  // 10k characters each: a batch passes 20k tokens at 9 results that are over 10 calls old.
  const long = history(30, "bash", 10_000);
  const pruned = pruneStaleResults(long, AGE_10);
  // Two batches are due by call 30: c0-c8 at call 20 and c9-c17 at call 29.
  expect(notes(pruned)).toEqual(Array.from({ length: 18 }, (_, i) => `c${i}`));
  expect(JSON.stringify(pruneStaleResults(long, AGE_10))).toBe(JSON.stringify(pruned));
  // The request after one more call starts with the messages of the request before: the prompt cache holds.
  const after = pruneStaleResults(history(31, "bash", 10_000), AGE_10);
  expect(JSON.stringify(after.slice(0, pruned.length))).toBe(JSON.stringify(pruned));
  expect(pruned[2]?.content[0]).toMatchObject({
    content:
      "[The 10000-character result of this old bash call was removed to save context. Call bash again if you need it.]",
  });
});

test("a short history, short results and the results of other tools stay whole", () => {
  const short = history(10, "bash", 10_000);
  expect(pruneStaleResults(short, AGE_10)).toBe(short);
  const small = history(40, "read", 1_500);
  expect(pruneStaleResults(small, AGE_10)).toBe(small);
  const agents = history(40, "spawn", 10_000);
  expect(pruneStaleResults(agents, AGE_10)).toBe(agents);
});

test("a read the model can still see comes back as a note; once that result is pruned, a read gives the text again", () => {
  const text = "line\n".repeat(200);
  const read = (id: string): Message => ({
    role: "assistant",
    content: [{ type: "tool_call", id, name: "read", input: { path: "a.ts" } }],
  });
  const result = (id: string, content = text) => ({
    type: "tool_result" as const,
    toolCallId: id,
    content,
    isError: false,
  });
  const visible: Message[] = [read("c1"), { role: "user", content: [result("c1")] }];
  const calls = [{ id: "c2", name: "read", input: { path: "a.ts" } }];

  const [same] = dedupeReads([result("c2")], calls, visible);
  expect(same?.type === "tool_result" && same.content).toBe(
    "[Unchanged: the same text as the earlier read result of a.ts, which is still above.]",
  );
  expect(dedupeReads([result("c2", `${text}changed`)], calls, visible)[0]).toEqual(
    result("c2", `${text}changed`),
  );
  const pruned: Message[] = [
    read("c1"),
    { role: "user", content: [result("c1", "[The old result was removed.]")] },
  ];
  expect(dedupeReads([result("c2")], calls, pruned)[0]).toEqual(result("c2"));
  const twice = dedupeReads(
    [result("c2"), result("c3")],
    [...calls, { id: "c3", name: "read", input: { path: "a.ts" } }],
    [],
  );
  expect(twice[0]).toEqual(result("c2"));
  expect(twice[1]?.type === "tool_result" && twice[1].content.startsWith("[Unchanged")).toBe(true);
});

test("a read that a later read of the same file shows again goes in the next batch, not 10 calls later", () => {
  const reads = (inputs: Array<Record<string, unknown>>): Message[] => [
    { role: "user", content: [{ type: "text", text: "go" }] },
    ...inputs.flatMap((input, i): Message[] => [
      { role: "assistant", content: [{ type: "tool_call", id: `r${i}`, name: "read", input }] },
      {
        role: "user",
        content: [
          { type: "tool_result", toolCallId: `r${i}`, content: `v${i}:`.padEnd(10_000, "x"), isError: false },
        ],
      },
    ]),
  ];
  // Ten whole reads of a.ts as it changes: by the tenth, the nine before are out of date and pass a batch.
  const whole = reads(Array.from({ length: 10 }, () => ({ path: "a.ts" })));
  expect(notes(pruneStaleResults(whole, AGE_10))).toEqual(Array.from({ length: 9 }, (_, i) => `r${i}`));
  // A slice does not show the whole file again, and another file is another file.
  const other = reads([
    ...Array.from({ length: 10 }, () => ({ path: "a.ts" })),
    { path: "a.ts", offset: 10, limit: 20 },
  ]);
  expect(notes(pruneStaleResults(other, AGE_10))).toEqual(Array.from({ length: 9 }, (_, i) => `r${i}`));
  const files = reads(Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts` })));
  expect(notes(pruneStaleResults(files, AGE_10))).toEqual([]);
});

test("a later read that only points at the earlier text, or that was cut or failed, does not make it out of date", () => {
  const history: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
  const step = (id: string, path: string, content: string, isError = false) => {
    history.push({ role: "assistant", content: [{ type: "tool_call", id, name: "read", input: { path } }] });
    history.push({ role: "user", content: [{ type: "tool_result", toolCallId: id, content, isError }] });
  };
  for (const [i, path] of ["a.ts", "b.ts", "c.ts"].entries())
    step(`r${i}`, path, `${path}:`.padEnd(30_000, "x"));
  step("r3", "a.ts", "[Unchanged: the same text as the earlier read result of a.ts, which is still above.]");
  step(
    "r4",
    "b.ts",
    "line 1\n[The file has 9000 lines: these are lines 1 to 2000. Read with offset 2001 for the rest.]",
  );
  step("r5", "c.ts", "ENOENT: no such file", true);
  expect(notes(pruneStaleResults(history, AGE_10))).toEqual([]);
});

test("the rule follows what the first three requests cached, then stays", () => {
  const seen = (usages: Array<Parameters<typeof seeCache>[1]>): CacheSeen => {
    const cache: CacheSeen = { requests: 0, input: 0, cached: 0, written: 0 };
    for (const usage of usages) seeCache(cache, usage);
    return cache;
  };
  const none = { inputTokens: 10_000 };
  const read = { inputTokens: 10_000, cachedInputTokens: 8_000 };
  const written = { inputTokens: 10_000, cachedInputTokens: 8_000, cacheWriteInputTokens: 2_000 };
  // Until the third request, the rule that prunes least.
  expect(pruneRule(seen([none, none]))).toEqual({ age: 6, batchTokens: 40_000 });
  expect(pruneRule(seen([none, none, none]))).toEqual({ age: 6, batchTokens: 0 });
  expect(pruneRule(seen([read, read, read]))).toEqual({ age: 6, batchTokens: 10_000 });
  expect(pruneRule(seen([written, written, written]))).toEqual({ age: 6, batchTokens: 40_000 });
  // A cache that held under half the input is weak; later requests do not change a fixed rule.
  expect(pruneRule(seen([none, none, read]))).toEqual({ age: 6, batchTokens: 0 });
  expect(pruneRule(seen([read, read, read, none, none, none]))).toEqual({ age: 6, batchTokens: 10_000 });
});
