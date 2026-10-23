/**
 * The canvas smoke.mjs checks that apply to the pure layers, driven by raw bytes through decoder, keymap,
 * controller and reducer. Pixel checks (logo frames, board renders, hover) belong to the view tests.
 */
import { describe, expect, test } from "bun:test";
import type { SlashEntry } from "../src/input/index.ts";
import {
  canRetry,
  completion,
  ctxNote,
  current,
  effortNote,
  flatModels,
  footer,
  hints,
  imageLabel,
  isHalted,
  isWorking,
  newerLabel,
  noProviders,
  othersLabel,
  othersRunning,
  paletteItems,
  queuedRows,
  runningThought,
  settingValue,
  showAsk,
  showLogo,
  statusText,
  stepView,
  type Turn,
  turnFoot,
  turnStamp,
  type WireEvent,
  youText,
} from "../src/state/index.ts";
import { SETTINGS } from "../src/state/settings.ts";
import { Driver, KEY } from "./helpers.ts";

const SID = "retry";
const FILES = [
  "packages/eval/harbor/run.sh",
  "packages/eval/harbor/report.py",
  "packages/core/src/loop.ts",
  "AGENTS.md",
];
const SLASH: SlashEntry[] = [
  { name: "compact", desc: "", meta: "" },
  { name: "review", desc: "", meta: "", act: "review" },
  { name: "settings", desc: "", meta: "", act: "settings" },
  { name: "eval", desc: "", meta: "command" },
];

/** A session with two finished turns and files, as the canvas' first board. */
function session(opts: { cols?: number; rows?: number } = {}): Driver {
  const d = new Driver();
  d.daemon(
    { type: "viewport", cols: opts.cols ?? 120, rows: opts.rows ?? 40 },
    { type: "conn", status: "online" },
    { type: "files_loaded", files: FILES },
    { type: "slash_loaded", slash: SLASH },
    {
      type: "sessions_loaded",
      rows: [
        {
          id: SID,
          title: "Retry infra faults",
          tipId: "t",
          entries: 3,
          updatedAt: "2026-10-22T08:00:00Z",
          lastPrompt: "x",
          branch: "dev",
          costUsd: 1.75,
          outcome: "done",
        },
        {
          id: "tui",
          title: "TUI concepts",
          tipId: "t",
          entries: 3,
          updatedAt: "2026-10-21T08:00:00Z",
          lastPrompt: "y",
          branch: "dev",
          costUsd: 0.4,
          outcome: "done",
        },
      ],
    },
    { type: "session_opened", sessionId: SID },
  );
  d.state = { ...d.state, details: true };
  return d;
}

const wire = (d: Driver, turnId: string, event: WireEvent, at = 2000): void =>
  d.daemon({ type: "turn_event", sessionId: SID, turnId, event, at });

function finished(d: Driver, turnId: string, prompt: string, withEdit = true): void {
  d.daemon({ type: "turn_started", sessionId: SID, turnId, prompt, images: [], at: 1000 });
  wire(d, turnId, { type: "thinking_delta", text: "check the flags first" });
  wire(d, turnId, { type: "thinking_end", ms: 11000 });
  if (withEdit) {
    wire(d, turnId, {
      type: "tool_start",
      id: `${turnId}r`,
      name: "read",
      input: { path: "packages/eval/harbor/run.sh" },
    });
    wire(d, turnId, { type: "tool_result", id: `${turnId}r`, content: "a\nb\nc", isError: false });
    wire(d, turnId, {
      type: "tool_start",
      id: `${turnId}e`,
      name: "edit",
      input: { path: "run.sh", oldText: "x", newText: "x\n--retry-include RuntimeError" },
    });
    wire(d, turnId, { type: "tool_result", id: `${turnId}e`, content: "ok", isError: false });
  }
  wire(d, turnId, { type: "text_delta", text: "Done.\n```sh\nharbor run -r 2\n```\n- `INFRA` is a list\n" });
  wire(d, turnId, {
    type: "turn_complete",
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 740 },
    timing: { ttftMs: 1000, streamMs: 10000 },
  });
  d.daemon({ type: "turn_finished", sessionId: SID, turnId, at: 13000, outcome: { stopReason: "end_turn" } });
}

function running(d: Driver, turnId = "live", prompt = "Also count start timeouts."): void {
  d.daemon({ type: "turn_started", sessionId: SID, turnId, prompt, images: [], at: 20000 });
  wire(d, turnId, { type: "thinking_delta", text: "the start timeout is an environment fault" });
  wire(d, turnId, { type: "tool_start", id: "lr", name: "read", input: { path: "report.py" } });
  wire(d, turnId, { type: "text_delta", text: "It goes in the `INFRA` list. Editing now" });
}

const turns = (d: Driver): Turn[] =>
  (current(d.state)?.blocks ?? []).filter((b): b is Turn => b.kind === "turn");
const askFor = (d: Driver, turnId = "live") =>
  wire(d, turnId, {
    type: "approval_requested",
    requestId: "ask1",
    sessionId: SID,
    turnId,
    riskTier: "dangerous",
    source: "default",
    argsSummary: "command=bash scripts/dry-run.sh",
    request: { tool: "bash", title: "bash scripts/dry-run.sh", command: "bash scripts/dry-run.sh" },
  });

describe("palette and global keys", () => {
  test("ctrl+p opens the palette; arrows move; a query runs a command", () => {
    const d = session();
    d.send(KEY.ctrl("p"));
    expect(d.state.palette.open).toBe(true);
    d.send(KEY.down);
    expect(d.state.palette.at).toBe(1);
    d.send(KEY.ctrl("p"));
    d.send(KEY.ctrl("p"));
    d.type("/rev");
    expect(d.state.palette.query).toBe("/rev");
    d.send(KEY.enter);
    expect(d.state.review.open).toBe(true);
    expect(d.state.palette.open).toBe(false);
    expect(d.last("load_review")).toBeDefined();
  });

  test("the palette is one list: sessions first, then commands", () => {
    const d = session();
    d.send(KEY.ctrl("p"));
    const items = paletteItems(d.state);
    expect(items.map((i) => i.kind)).toEqual(["session", "session", ...Array(8).fill("command")]);
    expect(items[0]).toMatchObject({ ref: SID, result: "done" });
    d.type("settings");
    expect(paletteItems(d.state).map((i) => i.label)).toEqual(["/settings"]);
  });

  test("esc leaves review, ctrl+r opens it, ctrl+enter commits and pushes", () => {
    const d = session();
    d.send(KEY.ctrl("r"));
    expect(d.state.review.open).toBe(true);
    d.send(KEY.esc);
    expect(d.state.review.open).toBe(false);
    d.send(KEY.ctrl("r"));
    d.daemon({
      type: "git_loaded",
      git: {
        repo: true,
        suggestedMessage: "fix the retry flags",
        files: [{ path: "a.ts", status: "M", added: 2, deleted: 1 }],
      },
    });
    d.send(KEY.ctrlEnterKitty);
    expect(d.last("commit")).toEqual({
      type: "commit",
      sessionId: SID,
      message: "fix the retry flags",
      push: true,
    });
    d.send(KEY.enter);
    expect(d.last("commit")).toMatchObject({ push: false });
    d.send(KEY.ctrlJ);
    expect(d.effects.filter((e) => e.type === "commit" && e.push)).toHaveLength(2);
  });

  test("nothing to commit, or already committed: enter does nothing", () => {
    const d = session();
    d.send(KEY.ctrl("r"));
    d.send(KEY.enter);
    expect(d.last("commit")).toBeUndefined();
    d.daemon(
      { type: "git_loaded", git: { repo: true, files: [{ path: "a", status: "M", added: 1, deleted: 0 }] } },
      { type: "committed", pushed: false, branch: "dev" },
    );
    d.send(KEY.enter);
    expect(d.last("commit")).toBeUndefined();
  });

  test("ctrl+d hides details, ctrl+n goes home", () => {
    const d = session();
    d.send(KEY.ctrl("d"));
    expect(d.state.details).toBe(false);
    d.send(KEY.ctrl("n"));
    expect(d.state.view).toBe("home");
    expect(d.state.sessionId).toBeNull();
  });

  test("details show only from 120 columns; below, context rides in the hint row", () => {
    const status = {
      type: "status_loaded" as const,
      sessionId: SID,
      line: null,
      status: {
        sessionId: SID,
        model: "m",
        effort: null,
        mode: "ask",
        costUsd: 0,
        contextTokens: 50,
        contextLimit: 100,
        cacheHitRate: null,
        branch: null,
      },
    };
    const narrow = session({ cols: 119 });
    narrow.daemon(status);
    expect(ctxNote(narrow.state)).toBe(" · 50% ctx");
    const wide = session({ cols: 120 });
    wide.daemon(status);
    expect(ctxNote(wide.state)).toBe("");
  });
});

describe("approvals", () => {
  test("the ask replaces the prompt; y allows once and the turn keeps running", () => {
    const d = session();
    running(d);
    askFor(d);
    expect(showAsk(d.state)).toBe(true);
    d.send("y");
    expect(d.last("respond")).toMatchObject({ requestId: "ask1", decision: "once" });
    expect(showAsk(d.state)).toBe(false);
    expect(isWorking(d.state)).toBe(true);
    expect(hints(d.state).map((h) => h.label)).toContain("stop");
    expect(d.last("cancel_turn")).toBeUndefined();
  });

  test("a answers always; other keys do nothing while the ask is open", () => {
    const d = session();
    running(d);
    askFor(d);
    d.send("x");
    expect(d.state.composer.text).toBe("");
    d.send("a");
    expect(d.last("respond")).toMatchObject({ decision: "always" });
  });

  test("n and esc deny and stop the turn; the stamp and the step say denied", () => {
    for (const key of ["n", KEY.esc]) {
      const d = session();
      running(d);
      askFor(d);
      d.send(key);
      expect(d.last("respond")).toMatchObject({ decision: "reject" });
      expect(d.last("cancel_turn")).toMatchObject({ turnId: "live" });
      const t = turns(d).at(-1) as Turn;
      expect(t.status).toBe("denied");
      expect(turnStamp(t, false).label).toBe("denied");
      expect(stepView(t.steps.at(-1) as never, false).meta).toBe("");
      expect(isHalted(d.state)).toBe(true);
    }
  });

  test("an allowed step keeps its answer in the ledger", () => {
    const d = session();
    running(d);
    wire(d, "live", {
      type: "tool_start",
      id: "b1",
      name: "bash",
      input: { command: "bash scripts/dry-run.sh" },
    });
    askFor(d);
    d.send("y");
    const step = (turns(d).at(-1) as Turn).steps.at(-1);
    expect(step && stepView(step, false).meta).toBe("allowed once");
  });
});

describe("home, offline and empty states", () => {
  test("enter on an empty prompt retries a turn that failed", () => {
    const d = session();
    d.daemon({
      type: "turn_started",
      sessionId: SID,
      turnId: "bad",
      prompt: "Pathfinding stalls.",
      images: [],
      at: 1,
    });
    wire(d, "bad", { type: "error", code: "overloaded", message: "HTTP 529" });
    d.daemon({ type: "turn_finished", sessionId: SID, turnId: "bad", at: 2, outcome: {} });
    expect(canRetry(d.state)).toBe(true);
    d.send(KEY.enter);
    expect(d.last("send_turn")).toMatchObject({ text: "Pathfinding stalls.", sessionId: SID });
  });

  test("offline hides the prompt, the footer says so and r reconnects", () => {
    const d = session();
    d.daemon({ type: "conn", status: "offline" });
    expect(footer(d.state)).toEqual({ text: "✗ daemon unreachable · run agency daemon start", tone: "del" });
    d.send("hello");
    expect(d.state.composer.text).toBe("");
    d.send("r");
    expect(d.last("reconnect")).toBeDefined();
  });

  test("empty home: footer, labels and no sessions", () => {
    const d = new Driver();
    d.daemon({ type: "conn", status: "online" });
    expect(footer(d.state).text).toBe("daemon ready");
    expect(othersLabel(d.state)).toBe("go to");
  });

  test("no provider key: the picker has the state to show", () => {
    const d = new Driver();
    d.daemon(
      { type: "conn", status: "online" },
      { type: "models_loaded", models: [], connected: [], defaultModel: null },
    );
    expect(noProviders(d.state)).toBe(true);
    expect(flatModels(d.state)).toEqual([]);
  });

  test("the footer counts sessions and their cost", () => {
    expect(footer(session().state).text).toBe("daemon ready · 2 sessions");
    const d = session();
    d.daemon({ type: "week_cost_loaded", costUsd: 2.15 });
    expect(footer(d.state).text).toBe("daemon ready · 2 sessions · $2.15 this week");
    expect(othersLabel(session().state)).toBe("1 more");
  });

  test("24 rows drop the logo", () => {
    expect(showLogo(session({ rows: 24 }).state)).toBe(false);
    expect(showLogo(session({ rows: 30 }).state)).toBe(true);
  });

  test("the orbit marks a session that runs elsewhere, not the open one", () => {
    const d = session();
    d.daemon({ type: "live_turns", sessionIds: [SID] });
    expect(othersRunning(d.state)).toBe(false);
    d.daemon({ type: "live_turns", sessionIds: ["tui"] });
    expect(othersRunning(d.state)).toBe(true);
  });
});

describe("ledger, pick and copy", () => {
  test("a finished turn has its closing row: copy, thought, wall time and rate", () => {
    const d = session();
    finished(d, "t1", "Make the runs faster.");
    const t = turns(d)[0] as Turn;
    expect(turnFoot(t, null)).toEqual({
      copyLabel: "copy",
      thought: "thought 11s",
      stats: "· 12s · 74 tok/s",
    });
    expect(turnFoot(t, "t1").copyLabel).toBe("✓ copied");
  });

  test("a compaction marker leads the transcript", () => {
    const d = session();
    d.daemon({
      type: "session_loaded",
      sessionId: SID,
      tipId: "x",
      entries: [
        { id: "c", type: "compaction_summary", summary: "s", replacedEntryIds: [] },
        { id: "m", type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
      ],
    });
    expect(current(d.state)?.blocks[0]).toMatchObject({
      kind: "event",
      text: "compacted · earlier turns summarized",
    });
  });

  test("a running turn reads reasoning, streams an open block and does not repeat esc", () => {
    const d = session();
    running(d);
    const t = turns(d)[0] as Turn;
    expect(runningThought(t, false)).toBe("reasoning");
    expect(turnStamp(t, false).note).not.toMatch(/esc/);
    expect(t.answer.tail).not.toBe("");
  });

  test("esc esc on an idle prompt picks the last finished turn, esc leaves", () => {
    const d = session();
    finished(d, "t1", "one");
    finished(d, "t2", "two");
    d.now += 100;
    d.send(KEY.esc);
    d.now += 200;
    d.send(KEY.esc);
    expect(current(d.state)?.pickAt).toBe(1);
    expect(hints(d.state).map((h) => h.key)).toEqual(["↑↓", "enter", "c", "t", "esc"]);
    d.send(KEY.up);
    expect(current(d.state)?.pickAt).toBe(0);
    d.send(KEY.down);
    d.send(KEY.down);
    expect(current(d.state)?.pickAt).toBeNull();
  });

  test("two escapes too far apart do not pick", () => {
    const d = session();
    finished(d, "t1", "one");
    d.send(KEY.esc);
    d.now += 2000;
    d.send(KEY.esc);
    expect(current(d.state)?.pickAt).toBeNull();
  });

  test("c copies the picked turn, t opens its reasoning, enter opens every step output", () => {
    const d = session();
    finished(d, "t1", "one");
    d.send(KEY.esc);
    d.now += 100;
    d.send(KEY.esc);
    d.send("c");
    expect(d.last("copy")?.text).toContain("harbor run -r 2");
    expect(d.state.copied).toBe("t1");
    d.send("t");
    expect((turns(d)[0] as Turn).thoughtOpen).toBe(true);
    d.send(KEY.enter);
    const t = turns(d)[0] as Turn;
    expect(t.steps.every((s) => s.open)).toBe(true);
    expect(stepView(t.steps[1] as never, false).out.some((o) => o.text.includes("retry-include"))).toBe(true);
    d.send(KEY.enter);
    expect((turns(d)[0] as Turn).steps.every((s) => !s.open)).toBe(true);
    d.send(KEY.esc);
    expect(current(d.state)?.pickAt).toBeNull();
  });

  test("/turns from the palette picks the last turn", () => {
    const d = session();
    finished(d, "t1", "one");
    d.send(KEY.ctrl("p"));
    d.type("/turns");
    d.send(KEY.enter);
    expect(current(d.state)?.pickAt).toBe(0);
  });

  test("a failed turn says stopped once", () => {
    const d = session();
    d.daemon({ type: "turn_started", sessionId: SID, turnId: "bad", prompt: "x", images: [], at: 1 });
    wire(d, "bad", { type: "error", code: "e", message: "m" });
    d.daemon({ type: "turn_finished", sessionId: SID, turnId: "bad", at: 2, outcome: {} });
    expect(turnStamp(turns(d)[0] as Turn, false)).toMatchObject({ label: "stopped", note: "" });
  });

  test("a paused turn reads paused throughout and its step is not live", () => {
    const d = session();
    running(d);
    d.daemon({ type: "conn", status: "offline" });
    const t = turns(d)[0] as Turn;
    expect(turnStamp(t, true).label).toBe("paused");
    expect(runningThought(t, true)).toMatch(/paused/);
    expect(stepView(t.steps[0] as never, true).live).toBe(false);
  });
});

describe("completion", () => {
  test("@ lists files; tab inserts the path", () => {
    const d = session();
    d.type("fix @rep");
    expect(completion(d.state)[0]?.label).toBe("report.py");
    d.send(KEY.tab);
    expect(d.state.composer.text).toBe("fix @packages/eval/harbor/report.py ");
    expect(d.state.ac).toBeNull();
  });

  test("/ lists commands, enter inserts, a second enter runs a client command", () => {
    const d = session();
    d.type("/re");
    expect(completion(d.state)[0]?.label).toBe("/review");
    d.send(KEY.enter);
    expect(d.state.composer.text).toBe("/review ");
    d.send(KEY.enter);
    expect(d.state.review.open).toBe(true);
    expect(d.state.composer.text).toBe("");
  });

  test("no match: the list says so; esc closes it without stopping the turn", () => {
    const d = session();
    running(d);
    d.type("@zzz");
    expect(d.state.ac).not.toBeNull();
    expect(completion(d.state)).toEqual([]);
    d.send(KEY.esc);
    expect(d.state.ac).toBeNull();
    expect(d.last("cancel_turn")).toBeUndefined();
    expect(isWorking(d.state)).toBe(true);
  });

  test("arrows move through the list and wrap", () => {
    const d = session();
    d.type("@r");
    const n = completion(d.state).length;
    expect(n).toBeGreaterThan(1);
    d.send(KEY.up);
    expect(d.state.ac?.i).toBe(n - 1);
    d.send(KEY.down);
    expect(d.state.ac?.i).toBe(0);
  });
});

describe("settings", () => {
  test("ctrl+, opens settings; space cycles the theme and writes one config key", () => {
    const d = session();
    d.send(KEY.ctrlComma);
    expect(d.state.view).toBe("settings");
    expect(d.last("load_settings")).toBeDefined();
    d.send(KEY.enter);
    d.send(" ");
    expect(d.state.theme).toBe("night");
    expect(d.last("config_write")).toEqual({ type: "config_write", key: "theme", value: "night" });
  });

  test("the effort row cycles the effort of the state", () => {
    const d = session();
    d.send(KEY.ctrlComma);
    d.send(KEY.down);
    d.send(KEY.enter);
    d.send(KEY.down);
    d.send(KEY.down);
    const row = SETTINGS[1]?.rows[2];
    expect(row && settingValue(d.state, row)).toBe("high");
    d.send(" ");
    expect(d.state.effort).toBe("xhigh");
  });

  test("esc steps out of a row, then out of settings", () => {
    const d = session();
    d.send(KEY.ctrlComma);
    d.send(KEY.enter);
    d.send(KEY.esc);
    expect(d.state.settings.row).toBeNull();
    expect(d.state.view).toBe("settings");
    d.send(KEY.esc);
    expect(d.state.view).toBe("session");
  });

  test("a toggle row flips and writes a boolean", () => {
    const d = session();
    d.send(KEY.ctrlComma);
    d.send(KEY.enter);
    d.send(KEY.down);
    d.send(KEY.down);
    d.send(" ");
    expect(d.last("config_write")).toEqual({ type: "config_write", key: "telemetryEnabled", value: true });
  });
});

describe("prompt: queue, history, shell, images", () => {
  test("enter while a turn runs queues the prompt; up pulls it back to edit", () => {
    const d = session();
    running(d);
    d.type("also check 529");
    d.send(KEY.enter);
    expect(current(d.state)?.queue).toHaveLength(1);
    expect(queuedRows(d.state)[0]).toEqual({
      text: "› also check 529",
      note: "queued · sends when this turn ends",
    });
    expect(d.last("send_turn")).toBeUndefined();
    d.send(KEY.up);
    expect(d.state.composer.text).toBe("also check 529");
    expect(current(d.state)?.queue).toHaveLength(0);
  });

  test("a queued prompt goes when its turn ends, but waits for enter after a stop", () => {
    const d = session();
    running(d);
    d.type("next one");
    d.send(KEY.enter);
    d.daemon({
      type: "turn_finished",
      sessionId: SID,
      turnId: "live",
      at: 30000,
      outcome: { stopReason: "end_turn" },
    });
    d.drain();
    expect(d.last("send_turn")).toMatchObject({ text: "next one" });

    const e = session();
    running(e);
    e.type("held");
    e.send(KEY.enter);
    e.send(KEY.esc);
    e.daemon({
      type: "turn_finished",
      sessionId: SID,
      turnId: "live",
      at: 30000,
      outcome: { cancelled: true },
    });
    e.drain();
    expect(e.last("send_turn")).toBeUndefined();
    expect(queuedRows(e.state)[0]?.note).toBe("turn stopped · enter sends it");
    e.send(KEY.enter);
    expect(e.last("send_turn")).toMatchObject({ text: "held" });
  });

  test("up recalls the last prompt, again goes further back, down returns to empty", () => {
    const d = session();
    d.daemon({ type: "history_loaded", prompts: ["newest prompt", "older prompt"] });
    d.send(KEY.up);
    expect(d.state.composer.text).toBe("newest prompt");
    d.send(KEY.up);
    expect(d.state.histAt).toBe(1);
    expect(d.state.composer.text).toBe("older prompt");
    d.send(KEY.down);
    d.send(KEY.down);
    expect(d.state.composer.text).toBe("");
    expect(d.state.histAt).toBe(-1);
  });

  test("up in a prompt you are typing moves the caret, it does not recall", () => {
    const d = session();
    d.daemon({ type: "history_loaded", prompts: ["old"] });
    d.type("typed");
    d.send(KEY.up);
    expect(d.state.composer.text).toBe("typed");
  });

  test("! enters shell mode; the command runs and lands below the turn with its output", () => {
    const d = session();
    finished(d, "t1", "one");
    d.type("!");
    expect(d.state.composer.shell).toBe(true);
    expect(d.state.composer.text).toBe("");
    d.type("git status");
    d.send(KEY.enter);
    const run = d.last("shell_run");
    expect(run).toMatchObject({ command: "git status", sessionId: SID });
    d.daemon({
      type: "shell_finished",
      sessionId: SID,
      id: run?.id as string,
      output: "On branch dev\nclean\n",
      isError: false,
    });
    const blocks = current(d.state)?.blocks ?? [];
    expect(blocks.at(-1)).toMatchObject({
      kind: "shell",
      cmd: "git status",
      out: ["On branch dev", "clean"],
      status: "done",
    });
    expect(blocks.findIndex((b) => b.kind === "shell")).toBeGreaterThan(0);
  });

  test("backspace on an empty prompt leaves shell mode", () => {
    const d = session();
    d.type("!");
    d.send(KEY.backspace);
    expect(d.state.composer.shell).toBe(false);
  });

  test("a shell line typed while a turn runs is queued as a command", () => {
    const d = session();
    running(d);
    d.type("!ls");
    d.send(KEY.enter);
    expect(queuedRows(d.state)[0]?.text).toBe("! ls");
    d.send(KEY.up);
    expect(d.state.composer).toMatchObject({ shell: true, text: "ls" });
  });

  test("a pasted image is a chip; it rides with the prompt; backspace removes it", () => {
    const d = session();
    d.daemon({ type: "turn_finished", sessionId: SID, turnId: "none", at: 0, outcome: {} });
    d.apply([
      { type: "image_added", chip: { name: "image 1", size: 188000, mimeType: "image/png", data: "AAAA" } },
    ]);
    expect(imageLabel(d.state.images[0] as never, 0)).toBe("▣ image 1 · 184 KB");
    d.send(KEY.backspace);
    expect(d.state.images).toHaveLength(0);

    d.apply([
      { type: "image_added", chip: { name: "image 1", size: 188000, mimeType: "image/png", data: "AAAA" } },
    ]);
    d.type("see this");
    d.send(KEY.enter);
    const sent = d.last("send_turn");
    expect(sent?.images).toHaveLength(1);
    expect(youText(turns(d).at(-1) as Turn)).toBe("see this  [image 1]");
    expect(d.state.images).toHaveLength(0);
  });

  test("a text paste lands in the prompt as one edit, with its newlines", () => {
    const d = session();
    d.send("\x1b[200~line one\nline two\x1b[201~");
    expect(d.state.composer.text).toBe("line one\nline two");
  });

  test("ctrl+j, alt+enter and backslash then enter add a line; plain enter sends", () => {
    const d = session();
    d.type("a");
    d.send(KEY.ctrlJ);
    d.type("b");
    d.send(KEY.altEnter);
    d.type("c\\");
    d.send(KEY.enter);
    expect(d.state.composer.text).toBe("a\nb\nc\n");
    expect(d.last("send_turn")).toBeUndefined();
    d.type("d");
    d.send(KEY.enter);
    expect(d.last("send_turn")?.text).toBe("a\nb\nc\nd");
  });

  test("tab and shift+tab cycle build, plan and auto", () => {
    const d = session();
    d.send(KEY.tab);
    expect(d.state.mode).toBe("plan");
    d.send(KEY.tab);
    expect(d.state.mode).toBe("auto");
    d.send(KEY.tab);
    expect(d.state.mode).toBe("build");
    d.send(KEY.shiftTab);
    expect(d.state.mode).toBe("auto");
  });

  test("a prompt from home starts a session, the turn and the send together", () => {
    const d = new Driver();
    d.daemon(
      { type: "conn", status: "online" },
      { type: "models_loaded", models: [], connected: ["anthropic"], defaultModel: "anthropic/m" },
    );
    d.type("first prompt");
    d.send(KEY.enter);
    const sent = d.last("send_turn");
    expect(sent).toMatchObject({ create: true, text: "first prompt", model: "anthropic/m", mode: "build" });
    expect(d.state.view).toBe("session");
    expect(d.state.sessionId).toBe(sent?.sessionId as string);
    expect(turns(d)).toHaveLength(1);
  });

  test("a client command (/settings) acts here and is not sent", () => {
    const d = session();
    d.type("/settings");
    d.send(KEY.tab);
    d.send(KEY.enter);
    expect(d.state.view).toBe("settings");
    expect(d.last("send_turn")).toBeUndefined();
  });

  test("another slash command goes to the daemon as a command", () => {
    const d = session();
    d.type("/compact");
    d.send(KEY.tab);
    d.send(KEY.enter);
    expect(d.last("slash_command")).toMatchObject({ sessionId: SID, text: "/compact" });
  });
});

describe("scroll, stop and narrow layout", () => {
  test("pgup scrolls back a page of rows and says how far; ctrl+end returns", () => {
    const d = session();
    finished(d, "t1", "one");
    finished(d, "t2", "two");
    finished(d, "t3", "three");
    d.send(KEY.pgup);
    d.send(KEY.pgup);
    const s = current(d.state);
    expect(s?.scroll).toBe(2 * (d.state.rows - 10));
    expect(s && newerLabel(s)).toBe(`${2 * (d.state.rows - 10)} newer rows below`);
    expect(hints(d.state)[0]?.key).toBe("pgdn");
    d.send(KEY.ctrlEnd);
    expect(current(d.state)?.scroll).toBe(0);
  });

  test("the wheel scrolls the transcript three rows a notch and stops at the top the view measured", () => {
    const d = session();
    finished(d, "t1", "one");
    d.daemon({ type: "scroll_max", sessionId: SID, n: 4 });
    d.send(KEY.wheelUp);
    expect(current(d.state)?.scroll).toBe(3);
    for (let i = 0; i < 5; i++) d.send(KEY.wheelUp);
    expect(current(d.state)?.scroll).toBe(4);
    d.send(KEY.wheelDown);
    expect(current(d.state)?.scroll).toBe(1);
    // The wheel is not the history: an empty composer stays empty.
    expect(d.state.composer.text).toBe("");
    expect(d.state.histAt).toBe(-1);
  });

  test("esc stops a running turn", () => {
    const d = session();
    running(d);
    d.send(KEY.esc);
    expect(d.last("cancel_turn")).toEqual({ type: "cancel_turn", turnId: "live" });
    expect(turns(d)[0]?.status).toBe("stopped");
  });

  test("ctrl+c clears the prompt, then stops the turn, then quits on a second press", () => {
    const d = session();
    running(d);
    d.type("draft");
    d.send(KEY.ctrl("c"));
    expect(d.state.composer.text).toBe("");
    d.send(KEY.ctrl("c"));
    expect(d.last("cancel_turn")).toBeDefined();
    d.daemon({ type: "turn_finished", sessionId: SID, turnId: "live", at: 1, outcome: { cancelled: true } });
    d.send(KEY.ctrl("c"));
    expect(d.last("quit")).toBeUndefined();
    d.now += 500;
    d.send(KEY.ctrl("c"));
    expect(d.last("quit")).toBeDefined();
  });

  test("narrow puts context and tasks in the hint row, wide shows effort and the status line", () => {
    const narrow = session({ cols: 80, rows: 24 });
    narrow.daemon(
      {
        type: "status_loaded",
        sessionId: SID,
        line: "ci passing",
        status: {
          sessionId: SID,
          model: "m",
          effort: null,
          mode: "ask",
          costUsd: 1,
          contextTokens: 112000,
          contextLimit: 200000,
          cacheHitRate: 0.9,
          branch: "dev",
        },
      },
      {
        type: "todos_loaded",
        sessionId: SID,
        todos: [
          { id: "1", content: "a", status: "completed" },
          { id: "2", content: "b", status: "completed" },
          { id: "3", content: "c", status: "in_progress" },
          { id: "4", content: "d", status: "pending" },
        ],
      },
    );
    expect(ctxNote(narrow.state)).toBe(" · 56% ctx · 2/4 tasks");
    expect(effortNote(narrow.state)).toBe("");
    expect(statusText(narrow.state)).toBe("");
    const wide = session({ cols: 140 });
    wide.daemon({
      type: "status_loaded",
      sessionId: SID,
      line: "ci passing",
      status: {
        sessionId: SID,
        model: "m",
        effort: null,
        mode: "ask",
        costUsd: 1,
        contextTokens: 1,
        contextLimit: 2,
        cacheHitRate: null,
        branch: null,
      },
    });
    expect(statusText(wide.state)).toBe("ci passing");
    expect(effortNote(wide.state)).toBe(" · high");
  });

  test("the hint row follows the state: history on wide, stop while running", () => {
    expect(hints(session({ cols: 140 }).state)[0]).toEqual({ key: "↑", label: "history" });
    expect(hints(session({ cols: 80 }).state)[0]).toEqual({ key: "esc esc", label: "turns" });
    const d = session();
    running(d);
    expect(hints(d.state)).toEqual([
      { key: "esc", label: "stop" },
      { key: "ctrl+p", label: "commands" },
    ]);
  });
});

describe("model picker", () => {
  const models = [
    {
      ref: "anthropic/haiku",
      provider: "anthropic",
      providerName: "Anthropic",
      id: "haiku",
      name: "Haiku",
      contextWindow: 200000,
      inPerMTok: 0.1,
      outPerMTok: 0.5,
      tags: "",
    },
    {
      ref: "anthropic/sonnet",
      provider: "anthropic",
      providerName: "Anthropic",
      id: "sonnet",
      name: "Sonnet",
      contextWindow: 1000000,
      inPerMTok: 2,
      outPerMTok: 10,
      tags: "",
    },
    {
      ref: "openrouter/laguna",
      provider: "openrouter",
      providerName: "OpenRouter",
      id: "laguna",
      name: "Laguna",
      contextWindow: 128000,
      inPerMTok: 0,
      outPerMTok: 0,
      tags: "free",
    },
  ];

  test("words filter, arrows pick, enter applies and remembers the recent one", () => {
    const d = session();
    d.daemon({
      type: "models_loaded",
      models,
      connected: ["anthropic", "openrouter"],
      defaultModel: "anthropic/sonnet",
    });
    d.apply([{ type: "model_open" }]);
    d.type("free");
    expect(flatModels(d.state).map((m) => m.id)).toEqual(["laguna"]);
    d.send(KEY.enter);
    expect(d.state.defaultModel).toBe("openrouter/laguna");
    expect(d.state.model.open).toBe(false);
    expect(d.state.model.recent).toEqual(["openrouter/laguna"]);
    d.apply([{ type: "model_open" }]);
    expect(flatModels(d.state)[0]?.id).toBe("laguna");
  });

  test("esc closes the picker without a choice", () => {
    const d = session();
    d.daemon({ type: "models_loaded", models, connected: ["anthropic"], defaultModel: "anthropic/sonnet" });
    d.apply([{ type: "model_open" }]);
    d.send(KEY.esc);
    expect(d.state.model.open).toBe(false);
    expect(d.state.defaultModel).toBe("anthropic/sonnet");
  });
});
