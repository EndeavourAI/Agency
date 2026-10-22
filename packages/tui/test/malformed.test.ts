import { describe, expect, test } from "bun:test";
import { hydrate } from "../src/state/hydrate.ts";
import { type Event, initialState, reduce, type WireEvent } from "../src/state/index.ts";
import type { WireEntry } from "../src/state/wire.ts";

const TYPES = [
  "text_delta",
  "thinking_delta",
  "thinking_end",
  "turn_end",
  "approval_resolved",
  "tool_start",
  "tool_progress",
  "tool_result",
  "turn_complete",
  "budget_exceeded",
  "iteration_limit",
  "error",
  "retry",
  "model_route",
  "heartbeat",
  "cost_meter",
  "compaction",
  "fallback",
  "approval_requested",
  "mode_changed",
  "prompt_suggestion",
  "bogus",
];

function base() {
  let s = initialState({ cols: 100, rows: 30 });
  const start: Event[] = [
    { type: "session_opened", sessionId: "s" },
    { type: "turn_started", sessionId: "s", turnId: "t", prompt: "p", images: [], at: 1 },
  ];
  for (const e of start) s = reduce(s, e);
  return s;
}

const wire = (event: unknown): Event => ({
  type: "turn_event",
  sessionId: "s",
  turnId: "t",
  at: 1,
  event: event as WireEvent,
});

describe("a malformed daemon event does not throw", () => {
  for (const type of TYPES) {
    test(`${type} with no payload`, () => {
      expect(() => reduce(base(), wire({ type }))).not.toThrow();
    });
  }

  test("the shapes the reviewer found", () => {
    const s = base();
    expect(() => reduce(s, wire({ type: "turn_complete" }))).not.toThrow();
    expect(() => reduce(s, wire({ type: "approval_requested", requestId: "r" }))).not.toThrow();
    expect(() => reduce(s, wire({ type: "turn_end", stopReason: "end_turn" }))).not.toThrow();
  });
});

const entry = (message: unknown, extra: object = {}): WireEntry =>
  ({ id: "1", type: "message", message, ...extra }) as unknown as WireEntry;

describe("hydrate skips what it cannot read", () => {
  const good = entry({ role: "user", content: [{ type: "text", text: "kept" }] }, { id: "g" });
  const bad: Record<string, WireEntry> = {
    "no content": entry({ role: "user" }),
    "string content": entry({ role: "user", content: "hello" }),
    "null item": entry({ role: "assistant", content: [null] }),
    "image without data": entry({ role: "user", content: [{ type: "image", mimeType: "image/png" }] }),
    "text without text": entry({ role: "assistant", content: [{ type: "text" }] }),
    "shell without content": entry({ role: "user" }, { origin: "shell" }),
    "null entry": null as unknown as WireEntry,
    "tool result with parts": entry({
      role: "user",
      content: [{ type: "tool_result", toolCallId: "a", content: [{ type: "text", text: "x" }] }],
    }),
  };
  for (const [name, e] of Object.entries(bad)) {
    test(`${name}: the rest of the session still loads`, () => {
      const h = hydrate([good, e, { ...good, id: "g2" }]);
      expect(
        h.blocks.filter((b) => b.kind === "turn").map((b) => (b as { prompt: string }).prompt),
      ).toContain("kept");
    });
  }

  test("random garbage entries never blank the session", () => {
    const junk: unknown[] = [
      undefined,
      1,
      "x",
      [],
      {},
      { type: "message" },
      { type: "turn_end" },
      { type: "usage" },
    ];
    const h = hydrate([good, ...(junk as WireEntry[]), good]);
    expect(h.blocks.length).toBeGreaterThan(0);
  });
});
