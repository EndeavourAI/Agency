/** The plan panel: the three answers to plan_exit, the keys that give them, and what the panel draws. */
process.env.HOME = "/home/dev";

import { afterEach, describe, expect, test } from "bun:test";
import {
  current,
  hints,
  isHalted,
  isWorking,
  planAsk,
  planMax,
  planVisible,
  runningTurn,
  showAsk,
  type Turn,
} from "../src/state/index.ts";
import { NOW, SID, session } from "./boards.ts";
import { type Driver, KEY } from "./helpers.ts";
import { type Mounted, mount } from "./render.ts";

const PLAN = [
  "# Plan",
  "Make the retry flags work for start timeouts too.",
  "- add `--retry-include` to run.sh",
  "- count start timeouts in report.py",
  "```sh",
  "harbor run -r 2",
  "```",
].join("\n");

function planned(plan = PLAN, o: { rows?: number } = {}): Driver {
  const d = session(o);
  d.state = { ...d.state, mode: "plan" };
  d.daemon({
    type: "turn_event",
    sessionId: SID,
    turnId: "t2",
    at: NOW,
    event: { type: "tool_start", id: "pe1", name: "plan_exit", input: { plan } },
  });
  d.daemon({
    type: "turn_event",
    sessionId: SID,
    turnId: "t2",
    at: NOW,
    event: {
      type: "approval_requested",
      requestId: "plan1",
      sessionId: SID,
      turnId: "t2",
      riskTier: "moderate",
      source: "unknown",
      argsSummary: plan.slice(0, 40),
      request: { tool: "plan_exit", title: plan },
    },
  });
  return d;
}

const turn = (d: Driver): Turn => runningTurn(current(d.state)) as Turn;

describe("the plan ask is its own panel", () => {
  test("the ask keeps the whole plan and owns the keys instead of y a n", () => {
    const d = planned();
    expect(planAsk(d.state)?.title).toBe(PLAN);
    expect(hints(d.state).map((h) => h.label)).toEqual(["choose", "select", "scroll"]);
    d.send("y");
    d.send("n");
    expect(d.effects).toEqual([]);
    expect(showAsk(d.state)).toBe(true);
  });

  test("a bash ask is still the generic one", () => {
    const d = session();
    d.daemon({
      type: "turn_event",
      sessionId: SID,
      turnId: "t2",
      at: NOW,
      event: {
        type: "approval_requested",
        requestId: "b1",
        sessionId: SID,
        turnId: "t2",
        riskTier: "dangerous",
        source: "tier",
        argsSummary: "x",
        request: { tool: "bash", title: "x", command: "x" },
      },
    });
    expect(planAsk(d.state)).toBeNull();
    d.send("y");
    expect(d.last("respond")).toMatchObject({ decision: "once" });
  });

  test("1: approve, the session goes on in auto, and the daemon is told the mode", () => {
    const d = planned();
    d.send("1");
    expect(d.last("respond")).toEqual({
      type: "respond",
      sessionId: SID,
      requestId: "plan1",
      decision: "once",
      mode: "auto",
    });
    expect(d.state.mode).toBe("auto");
    expect(turn(d).approval).toBeNull();
    expect(isWorking(d.state)).toBe(true);
    expect(d.last("cancel_turn")).toBeUndefined();
  });

  test("2: approve, the session goes on in build with edits asked", () => {
    const d = planned();
    d.send(KEY.down);
    d.send(KEY.enter);
    expect(d.last("respond")).toMatchObject({ decision: "once", mode: "ask" });
    expect(d.state.mode).toBe("build");
    expect(d.last("cancel_turn")).toBeUndefined();
  });

  test("3 and esc: keep planning rejects without stopping the turn", () => {
    for (const key of ["3", KEY.esc]) {
      const d = planned();
      d.send(key);
      const sent = d.last("respond");
      expect(sent).toMatchObject({ requestId: "plan1", decision: "reject" });
      expect(sent).not.toHaveProperty("message");
      expect(d.effects.some((e) => e.type === "cancel_turn")).toBe(false);
      expect(d.state.mode).toBe("plan");
      expect(turn(d).status).toBe("running");
      expect(turn(d).approval).toBeNull();
      expect(isHalted(d.state)).toBe(false);
      expect(isWorking(d.state)).toBe(true);
    }
  });

  test("keep planning takes feedback, digits and spaces included, and sends it", () => {
    const d = planned();
    d.send(KEY.up);
    d.type("use 2 files");
    expect(d.state.planUi).toMatchObject({ requestId: "plan1", at: 2, note: "use 2 files" });
    d.send(KEY.backspace);
    d.send(KEY.enter);
    expect(d.last("respond")).toMatchObject({ decision: "reject", message: "use 2 file" });
    expect(d.effects.some((e) => e.type === "cancel_turn")).toBe(false);
  });

  test("a stray key on the first answers is not feedback", () => {
    const d = planned();
    d.type("k");
    d.send(KEY.backspace);
    expect(d.state.planUi.note).toBe("");
    expect(d.effects).toEqual([]);
  });

  test("the next plan starts on the first answer with no note", () => {
    const d = planned();
    d.send(KEY.up);
    d.type("no");
    d.send(KEY.enter);
    d.daemon({
      type: "turn_event",
      sessionId: SID,
      turnId: "t2",
      at: NOW,
      event: {
        type: "approval_requested",
        requestId: "plan2",
        sessionId: SID,
        turnId: "t2",
        riskTier: "moderate",
        source: "unknown",
        argsSummary: "",
        request: { tool: "plan_exit", title: "# Plan B" },
      },
    });
    d.send(KEY.enter);
    expect(d.last("respond")).toMatchObject({ requestId: "plan2", decision: "once", mode: "auto" });
  });

  test("the daemon's mode_changed agrees with the choice, and the next prompt is sent in it", () => {
    const d = planned();
    d.send("1");
    d.daemon({
      type: "turn_event",
      sessionId: SID,
      turnId: "t2",
      at: NOW,
      event: { type: "mode_changed", mode: "auto" },
    });
    expect(d.state.mode).toBe("auto");
    d.daemon({
      type: "turn_finished",
      sessionId: SID,
      turnId: "t2",
      at: NOW,
      outcome: { stopReason: "end_turn" },
    });
    d.type("go on");
    d.send(KEY.enter);
    expect(d.last("send_turn")).toMatchObject({ text: "go on", mode: "auto" });
  });

  test("page keys scroll a long plan and stop at both ends", () => {
    const long = Array.from({ length: 80 }, (_, i) => `- step ${i}`).join("\n");
    const d = planned(long);
    // As the view reports it once the plan is drawn.
    const max = 80 - planVisible(d.state.rows);
    d.daemon({ type: "plan_ui", requestId: "plan1", patch: { max } });
    expect(planMax(d.state, "plan1")).toBe(max);
    for (let i = 0; i < 6; i++) d.send(KEY.pgdn);
    expect(d.state.planUi.scroll).toBe(max);
    d.send(KEY.pgup);
    expect(d.state.planUi.scroll).toBe(max - (planVisible(d.state.rows) - 1));
    for (let i = 0; i < 6; i++) d.send(KEY.pgup);
    expect(d.state.planUi.scroll).toBe(0);
  });
});

describe("the plan panel is drawn", () => {
  const mounted: Mounted[] = [];
  afterEach(async () => {
    for (const m of mounted.splice(0)) await m.dispose();
  });
  const board = async (d: Driver): Promise<Mounted> => {
    const m = await mount(d.state, { now: NOW });
    mounted.push(m);
    return m;
  };

  test("the plan as markdown in a box, and the three answers under it", async () => {
    const d = planned();
    d.state = { ...d.state, cols: 100, rows: 24 };
    const m = await board(d);
    const at = m.grid.findIndex((r) => r.includes("Ready to code? Here is the plan:"));
    expect(at).toBeGreaterThan(0);
    const panel = m.grid.slice(at - 1, at + 19);
    const text = panel.join("\n");
    expect(text).toContain("Make the retry flags work for start timeouts too.");
    expect(text).toContain("add --retry-include to run.sh");
    expect(text).toContain("harbor run -r 2");
    expect(text).toContain("Would you like to proceed?");
    expect(text).toContain("› 1. Yes, and auto-accept edits");
    expect(text).toContain("2. Yes, and manually approve edits");
    expect(text).toContain("3. No, keep planning");
    expect(text).toContain("├");
    expect(m.grid.some((r) => r.includes("Answer the request above"))).toBe(false);
    expect(m.grid.some((r) => r.includes("y allow once"))).toBe(false);
    expect(m.grid.some((r) => r.includes("↑↓ choose") && r.includes("enter select"))).toBe(true);
    expect(m.grid.some((r) => r.includes("⏸ plan mode on (shift+tab to cycle)"))).toBe(true);
  });

  test("a plan taller than the screen scrolls and says where it is", async () => {
    const long = Array.from({ length: 60 }, (_, i) => `- step ${i}`).join("\n");
    const d = planned(long);
    const first = await board(d);
    expect(first.grid.some((r) => r.includes("1–") && r.includes("of 60"))).toBe(true);
    expect(first.grid.some((r) => r.includes("step 0"))).toBe(true);
    expect(first.grid.some((r) => r.includes("step 59"))).toBe(false);
    d.send(KEY.pgdn);
    d.send(KEY.pgdn);
    d.send(KEY.pgdn);
    const last = await board(d);
    expect(last.grid.some((r) => r.includes("step 59"))).toBe(true);
    expect(last.grid.some((r) => r.includes("of 60"))).toBe(true);
    expect(last.grid.some((r) => r.includes("step 0 "))).toBe(false);
  });

  test("the cursor row and the typed feedback show", async () => {
    const d = planned();
    d.send(KEY.down);
    expect((await board(d)).grid.some((r) => r.includes("› 2. Yes, and manually approve edits"))).toBe(true);
    d.send(KEY.down);
    expect((await board(d)).grid.some((r) => r.includes("› 3. No, keep planning  type what to change"))).toBe(
      true,
    );
    d.type("add tests");
    expect((await board(d)).grid.some((r) => r.includes("› 3. No, keep planning  add tests▍"))).toBe(true);
  });

  test("the view reports how far a long plan scrolls: every row past the box", async () => {
    const long = Array.from({ length: 80 }, (_, i) => `- step ${i}`).join("\n");
    const m = await board(planned(long));
    const shown = m.grid.filter((r) => /• step \d+/.test(r)).length;
    const first = m.grid.find((r) => r.includes(" of 80")) as string;
    expect(first).toContain(`1–${shown} of 80`);
  });
});
