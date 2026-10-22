/** Data the daemon sends since stage 3: step facts, turn ends, session outcomes, commits and the review scroll. */
import { describe, expect, test } from "bun:test";
import { hydrate } from "../src/state/hydrate.ts";
import {
  footer,
  reviewFiles,
  stepView,
  type Turn,
  turnStamp,
  type WireEntry,
  type WireEvent,
} from "../src/state/index.ts";
import { sessionMark } from "../src/view/home.ts";
import { Driver, KEY } from "./helpers.ts";

const SID = "s";

function opened(): Driver {
  const d = new Driver({ cols: 120, rows: 40 } as never);
  d.daemon(
    { type: "conn", status: "online" },
    {
      type: "sessions_loaded",
      rows: [
        {
          id: SID,
          title: "t",
          tipId: "x",
          entries: 1,
          updatedAt: null,
          lastPrompt: null,
          branch: "dev",
          costUsd: 1,
          outcome: "done",
        },
        {
          id: "bad",
          title: "b",
          tipId: "x",
          entries: 1,
          updatedAt: null,
          lastPrompt: null,
          branch: "dev",
          costUsd: 1,
          outcome: "failed",
        },
        {
          id: "unknown",
          title: "u",
          tipId: "x",
          entries: 1,
          updatedAt: null,
          lastPrompt: null,
          branch: "dev",
          costUsd: 1,
          outcome: null,
        },
      ],
    },
    { type: "session_opened", sessionId: SID },
  );
  return d;
}

const wire = (d: Driver, turnId: string, event: WireEvent): void =>
  d.daemon({ type: "turn_event", sessionId: SID, turnId, event, at: 2000 });

const turnOf = (d: Driver): Turn => {
  const t = d.state.bySession[SID]?.blocks.findLast((b): b is Turn => b.kind === "turn");
  if (!t) throw new Error("no turn");
  return t;
};

describe("steps carry what the tool measured", () => {
  test("a read shows its lines, a failed bash its exit code, an edit its real +N −M", () => {
    const d = opened();
    d.daemon({ type: "turn_started", sessionId: SID, turnId: "t", prompt: "go", images: [], at: 1000 });
    const call = (id: string, name: string, input: Record<string, unknown>, extra: object) => {
      wire(d, "t", { type: "tool_start", id, name, input });
      wire(d, "t", { type: "tool_result", id, content: "x", isError: false, ...extra } as WireEvent);
    };
    call("r", "read", { path: "a.ts" }, { meta: { lines: 34 } });
    wire(d, "t", { type: "tool_start", id: "b", name: "bash", input: { command: "cargo test" } });
    wire(d, "t", { type: "tool_result", id: "b", content: "boom", isError: true, meta: { exitCode: 101 } });
    call("e", "edit", { path: "a.ts", oldText: "a", newText: "b" }, { meta: { added: 7, removed: 3 } });
    const [read, bash, edit] = turnOf(d).steps.map((s) => stepView(s, false));
    expect(read?.meta).toBe("34 lines");
    expect(bash?.meta).toBe("exit 101");
    expect(bash?.metaTone).toBe("del");
    expect([edit?.add, edit?.del]).toEqual(["+7 ", "−3"]);
  });

  test("the shell block says the exit code the daemon gave", () => {
    const d = opened();
    d.daemon(
      { type: "shell_started", sessionId: SID, id: "sh", cmd: "false" },
      { type: "shell_finished", sessionId: SID, id: "sh", output: "", isError: true, exitCode: 1 },
    );
    const block = d.state.bySession[SID]?.blocks.at(-1);
    expect(block).toMatchObject({ kind: "shell", exitCode: 1, status: "error" });
  });
});

describe("the stamp of a turn", () => {
  const finish = (end?: object): Turn => {
    const d = opened();
    d.daemon({ type: "turn_started", sessionId: SID, turnId: "t", prompt: "go", images: [], at: 1000 });
    wire(d, "t", { type: "tool_start", id: "r", name: "read", input: {} });
    wire(d, "t", { type: "tool_result", id: "r", content: "", isError: false });
    d.daemon({
      type: "turn_finished",
      sessionId: SID,
      turnId: "t",
      at: 3000,
      outcome: { stopReason: "end_turn", ...(end ? { end } : {}) } as never,
    });
    return turnOf(d);
  };

  test("verified needs a commit in the turn and a check that passed", () => {
    const stamp = turnStamp(
      finish({ outcome: "done", checks: "passed", head: { before: "a1", after: "b2" } }),
      false,
    );
    expect([stamp.label, stamp.note]).toEqual(["verified", " · b2"]);
  });

  test("a commit with no passing check, or passing checks with no commit, stay done", () => {
    for (const end of [
      { outcome: "done", checks: "none", head: { before: "a1", after: "b2" } },
      { outcome: "done", checks: "stale", head: { before: "a1", after: "b2" } },
      { outcome: "done", checks: "passed", head: { before: "a1", after: "a1" } },
    ]) {
      const stamp = turnStamp(finish(end), false);
      expect([stamp.label, stamp.note]).toEqual(["done", " · 1 steps"]);
    }
    expect(turnStamp(finish(), false).label).toBe("done");
  });
});

describe("a reloaded session keeps how each turn ended", () => {
  const prompt = (id: string): WireEntry => ({
    id,
    type: "message",
    turnId: id,
    message: { role: "user", content: [{ type: "text", text: id }] },
  });
  const answer = (id: string): WireEntry => ({
    id: `${id}a`,
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
  });
  const end = (forTurn: string, rest: object): WireEntry =>
    ({ id: `${forTurn}e`, type: "turn_end", forTurn, checks: "none", ...rest }) as WireEntry;

  test("stopped, denied and failed turns stamp as such", () => {
    const h = hydrate([
      prompt("a"),
      answer("a"),
      end("a", { outcome: "stopped" }),
      prompt("b"),
      answer("b"),
      end("b", { outcome: "denied", deniedBy: "bash rm -rf x" }),
      prompt("c"),
      end("c", { outcome: "failed", error: { code: "x", message: "provider down" } }),
    ]);
    const [a, b, c] = h.blocks as Turn[];
    expect([a?.status, b?.status, c?.status]).toEqual(["stopped", "denied", "error"]);
    expect(turnStamp(b as Turn, false).note).toContain("you denied bash rm -rf x");
    expect(c?.error?.message).toBe("provider down");
  });

  test("the last turn with no end entry, in a session that has them, was cut off unless it runs", () => {
    const entries = [prompt("a"), answer("a"), end("a", { outcome: "done" }), prompt("b"), answer("b")];
    const cut = hydrate(entries).blocks as Turn[];
    expect([cut[0]?.status, cut[1]?.status]).toEqual(["done", "stopped"]);
    expect(turnStamp(cut[1] as Turn, false).label).toBe("interrupted");
    expect((hydrate(entries, true).blocks[1] as Turn).status).toBe("done");
    // A session from before end entries has none: its turns count as done.
    expect((hydrate([prompt("a"), answer("a")]).blocks[0] as Turn).status).toBe("done");
  });
});

describe("the mark of a session in a list", () => {
  test("the daemon's outcome decides: done, failed, or unknown", () => {
    const d = opened();
    expect(sessionMark(d.state, "bad", 0)).toEqual({ mark: "✗", result: "stopped" });
    expect(sessionMark(d.state, "unknown", 0)).toEqual({ mark: "·", result: "" });
    d.daemon({ type: "live_turns", sessionIds: ["bad"] });
    expect(sessionMark(d.state, "bad", 0).result).toBe("running");
  });

  test("the footer says this week's spend once the daemon reports it", () => {
    const d = opened();
    expect(footer(d.state).text).toBe("daemon ready · 3 sessions");
    d.daemon({ type: "week_cost_loaded", costUsd: 4.5 });
    expect(footer(d.state).text).toBe("daemon ready · 3 sessions · $4.50 this week");
  });
});

describe("review: commit and scroll", () => {
  const diff = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,0 +1,40 @@\n${Array.from({ length: 40 }, (_, i) => `+line ${i}`).join("\n")}\n`;
  const reviewing = (): Driver => {
    const d = opened();
    d.send(KEY.ctrl("r"));
    d.daemon({
      type: "git_loaded",
      git: {
        repo: true,
        branch: "dev",
        suggestedMessage: "fix the retry flags",
        files: [{ path: "a.ts", status: "M", added: 40, deleted: 0 }],
      },
      diff: { diff, untracked: [] },
    });
    return d;
  };

  test("enter commits the suggested message with the session; the note says where it went", () => {
    const d = reviewing();
    d.send(KEY.enter);
    expect(d.last("commit")).toEqual({
      type: "commit",
      sessionId: SID,
      message: "fix the retry flags",
      push: false,
    });
    d.daemon({ type: "committed", pushed: true, branch: "dev", upstream: "origin/dev" });
    expect(d.state.review.commitNote).toBe("committed and pushed to origin/dev");
    d.daemon({ type: "committed", pushed: false, branch: "dev" });
    expect(d.state.review.commitNote).toBe("committed on dev");
    // Loading the status again after the commit keeps the message that was committed.
    d.daemon({ type: "git_loaded", git: { repo: true, suggestedMessage: "other", files: [] } });
    expect(d.state.review.commitMessage).toBe("fix the retry flags");
  });

  test("page down scrolls the diff to its end and page up back, and another file starts at the top", () => {
    const d = reviewing();
    expect(reviewFiles(d.state)[0]?.lines.length).toBe(41);
    d.send(KEY.pgdn);
    const first = d.state.review.scroll;
    expect(first).toBeGreaterThan(0);
    d.send(KEY.pgdn);
    d.send(KEY.pgdn);
    d.send(KEY.pgdn);
    const end = d.state.review.scroll;
    expect(end).toBe(41 - (d.state.rows - 11));
    d.send(KEY.pgup);
    expect(d.state.review.scroll).toBeLessThan(end);
    d.daemon({ type: "review_file", i: 0 });
    expect(d.state.review.scroll).toBe(0);
  });
});

describe("review on screen", () => {
  test("the diff scrolls, a long line ends in an ellipsis, the box shows the message and then the note", async () => {
    const { mount } = await import("./render.ts");
    const long = `+${"x".repeat(200)}`;
    const diff = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,0 +1,30 @@\n${long}\n${Array.from({ length: 29 }, (_, i) => `+line ${i}`).join("\n")}\n`;
    const d = opened();
    d.send(KEY.ctrl("r"));
    d.daemon({
      type: "git_loaded",
      git: {
        repo: true,
        branch: "dev",
        suggestedMessage: "fix the retry flags",
        files: [{ path: "a.ts", status: "M", added: 30, deleted: 0 }],
      },
      diff: { diff, untracked: [] },
    });
    const m = await mount(d.state);
    expect(m.grid.some((r) => r.includes("1–") && r.includes("of 31"))).toBe(true);
    expect(m.grid.some((r) => r.includes("xxx…"))).toBe(true);
    expect(m.grid.some((r) => r.includes("✓ fix the retry flags") && r.includes("enter commit"))).toBe(true);
    d.send(KEY.pgdn);
    await m.set(d.state);
    expect(m.grid.some((r) => r.includes("line 28"))).toBe(true);
    d.daemon({ type: "committed", pushed: true, branch: "dev", upstream: "origin/dev" });
    d.daemon({ type: "git_loaded", git: { repo: true, files: [] } });
    await m.set(d.state);
    expect(
      m.grid.some(
        (r) => r.includes("fix the retry flags") && r.includes("committed and pushed to origin/dev"),
      ),
    ).toBe(true);
    await m.dispose();
  });
});
