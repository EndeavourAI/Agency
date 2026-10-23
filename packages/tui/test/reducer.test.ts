import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderMd, visibleBlocks } from "../src/render-model/index.ts";
import {
  type AppState,
  current,
  doing,
  type Event,
  hydrate,
  initialState,
  reduce,
  runningThought,
  stepView,
  type Turn,
  turnFoot,
  turnStamp,
  type WireEntry,
  type WireEvent,
} from "../src/state/index.ts";

interface Fixture {
  sessionId: string;
  turns: Array<{
    turnId: string;
    prompt: string;
    events: Array<{ t: number; event: WireEvent }>;
    answers: Array<{ after: number; requestId: string; decision: "once" | "always" | "reject" }>;
    result: { stopReason?: string; cancelled: boolean; error: { code: string; message: string } | null };
  }>;
  entries: WireEntry[];
  tipId: string;
}

/** Recorded from a real daemon by record-fixture.ts: every event is what the daemon broadcast. */
const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "session-stream.json"), "utf8"),
) as Fixture;
const SID = fixture.sessionId;

function run(state: AppState, events: readonly Event[]): AppState {
  return events.reduce(reduce, state);
}

function replay(turnIndex: number, state: AppState): AppState {
  const t = fixture.turns[turnIndex];
  if (!t) throw new Error("no such turn");
  const events: Event[] = [
    { type: "turn_started", sessionId: SID, turnId: t.turnId, prompt: t.prompt, images: [], at: 1000 },
  ];
  t.events.forEach((e, i) => {
    events.push({ type: "turn_event", sessionId: SID, turnId: t.turnId, event: e.event, at: 1000 + e.t });
    for (const a of t.answers.filter((x) => x.after === i))
      events.push({
        type: "approval_answered",
        sessionId: SID,
        turnId: t.turnId,
        requestId: a.requestId,
        decision: a.decision,
      });
  });
  const last = t.events.at(-1)?.t ?? 0;
  events.push({
    type: "turn_finished",
    sessionId: SID,
    turnId: t.turnId,
    at: 1000 + last + 5,
    outcome: {
      ...(t.result.stopReason ? { stopReason: t.result.stopReason } : {}),
      cancelled: t.result.cancelled,
    },
  });
  return run(state, events);
}

const start = (): AppState =>
  run(initialState({ cols: 120, rows: 40 }), [
    { type: "conn", status: "online" },
    { type: "session_opened", sessionId: SID },
  ]);
const turnsOf = (s: AppState): Turn[] =>
  (current(s)?.blocks ?? []).filter((b): b is Turn => b.kind === "turn");

describe("replaying a recorded daemon stream", () => {
  test("the first turn: steps, approval, streamed answer, cost and stats", () => {
    const state = replay(0, start());
    const [t] = turnsOf(state);
    expect(t?.status).toBe("done");
    expect(t?.steps.map((s) => [s.tool, s.status])).toEqual([
      ["read", "ok"],
      ["edit", "ok"],
      ["bash", "ok"],
    ]);
    expect(t?.steps[2]?.answer).toBe("once");
    expect(t?.approval).toBeNull();
    expect(t?.thinking).toBe("Read the run script first, then change the retry flags.");
    expect(t?.answer.settled).toEqual(renderMd(t?.text ?? ""));
    expect(t?.answer.settled.map((b) => b.kind)).toEqual(["text", "text", "code", "text", "text"]);
    expect(t?.usage.outputTokens).toBe(200);
    expect(t?.costUsd).toBeCloseTo(0.015, 6);
    expect(current(state)?.runCostUsd).toBeCloseTo(0.015, 6);
    expect(t?.stopReason).toBe("end_turn");
    expect(current(state)?.runningTurnId).toBeNull();
    expect(turnStamp(t as Turn, false)).toMatchObject({ glyph: "✓", label: "done", note: " · 3 steps" });
    // The recording predates thinking_end: the time is unknown, and the label does not invent one.
    expect(turnFoot(t as Turn, null).thought).toBe("thought");
  });

  test("an edit step opens to the diff of its input", () => {
    const [t] = turnsOf(replay(0, start()));
    const edit = stepView({ ...(t?.steps[1] as Turn["steps"][number]), open: true }, false);
    expect(edit.add).toBe("+2 ");
    expect(edit.del).toBe("−1");
    expect(edit.out.map((o) => o.kind)).toContain("add");
  });

  test("the second turn: the ask was refused, the step is denied and the turn says so", () => {
    const state = replay(1, replay(0, start()));
    const t = turnsOf(state)[1];
    expect(t?.status).toBe("denied");
    expect(t?.steps[0]).toMatchObject({ tool: "bash", status: "denied" });
    expect(turnStamp(t as Turn, false)).toMatchObject({
      glyph: "✗",
      label: "denied",
      note: " · you denied bash rm -rf build",
    });
  });

  test("mid-stream: the ask takes over, the open block grows, nothing before it changes", () => {
    const t = fixture.turns[0];
    if (!t) throw new Error("no turn");
    const upTo = (n: number) =>
      run(start(), [
        { type: "turn_started", sessionId: SID, turnId: t.turnId, prompt: t.prompt, images: [], at: 0 },
        ...t.events.slice(0, n).map<Event>((e) => ({
          type: "turn_event",
          sessionId: SID,
          turnId: t.turnId,
          event: e.event,
          at: e.t,
        })),
      ]);
    const askAt = t.events.findIndex((e) => e.event.type === "approval_requested");
    const asking = turnsOf(upTo(askAt + 1))[0] as Turn;
    expect(asking.approval).toMatchObject({
      tool: "bash",
      command: "bash scripts/dry-run.sh",
      riskTier: "dangerous",
    });
    expect(doing(asking)).toBe("run bash scripts/dry-run.sh");

    const textAt = t.events.findIndex((e, i) => i > askAt && e.event.type === "text_delta");
    const a = turnsOf(upTo(textAt + 1))[0] as Turn;
    const b = turnsOf(upTo(textAt + 3))[0] as Turn;
    expect(a.status).toBe("running");
    expect(visibleBlocks(a.answer).length).toBeGreaterThan(0);
    expect(b.answer.settled.slice(0, a.answer.settled.length)).toEqual(a.answer.settled);
  });
});

describe("the live turn and the saved session agree", () => {
  test("hydrating the session file rebuilds the same turns, steps and answers", () => {
    const live = turnsOf(replay(1, replay(0, start())));
    const saved = hydrate(fixture.entries).blocks.filter((b): b is Turn => b.kind === "turn");
    expect(saved.map((t) => t.prompt)).toEqual(live.map((t) => t.prompt));
    expect(saved.map((t) => t.steps.map((s) => [s.tool, s.status]))).toEqual(
      live.map((t) => t.steps.map((s) => [s.tool, s.status])),
    );
    expect(saved.map((t) => t.answer.settled)).toEqual(live.map((t) => t.answer.settled));
    expect(saved[0]?.costUsd).toBeCloseTo(0.015, 6);
    expect(saved[0]?.usage.outputTokens).toBe(200);
  });

  test("loading a session shows its blocks and keeps a turn that still streams", () => {
    let state = start();
    state = run(state, [
      { type: "turn_started", sessionId: SID, turnId: "live1", prompt: "going", images: [], at: 5 },
      { type: "session_loaded", sessionId: SID, entries: fixture.entries, tipId: fixture.tipId },
    ]);
    const blocks = current(state)?.blocks ?? [];
    expect(blocks.filter((b) => b.kind === "turn")).toHaveLength(3);
    expect((blocks.at(-1) as Turn).id).toBe("live1");
    expect(current(state)?.loading).toBe(false);
  });

  test("shell output, compaction and mid-turn messages hydrate as their own blocks", () => {
    const entries: WireEntry[] = [
      { id: "e1", type: "compaction_summary", summary: "x", replacedEntryIds: [] },
      { id: "e2", type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      {
        id: "e3",
        type: "message",
        origin: "shell",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "x\n<shell-command>git status</shell-command>\n<shell-output>On branch dev\nclean\n</shell-output>",
            },
          ],
        },
      },
    ];
    const kinds = hydrate(entries).blocks.map((b) => b.kind);
    expect(kinds).toEqual(["event", "turn", "shell"]);
    const shell = hydrate(entries).blocks[2];
    expect(shell).toMatchObject({ cmd: "git status", out: ["On branch dev", "clean"] });
  });
});

describe("events outside the happy path", () => {
  const begin = (): AppState =>
    run(start(), [{ type: "turn_started", sessionId: SID, turnId: "t1", prompt: "go", images: [], at: 0 }]);
  const ev = (event: WireEvent): Event => ({
    type: "turn_event",
    sessionId: SID,
    turnId: "t1",
    event,
    at: 10,
  });
  const turn = (s: AppState) => turnsOf(s)[0] as Turn;

  test("compaction shows while it runs and leaves a marker above the turn", () => {
    let s = run(begin(), [ev({ type: "compaction", phase: "start", sessionId: SID })]);
    expect(current(s)?.compaction).toEqual({ at: 10, tokens: 0 });
    s = run(s, [
      {
        type: "turn_event",
        sessionId: SID,
        turnId: "t1",
        event: { type: "compaction", phase: "progress", sessionId: SID, tokens: 1200 },
        at: 14,
      },
    ]);
    // The start time stays: the row counts the seconds from it.
    expect(current(s)?.compaction).toEqual({ at: 10, tokens: 1200 });
    s = run(s, [
      ev({
        type: "compaction",
        phase: "end",
        sessionId: SID,
        replaced: 6,
        tokensBefore: 148_000,
        tokensAfter: 31_000,
      }),
    ]);
    expect(current(s)?.compaction).toBeNull();
    expect(current(s)?.blocks.map((b) => b.kind)).toEqual(["event", "turn"]);
    expect(current(s)?.blocks[0]).toMatchObject({
      text: "compacted · 6 earlier turns summarized · 148K → 31K tokens",
    });
  });

  test("thinking_end adds the real reasoning time to the closing row", () => {
    const s = run(begin(), [
      ev({ type: "thinking_delta", text: "hmm" }),
      ev({ type: "thinking_end", ms: 3400 }),
      ev({ type: "thinking_end", ms: 600 }),
    ]);
    expect(turn(s).thoughtMs).toBe(4000);
    expect(turnFoot(turn(s), null).thought).toBe("thought 4s");
  });

  test("turn_end on the turn stream settles the turn once; the answer of session_send changes nothing", () => {
    const end = (e: Partial<Extract<WireEvent, { type: "turn_end" }>> = {}) =>
      ev({ type: "turn_end", stopReason: "end_turn", cancelled: false, ...e });
    let s = run(begin(), [ev({ type: "text_delta", text: "Done.\n" }), end()]);
    expect(turn(s).status).toBe("done");
    expect(current(s)?.runningTurnId).toBeNull();
    const endedAt = turn(s).endedAt;
    s = run(s, [
      { type: "turn_finished", sessionId: SID, turnId: "t1", at: 99, outcome: { stopReason: "end_turn" } },
    ]);
    expect(turn(s).endedAt).toBe(endedAt);
    s = run(begin(), [end({ stopReason: "error", error: { code: "x", message: "boom" } })]);
    expect(turn(s)).toMatchObject({ status: "error", error: { message: "boom" } });
    s = run(begin(), [end({ cancelled: true })]);
    expect(turn(s).status).toBe("stopped");
  });

  test("approval_resolved clears an ask that another client answered", () => {
    const ask = ev({
      type: "approval_requested",
      requestId: "r1",
      sessionId: SID,
      turnId: "t1",
      riskTier: "dangerous",
      source: "x",
      argsSummary: "command=git push",
      request: { tool: "bash", title: "git push", command: "git push" },
    });
    let s = run(begin(), [ask]);
    expect(turn(s).approval?.requestId).toBe("r1");
    s = run(s, [ev({ type: "approval_resolved", requestId: "other", decision: "once" })]);
    expect(turn(s).approval?.requestId).toBe("r1");
    s = run(s, [ev({ type: "approval_resolved", requestId: "r1", decision: "once" })]);
    expect(turn(s).approval).toBeNull();
  });

  test("the sessions channel keeps the list of running sessions", () => {
    let s = run(begin(), [
      { type: "session_live", sessionId: "a", live: true },
      { type: "session_live", sessionId: "a", live: true },
    ]);
    expect(s.liveSessions).toEqual(["a"]);
    s = run(s, [{ type: "session_live", sessionId: "a", live: false }]);
    expect(s.liveSessions).toEqual([]);
  });

  test("an error from the provider ends the turn as stopped, with the reason kept", () => {
    const s = run(begin(), [
      ev({ type: "error", code: "provider_overloaded", message: "HTTP 529" }),
      { type: "turn_finished", sessionId: SID, turnId: "t1", at: 20, outcome: {} },
    ]);
    expect(turn(s).status).toBe("error");
    expect(turn(s).error).toEqual({ code: "provider_overloaded", message: "HTTP 529" });
    expect(turnStamp(turn(s), false)).toMatchObject({ glyph: "✗", label: "stopped", note: "" });
  });

  test("a thrown RPC error ends the turn the same way", () => {
    const s = run(begin(), [
      {
        type: "turn_finished",
        sessionId: SID,
        turnId: "t1",
        at: 20,
        outcome: { error: { code: "auth", message: "no key" } },
      },
    ]);
    expect(turn(s).status).toBe("error");
    expect(turn(s).error?.message).toBe("no key");
  });

  test("retry, fallback, budget and a tool that reports progress", () => {
    let s = run(begin(), [ev({ type: "retry", attempt: 2, message: "overloaded" })]);
    expect(turn(s).note).toBe("retrying · attempt 2");
    s = run(s, [ev({ type: "fallback", from: "a", to: "b", reason: "x" })]);
    expect(turn(s).note).toBe("fell back to b");
    s = run(s, [
      ev({ type: "tool_start", id: "p1", name: "bash", input: { command: "make" } }),
      ev({ type: "tool_progress", id: "p1", name: "bash", message: "42%" }),
    ]);
    expect(turn(s).steps[0]?.progress).toBe("42%");
    s = run(s, [ev({ type: "budget_exceeded", spentTokens: 9000, spentCostUsd: 1 })]);
    expect(turn(s).error?.code).toBe("budget");
  });

  test("a mode change from the daemon moves the mode of the open session", () => {
    const s = run(begin(), [ev({ type: "mode_changed", mode: "allow-edits" })]);
    expect(s.mode).toBe("build");
    expect(run(begin(), [ev({ type: "mode_changed", mode: "plan" })]).mode).toBe("plan");
  });

  test("heartbeats, unknown events and events of an unknown turn change nothing", () => {
    const before = begin();
    expect(run(before, [ev({ type: "heartbeat" })])).toEqual(before);
    expect(run(before, [ev({ type: "from_the_future" } as unknown as WireEvent)])).toEqual(before);
    expect(
      run(before, [
        {
          type: "turn_event",
          sessionId: SID,
          turnId: "nope",
          event: { type: "text_delta", text: "x" },
          at: 1,
        },
      ]),
    ).toEqual(before);
  });

  test("the user stopping a turn: stopped, and the daemon's cancelled result keeps it stopped", () => {
    const s = run(begin(), [
      { type: "turn_stopped", sessionId: SID, turnId: "t1", at: 5 },
      { type: "turn_finished", sessionId: SID, turnId: "t1", at: 6, outcome: { cancelled: true } },
    ]);
    expect(turn(s).status).toBe("stopped");
    expect(turnStamp(turn(s), false)).toMatchObject({ label: "interrupted", note: " · you pressed esc" });
    expect(current(s)?.runningTurnId).toBeNull();
  });

  test("connection lost: the running turn reads paused throughout, restored: it runs again", () => {
    let s = run(begin(), [ev({ type: "tool_start", id: "x", name: "read", input: { path: "a" } })]);
    s = run(s, [{ type: "conn", status: "offline" }]);
    const t = turn(s);
    expect(turnStamp(t, true)).toMatchObject({
      glyph: "·",
      label: "paused",
      note: " · waiting for the daemon",
    });
    expect(runningThought(t, true)).toBe("reasoning (paused)");
    expect(stepView(t.steps[0] as Turn["steps"][number], true).tone).not.toBe("brand");
    s = run(s, [{ type: "conn", status: "online" }]);
    expect(turnStamp(turn(s), s.conn === "offline")).toMatchObject({ glyph: "bead" });
  });

  test("an unanswered prompt cut off by the next one shows as waiting after a reload", () => {
    const entries: WireEntry[] = [
      { id: "a", type: "message", message: { role: "user", content: [{ type: "text", text: "one" }] } },
    ];
    expect(
      turnsOf(run(start(), [{ type: "session_loaded", sessionId: SID, entries, tipId: "a" }]))[0]?.status,
    ).toBe("waiting");
  });
});
