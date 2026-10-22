import { expect, test } from "bun:test";
import { type Event, initialState, reduce } from "../src/state/index.ts";
import { mount } from "./render.ts";

const SID = "s1";
const BODY =
  "Some **answer** text with `code`.\n- item one\n- item two\n```ts\nconst a = 1;\n```\nmore text here\n";

function build(n: number) {
  let s = initialState({ cols: 120, rows: 40 });
  const ev: Event[] = [
    { type: "conn", status: "online" },
    { type: "session_opened", sessionId: SID },
  ];
  for (let i = 0; i < n; i++) {
    const turnId = `t${i}`;
    ev.push({
      type: "turn_started",
      sessionId: SID,
      turnId,
      prompt: `prompt ${i}`,
      images: [],
      at: 1000 + i,
    });
    ev.push({ type: "turn_event", sessionId: SID, turnId, at: 1, event: { type: "text_delta", text: BODY } });
    ev.push({
      type: "turn_event",
      sessionId: SID,
      turnId,
      at: 2,
      event: { type: "turn_end", stopReason: "end_turn", cancelled: false },
    });
  }
  ev.push({ type: "turn_started", sessionId: SID, turnId: "live", prompt: "p", images: [], at: 5 });
  for (const e of ev) s = reduce(s, e);
  return s;
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

// Old code rebuilt the rows of every block on each delta and tick: ~190 ms per delta at 1000 blocks.
test("a text delta and a tick cost the same with 1000 settled blocks as with a few", async () => {
  let s = build(1000);
  const m = await mount(s, { tick: 0 });
  const deltas: number[] = [];
  for (let i = 0; i < 15; i++) {
    s = reduce(s, {
      type: "turn_event",
      sessionId: SID,
      turnId: "live",
      at: 1,
      event: { type: "text_delta", text: `w${i} ` },
    });
    const t0 = performance.now();
    await m.set(s);
    deltas.push((performance.now() - t0) / 2);
  }
  const ticks: number[] = [];
  for (let i = 1; i <= 10; i++) {
    const t0 = performance.now();
    await m.tick(i);
    ticks.push((performance.now() - t0) / 2);
  }
  await m.dispose();
  console.log(`delta ${median(deltas).toFixed(1)} ms, tick ${median(ticks).toFixed(1)} ms (1001 blocks)`);
  expect(median(deltas)).toBeLessThan(25);
  expect(median(ticks)).toBeLessThan(25);
}, 200_000);
