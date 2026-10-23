/**
 * L1: each board of the design canvas, drawn by the real views into OpenTUI's test renderer at the size of the board
 * (160x40 cells for 1280x800 px, 80x24 for the narrow one). The character grid of every board is a snapshot; the cells that
 * carry meaning (brass for live, the steel band, red for errors) are asserted by colour.
 */
process.env.HOME = "/home/dev";

import { afterEach, describe, expect, test } from "bun:test";
import { HEX } from "../src/term/themes.ts";
import { connected, NOW, SID, session } from "./boards.ts";
import type { Driver } from "./helpers.ts";
import { type Mounted, mount } from "./render.ts";

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const m of mounted.splice(0)) await m.dispose();
});

async function board(d: Driver, o: { tick?: number; now?: number } = {}): Promise<Mounted> {
  const m = await mount(d.state, o);
  mounted.push(m);
  return m;
}

/** Where `text` starts: the first row that holds it, from row `from` on. */
function find(m: Mounted, text: string, from = 0): { x: number; y: number } {
  const y = m.grid.findIndex((r, i) => i >= from && r.includes(text));
  if (y < 0) throw new Error(`"${text}" is not on the screen:\n${m.grid.join("\n")}`);
  const row = m.grid[y] as string;
  // The column in cells, not in UTF-16 units: wide and astral glyphs count as they are drawn.
  return { x: Bun.stringWidth(row.slice(0, row.indexOf(text))), y };
}

const A = HEX.agency;
const snap = (m: Mounted): string => m.grid.join("\n");
const ctrl = { p: "\x10", comma: "\x1b[44;5u", d: "\x04", n: "\x0e" };

describe("home", () => {
  test("logo, wordmark, the box, the hints, the recent list and the footer", async () => {
    const m = await board(connected());
    expect(snap(m)).toMatchSnapshot();
    expect(m.grid[0]).toContain("agency");
    expect(m.grid[0]).toContain("ctrl+p 4 sessions");
    expect(m.grid[0]).toContain("dev");
    expect(m.grid.some((r) => r.includes("agency  v0.1.0 · ~/Agency"))).toBe(true);
    expect(m.grid.some((r) => r.includes("› What should Agency work on? @ for files, / for commands"))).toBe(
      true,
    );
    expect(m.grid.some((r) => r.includes("build · Sonnet 5.5 · high"))).toBe(true);
    const hint = m.grid.find((r) => r.includes("enter start")) as string;
    expect(hint).toContain("ctrl+p commands");
    const rec = find(m, "recent");
    expect(m.grid[rec.y + 1]).toMatch(/✓\s+Retry infra faults\s+now\s+\$1\.75\s+done/);
    expect(m.grid[rec.y + 4]).toMatch(/✗\s+Sample: failed turn\s+3d\s+\$0\.30\s+stopped/);
    expect(m.grid.at(-2)).toContain("daemon ready · 4 sessions · $3.35 this week");
    // The logo is brass; the wordmark is the text colour; the bars sit on the panel colour.
    const logo = find(m, "██");
    expect(m.cell(logo.x, logo.y).fg).toBe(A.brand);
    expect(m.cell(0, 0).bg).toBe(A.panel);
    expect(m.cell(2, 0).fg).toBe(A.brand);
    expect(m.cell(2, 0).bold).toBe(true);
  });

  test("the logo rocks: another tick, another frame", async () => {
    const a = await board(connected(), { tick: 0 });
    const frame0 = snap(a);
    await a.tick(6);
    expect(snap(a)).not.toBe(frame0);
  });

  test("24 rows drop the logo; nothing else moves out of reach", async () => {
    const m = await board(connected({ cols: 80, rows: 24 }));
    expect(m.grid.some((r) => r.includes("█"))).toBe(false);
    expect(m.grid.some((r) => r.includes("recent"))).toBe(true);
    expect(m.grid.some((r) => r.includes("› What should Agency"))).toBe(true);
    expect(snap(m)).toMatchSnapshot();
  });

  test("a running session spins in the list and counts in the orbit", async () => {
    const d = connected();
    d.daemon({ type: "live_turns", sessionIds: ["retry"] });
    const m = await board(d, { tick: 1 });
    const row = find(m, "Retry infra faults");
    expect(m.grid[row.y]).toMatch(/◝\s+Retry infra faults\s+now\s+\$1\.75\s+running/);
    expect(m.cell(row.x - 3, row.y).fg).toBe(A.brand);
    expect(m.cell((m.grid[row.y] as string).indexOf("running"), row.y).fg).toBe(A.brand);
  });
});

describe("empty and offline home", () => {
  test("empty: the guide in words, go to in the top bar", async () => {
    const d = connected();
    d.daemon({ type: "sessions_loaded", rows: [] });
    const m = await board(d);
    expect(snap(m)).toMatchSnapshot();
    expect(m.grid[0]).toContain("ctrl+p go to");
    expect(m.grid.some((r) => r.includes("No sessions yet. Describe a task above and press enter."))).toBe(
      true,
    );
    expect(m.grid.at(-2)?.trim()).toBe("daemon ready");
    expect(m.grid.some((r) => r.includes("recent"))).toBe(false);
  });

  test("offline: no prompt, the way back, the footer in red", async () => {
    const d = connected();
    d.daemon({ type: "conn", status: "offline" });
    const m = await board(d);
    expect(snap(m)).toMatchSnapshot();
    expect(m.grid[0]).toContain("✗ daemon unreachable");
    expect(m.grid[0]).toContain("r retry");
    expect(m.grid.some((r) => r.includes("Waiting for the daemon. Start it with agency daemon start."))).toBe(
      true,
    );
    expect(m.grid.some((r) => r.includes("What should Agency"))).toBe(false);
    expect(m.grid.at(-2)).toContain("✗ daemon unreachable · run agency daemon start");
    const f = find(m, "✗ daemon unreachable · run");
    expect(m.cell(f.x, m.grid.length - 2).fg).toBe(A.del);
    expect(m.cell(find(m, "✗ daemon unreachable").x, 0).fg).toBe(A.del);
  });
});

describe("main: the ledger of a session", () => {
  test("160x40: compaction marker, steel band, steps, answer, closing row, live turn, details, statusLine", async () => {
    const m = await board(session());
    expect(snap(m)).toMatchSnapshot();
    expect(m.grid[0]).toContain("agency  Retry infra faults");
    expect(m.grid[0]).toContain("ctrl+p 3 more");
    expect(m.grid.some((r) => r.includes("compacted · 6 earlier turns summarized · 148K → 31K tokens"))).toBe(
      true,
    );
    const band = find(m, "▌› Make the 54 task runs faster without changing results.");
    expect(m.cell(band.x, band.y).fg).toBe(A.you);
    expect(m.cell(band.x, band.y).bg).toBe(A.youBg);
    expect(m.cell(band.x + 40, band.y).bg).toBe(A.youBg);
    expect(m.cell(band.x + 3, band.y).fg).toBe(A.text);
    for (const step of [
      "read   packages/eval/harbor/run.sh",
      "run    harbor run --help",
      "edit   packages/eval/harbor/run.sh +2 −1",
      "run    dry run with no matching task",
    ])
      expect(m.grid.some((r) => r.includes(step))).toBe(true);
    const edit = find(m, "+2 −1");
    expect(m.cell(edit.x, edit.y).fg).toBe(A.add);
    expect(m.cell(edit.x + 3, edit.y).fg).toBe(A.del);
    expect(
      m.grid.some((r) => r.includes("• AgentSetupTimeoutError is a machine fault too, so it retries")),
    ).toBe(true);
    const code = find(m, "harbor run -r 2 --retry-include");
    expect(m.cell(code.x, code.y).bg).toBe(A.panel);
    const inline = find(m, "AgentSetupTimeoutError");
    expect(m.cell(inline.x, inline.y).bg).toBe(A.element);
    // The closing row of the finished turn: the result on the left, copy, thought, time and rate on the right.
    const done = m.grid.find((r) => r.includes("✓ done")) as string;
    expect(done).toContain("✓ done · 4 steps");
    expect(done).toMatch(/copy · thought 7s · 40s · 86 tok\/s/);
    const d = find(m, "✓ done");
    expect(m.cell(d.x, d.y).fg).toBe(A.add);
    expect(m.cell(d.x, d.y).bold).toBe(true);
    // The live turn: brass beads, the streaming caret, the running clock.
    const live = find(m, "•◦◦ edit packages/eval/harbor/report.py");
    expect(m.cell(live.x, live.y).fg).toBe(A.brand);
    expect(m.grid[live.y]).toContain("reasoning · 1:42");
    expect(m.grid.some((r) => r.includes("Editing report.py now▍"))).toBe(true);
    const liveStep = find(m, "edit   packages/eval/harbor/report.py");
    expect(m.cell(liveStep.x, liveStep.y).fg).toBe(A.brand);
    // The box, the hint row with the statusLine after a bar, only the keys that matter while a turn runs.
    expect(m.grid.some((r) => r.includes("› Message Agency. @ for files, / for commands"))).toBe(true);
    const hint = m.grid.find((r) => r.includes("build · Sonnet 5.5")) as string;
    expect(hint).toContain("build · Sonnet 5.5 · high  │  ci passing · 2 open PRs");
    expect(hint).toContain("esc stop");
    expect(hint).toContain("ctrl+p commands");
    expect(hint).not.toContain("history");
    // The details pane.
    expect(m.grid.some((r) => r.includes("tasks") && r.includes("2 of 4 done"))).toBe(true);
    expect(m.grid.some((r) => r.includes("✓  Rebuild Linux binary"))).toBe(true);
    expect(m.grid.some((r) => r.includes("▸  Count start timeouts"))).toBe(true);
    expect(m.grid.some((r) => r.includes("112K of 200K · compacts at 180K"))).toBe(true);
    expect(m.grid.some((r) => r.includes("run.sh") && r.includes("+2 −1"))).toBe(true);
    expect(m.grid.some((r) => r.includes("cost     $1.75 · 91% cached"))).toBe(true);
    expect(m.grid.some((r) => r.includes("branch   dev"))).toBe(true);
  });

  test("the box lights in the mode colour while it owns the keys, and goes quiet when something else does", async () => {
    const d = session();
    const idle = await board(d);
    const top = find(idle, "┌");
    expect(idle.cell(top.x, top.y).fg).toBe(A.text);
    // Something else owns the keys: the review screen. Its commit box is quiet.
    d.send("\x12");
    const review = await board(d);
    const quiet = find(review, "┌", 30);
    expect(review.cell(quiet.x, quiet.y).fg).toBe(A.dim);
    d.send("\x1b");
    d.send("\t");
    d.send("\t");
    expect(d.state.mode).toBe("auto");
    const m = await board(d);
    const t = find(m, "┌");
    expect(m.cell(t.x, t.y).fg).toBe(A.auto);
    const hint = find(m, "auto · Sonnet 5.5");
    expect(m.cell(hint.x, hint.y).fg).toBe(A.auto);
    d.send("\x1b[Z");
    const plan = await board(d);
    const tp = find(plan, "┌");
    expect(plan.cell(tp.x, tp.y).fg).toBe(A.plan);
  });

  test("focus: details hidden, the column centred at 120 columns, context rides in the hint row", async () => {
    const d = session();
    d.send(ctrl.d);
    const m = await board(d);
    expect(snap(m)).toMatchSnapshot();
    expect(m.grid.some((r) => r.includes("2 of 4 done"))).toBe(false);
    expect(m.grid.some((r) => r.includes("│"))).toBe(true);
    const hint = m.grid.find((r) => r.includes("build · Sonnet 5.5")) as string;
    expect(hint).toContain("56% ctx · 2/4 tasks");
    expect(hint).toContain("high");
    const band = find(m, "▌› Make the 54");
    expect(band.x).toBe(20);
  });

  test("narrow 80x24: no details, no effort, context and tasks in the hint row, no history hint", async () => {
    const m = await board(session({ cols: 80, rows: 24 }));
    expect(snap(m)).toMatchSnapshot();
    expect(m.grid.some((r) => r.includes("2 of 4 done"))).toBe(false);
    const hint = m.grid.find((r) => r.includes("build · Sonnet 5.5")) as string;
    expect(hint).toContain("build · Sonnet 5.5 · 56% ctx · 2/4 tasks");
    expect(hint).not.toContain("high");
    expect(hint).not.toContain("ci passing");
    expect(hint).toContain("esc stop");
    expect(m.grid.length).toBeLessThanOrEqual(25);
    expect(m.grid.some((r) => r.includes("› Message Agency"))).toBe(true);
  });

  test("the transcript is anchored to the bottom and overflows upward", async () => {
    const m = await board(session({ cols: 80, rows: 16 }));
    expect(m.grid.some((r) => r.includes("› Message Agency"))).toBe(true);
    expect(m.grid.some((r) => r.includes("Editing report.py now▍"))).toBe(true);
    expect(m.grid.some((r) => r.includes("▌› Make the 54"))).toBe(false);
  });
});

describe("palette, approval and themes", () => {
  test("palette: sessions first, then commands with their keys", async () => {
    const d = session();
    d.send(ctrl.p);
    d.send("re");
    d.send("\x7f");
    d.send("\x7f");
    const m = await board(d);
    expect(snap(m)).toMatchSnapshot();
    expect(m.grid.some((r) => r.includes("go to") && r.includes("↑↓ enter · esc"))).toBe(true);
    expect(m.grid.some((r) => r.includes("› session or /command"))).toBe(true);
    const sessions = find(m, "sessions");
    expect(m.grid[sessions.y + 1]).toMatch(/●\s+Retry infra faults\s+Agency\s+\$1\.75\s+now/);
    expect(
      m.grid.some(
        (r) => r.includes("/review") && r.includes("Review and commit changes") && r.includes("ctrl+r"),
      ),
    ).toBe(true);
    expect(m.grid.some((r) => r.includes("/settings") && r.includes("ctrl+,"))).toBe(true);
    // The selected row sits on the quiet fill, and the dialog on the panel.
    const first = find(m, "●  Retry infra faults");
    const sel = m.cell(first.x + 40, first.y);
    expect(sel.bg).toBe(A.element);
    const cmd = find(m, "/model");
    expect(m.cell(cmd.x, cmd.y).bg).toBe(A.panel);
    // What the dialog covers is dimmed by the scrim, text and fill alike; the dialog itself is not.
    const under = find(m, "▌› Make the 54");
    expect(m.cell(under.x, under.y).fg).not.toBe(A.you);
  });

  test("palette: the query filters both lists", async () => {
    const d = session();
    d.send(ctrl.p);
    d.send("rev");
    const m = await board(d);
    expect(m.grid.some((r) => r.includes("› rev"))).toBe(true);
    expect(m.grid.some((r) => r.includes("No session matches."))).toBe(true);
    expect(m.grid.some((r) => r.includes("/review"))).toBe(true);
    expect(m.grid.some((r) => r.includes("/model"))).toBe(false);
  });

  test("approval: the ask takes over the prompt; brass for the one primary action", async () => {
    const d = session();
    d.daemon({
      type: "turn_event",
      sessionId: SID,
      turnId: "t2",
      at: NOW,
      event: {
        type: "approval_requested",
        requestId: "r1",
        sessionId: SID,
        turnId: "t2",
        riskTier: "dangerous",
        source: "tier",
        argsSummary: "command=bash scripts/dry-run.sh",
        request: { tool: "bash", title: "bash scripts/dry-run.sh", command: "bash scripts/dry-run.sh" },
      },
    });
    const m = await board(d);
    expect(snap(m)).toMatchSnapshot();
    expect(m.grid.some((r) => r.includes("? Run  bash scripts/dry-run.sh   no rule allows it yet"))).toBe(
      true,
    );
    expect(
      m.grid.some(
        (r) => r.includes("y allow once") && r.includes("a always for this command") && r.includes("n deny"),
      ),
    ).toBe(true);
    expect(m.grid.some((r) => r.includes("Answer the request above: y, a or n."))).toBe(true);
    expect(m.grid.some((r) => r.includes("› Message Agency"))).toBe(false);
    const y = find(m, "y allow once");
    expect(m.cell(y.x, y.y).bg).toBe(A.brand);
    expect(m.cell(y.x, y.y).fg).toBe(A.bg);
    const a = find(m, "a always for this command");
    expect(m.cell(a.x, a.y).bg).toBe(A.element);
    const q = find(m, "? Run");
    expect(m.cell(q.x, q.y).fg).toBe(A.auto);
    expect(m.cell(q.x, q.y).bold).toBe(true);
    // The hint row still offers stop and commands.
    expect(m.grid.find((r) => r.includes("build · Sonnet 5.5"))).toContain("esc stop");
  });

  test.each([
    ["night", "#1a1b26", "#e0af68", "#2a3354"],
    ["light", "#faf8f3", "#855a0d", "#dde6f2"],
  ] as const)("%s: every colour of the canvas theme", async (theme, bg, brand, youBg) => {
    const m = await board(session({ theme }));
    expect(snap(m)).toMatchSnapshot();
    expect(m.cell(0, 5).bg).toBe(bg);
    expect(m.cell(2, 0).fg).toBe(brand);
    const band = find(m, "▌› Make the 54");
    expect(m.cell(band.x, band.y).bg).toBe(youBg);
    expect(m.cell(band.x, band.y).fg).toBe(HEX[theme].you);
    const live = find(m, "•◦◦");
    expect(m.cell(live.x, live.y).fg).toBe(brand);
  });

  test("the 256-colour fallback keeps every cell in the palette", async () => {
    const m = await mount(session().state, { truecolor: false });
    mounted.push(m);
    const band = find(m, "▌› Make the 54");
    // The band is the nearest cube colour of #1f2839, not the exact truecolor value.
    expect(m.cell(band.x, band.y).bg).not.toBe("#1f2839");
    expect(m.cell(band.x, band.y).bg).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("offline in a session", () => {
  test("the turn reads paused throughout; the box says why; messages wait", async () => {
    const d = session();
    d.daemon({ type: "conn", status: "offline" });
    const m = await board(d);
    expect(snap(m)).toMatchSnapshot();
    expect(m.grid[0]).toContain("✗ daemon unreachable");
    expect(m.grid.some((r) => r.includes("· paused · waiting for the daemon"))).toBe(true);
    expect(m.grid.some((r) => r.includes("reasoning (paused)"))).toBe(true);
    expect(m.grid.some((r) => r.includes("Waiting for the daemon. Messages send when it is back."))).toBe(
      true,
    );
    expect(m.grid.some((r) => r.includes("Editing report.py now▍"))).toBe(false);
    const step = find(m, "edit   packages/eval/harbor/report.py");
    expect(m.cell(step.x, step.y).fg).not.toBe(A.brand);
  });
});

describe("pickers", () => {
  test("model picker: recent and by provider, the context window and the prices from the catalog, the effort row", async () => {
    const d = session();
    d.daemon({ type: "model_applied", sessionId: null, ref: "anthropic/haiku" });
    d.daemon({ type: "model_applied", sessionId: null, ref: "anthropic/sonnet" });
    d.daemon({ type: "model_open" });
    const m = await board(d);
    expect(snap(m)).toMatchSnapshot();
    expect(m.grid.some((r) => r.includes("model") && r.includes("esc"))).toBe(true);
    expect(m.grid.some((r) => r.includes("/ search"))).toBe(true);
    expect(m.grid.some((r) => r.includes("ctx") && r.includes("in /MTok") && r.includes("out /MTok"))).toBe(
      true,
    );
    const recent = find(m, "recent");
    expect(m.grid[recent.y + 1]).toMatch(/●\s+Sonnet 5\.5\s+1M\s+\$2\.00\s+\$10\.00/);
    expect(m.grid[recent.y + 2]).toMatch(/Haiku 5\.5\s+200K\s+\$0\.10\s+\$0\.50/);
    expect(m.grid.some((r) => r.trim() === "openrouter" || r.includes("  openrouter"))).toBe(true);
    expect(m.grid.some((r) => /Laguna S 2\.1\s+128K\s+\$0\.00\s+\$0\.00/.test(r))).toBe(true);
    const eff = m.grid.find((r) => r.includes("effort")) as string;
    expect(eff).toMatch(/low\s+medium\s+high\s+xhigh/);
    const high = find(m, " high ");
    expect(m.cell(high.x + 1, high.y).bg).toBe(A.element);
    // The picked row is on the quiet fill.
    const row = find(m, "Sonnet 5.5");
    expect(m.cell(row.x + 20, row.y).bg).toBe(A.element);
  });

  test("model picker: the effort row lists the levels of the model under the cursor", async () => {
    const d = session();
    d.daemon({ type: "model_open" });
    const effort = async (): Promise<string> =>
      (await board(d)).grid.find((r) => r.includes("effort")) as string;
    d.type("gpt");
    expect(await effort()).toMatch(/effort\s+low\s+medium\s+high(?!\s+xhigh)/);
    d.apply([{ type: "model_query", q: "laguna" }]);
    const none = await effort();
    expect(none).toContain("no reasoning control");
    expect(none).not.toContain("medium");
  });

  test("model picker: arrows and the effort row work from the keyboard", async () => {
    const d = session();
    d.daemon({ type: "model_open" });
    d.send("\x1b[B");
    d.send("\x1b[C");
    expect(d.state.effort).toBe("xhigh");
    const m = await board(d);
    expect(m.grid.find((r) => r.includes("effort"))).toBeDefined();
    const x = find(m, " xhigh ");
    expect(m.cell(x.x + 1, x.y).bg).toBe(A.element);
    d.send("\r");
    expect(d.state.model.open).toBe(false);
  });

  test("no keys: the picker opens with the way to add one, no table", async () => {
    const d = connected();
    d.daemon({ type: "models_loaded", models: [], connected: [], defaultModel: null });
    d.daemon({ type: "model_open" });
    const m = await board(d);
    expect(snap(m)).toMatchSnapshot();
    expect(m.grid.some((r) => r.includes("No provider has a key yet."))).toBe(true);
    expect(m.grid.some((r) => r.includes("this list again."))).toBe(true);
    expect(m.grid.some((r) => r.includes("in /MTok"))).toBe(false);
    expect(m.grid.some((r) => r.includes("No model matches."))).toBe(false);
    const cmd = find(m, "agency auth login <provider>");
    expect(m.cell(cmd.x, cmd.y).fg).toBe(A.text);
  });
});

describe("completion in the box", () => {
  test("@ lists files: name first, directory dimmed, the pick on a quiet fill, the box joined below", async () => {
    const d = session();
    d.send("fix @rep");
    const m = await board(d);
    expect(snap(m)).toMatchSnapshot();
    const rowY = m.grid.findIndex((r) => r.includes("│ report.py ") && r.includes("packages/eval/harbor"));
    const item = {
      x: Bun.stringWidth((m.grid[rowY] as string).slice(0, (m.grid[rowY] as string).indexOf("report.py"))),
      y: rowY,
    };
    expect(rowY).toBeGreaterThan(30);
    expect(m.cell(item.x, item.y).bg).toBe(A.element);
    expect(m.cell(item.x, item.y).bold).toBe(true);
    const dir = {
      x: Bun.stringWidth(
        (m.grid[rowY] as string).slice(0, (m.grid[rowY] as string).indexOf("packages/eval/harbor")),
      ),
      y: rowY,
    };
    expect(m.cell(dir.x, dir.y).fg).toBe(A.muted);
    expect(m.grid.some((r) => r.includes("├") && r.includes("┤"))).toBe(true);
    expect(m.grid.some((r) => r.includes("› fix @rep"))).toBe(true);
  });

  test("a draft with no match says so", async () => {
    const d = session();
    d.send("@zzz");
    const m = await board(d);
    expect(m.grid.some((r) => r.includes("No file matches."))).toBe(true);
  });

  test("/ lists commands and skills, prefix first, with their kind on the right", async () => {
    const d = session();
    d.send("/e");
    const m = await board(d);
    expect(snap(m)).toMatchSnapshot();
    expect(m.grid.some((r) => /\/eval\s+Run the harbor eval on one task\s+command/.test(r))).toBe(true);
    const eval1 = find(m, "/eval");
    expect(m.grid[eval1.y - 1]).toBeDefined();
    // `/e` finds names that start with e before those that contain it.
    expect(m.grid.findIndex((r) => r.includes("/eval"))).toBeLessThan(
      m.grid.findIndex((r) => r.includes("/review")),
    );
  });
});

describe("settings", () => {
  test("sections on the left, the rows of one on the right, the keys at the bottom", async () => {
    const d = connected();
    d.send(ctrl.comma);
    const m = await board(d);
    expect(snap(m)).toMatchSnapshot();
    expect(m.grid[0]).toContain("agency  settings");
    for (const name of [
      "General",
      "Models",
      "Permissions",
      "Environments",
      "Context",
      "Tools and MCP",
      "Hooks",
      "Agents and budgets",
    ])
      expect(m.grid.some((r) => r.includes(name))).toBe(true);
    expect(m.grid.some((r) => /Theme\s+agency/.test(r))).toBe(true);
    expect(m.grid.some((r) => /Usage metrics\s+off\s+Nothing is sent while off\./.test(r))).toBe(true);
    const general = find(m, "General");
    expect(m.cell(general.x, general.y).bg).toBe(A.element);
    expect(m.cell(general.x, general.y).bold).toBe(true);
    expect(m.grid.at(-1) ?? "").toBeDefined();
    const keys = m.grid.find((r) => r.includes("space change")) as string;
    expect(keys).toContain("↑↓ move");
    expect(keys).toContain("→ open");
    expect(keys).toContain("esc back");
  });

  test("the Models section says where each key comes from", async () => {
    const d = connected();
    d.send(ctrl.comma);
    d.send("\x1b[B");
    const m = await board(d);
    expect(m.grid.some((r) => /Anthropic\s+key set\s+from the keychain/.test(r))).toBe(true);
    expect(m.grid.some((r) => /OpenAI\s+key set\s+from OPENAI_API_KEY/.test(r))).toBe(true);
    expect(m.grid.some((r) => /Google\s+key set\s+from your login/.test(r))).toBe(true);
    expect(snap(m)).toMatchSnapshot();
  });

  const userConfig = {
    permissions: { bash: { "git push *": "ask", "rm -rf *": "deny" }, edit: "allow" },
    mcpServers: { context7: { command: "npx" }, github: { url: "https://x.test/mcp", enabled: false } },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./scripts/guard.sh" }] }] },
    statusLine: { command: "./scripts/status.sh" },
  };
  const down = (d: Driver, n: number): void => {
    for (let i = 0; i < n; i++) d.send("\x1b[B");
  };

  test("permission rules, MCP servers and hooks of the user config, and the empty states without them", async () => {
    const d = connected();
    d.daemon({ type: "config_loaded", config: userConfig });
    d.send(ctrl.comma);
    down(d, 2);
    const perms = await board(d);
    expect(perms.grid.some((r) => /Bash git push \*\s+ask/.test(r))).toBe(true);
    expect(perms.grid.some((r) => /Edit\s+allow/.test(r))).toBe(true);
    expect(snap(perms)).toMatchSnapshot();
    down(d, 3);
    const mcp = await board(d);
    expect(mcp.grid.some((r) => /context7\s+on\s+stdio/.test(r))).toBe(true);
    expect(mcp.grid.some((r) => /github\s+off\s+http/.test(r))).toBe(true);
    expect(snap(mcp)).toMatchSnapshot();
    down(d, 1);
    const hooks = await board(d);
    expect(hooks.grid.some((r) => /PreToolUse Bash\s+\.\/scripts\/guard\.sh/.test(r))).toBe(true);
    expect(hooks.grid.some((r) => /Status line\s+\.\/scripts\/status\.sh/.test(r))).toBe(true);

    const bare = connected();
    bare.send(ctrl.comma);
    down(bare, 2);
    expect((await board(bare)).grid.some((r) => r.includes("No rules in your user config"))).toBe(true);
    down(bare, 3);
    expect((await board(bare)).grid.some((r) => r.includes("No MCP servers in your user config"))).toBe(true);
    down(bare, 1);
    expect((await board(bare)).grid.some((r) => r.includes("No hooks in your user config"))).toBe(true);
  });

  test("a row is picked with the arrows; space changes it and the theme applies at once", async () => {
    const d = connected();
    d.send(ctrl.comma);
    d.send("\x1b[C");
    expect(d.state.settings.row).toBe(0);
    d.send(" ");
    expect(d.state.theme).toBe("night");
    expect(d.last("config_write")).toMatchObject({ key: "theme", value: "night" });
    const m = await board(d);
    expect(m.cell(0, 5).bg).toBe(HEX.night.bg);
    const row = find(m, "Theme");
    expect(m.cell(row.x + 3, row.y).bg).toBe(HEX.night.element);
    expect(m.grid.some((r) => /Theme\s+night/.test(r))).toBe(true);
  });

  test("a text row is typed in place and written on enter", async () => {
    const d = connected();
    d.send(ctrl.comma);
    for (let i = 0; i < 7; i++) d.send("\x1b[B");
    d.send("\x1b[C");
    expect(d.state.settings.sec).toBe(7);
    d.send("\r");
    expect(d.state.settings.edit).toBe("");
    d.send("$20");
    const typing = await board(d);
    expect(typing.grid.some((r) => /Daily cap \(USD\)\s+\$20/.test(r))).toBe(true);
    expect(typing.grid.some((r) => r.includes("enter save") && r.includes("esc cancel"))).toBe(true);
    d.send("\r");
    expect(d.last("config_write")).toMatchObject({ key: "budgets.dailyUsd", value: 20 });
    expect(d.state.settings.edit).toBeNull();
    const m = await board(d);
    expect(m.grid.some((r) => /Daily cap \(USD\)\s+\$20/.test(r))).toBe(true);
  });

  test("a value that is not a number is not written", async () => {
    const d = connected();
    d.send(ctrl.comma);
    for (let i = 0; i < 7; i++) d.send("\x1b[B");
    d.send("\x1b[C");
    d.send("\r");
    d.send("lots");
    d.send("\r");
    expect(d.last("config_write")).toBeUndefined();
    expect(d.state.flash?.text).toContain("not an amount");
  });

  test("providers that have a key are listed under Models", async () => {
    const d = connected();
    d.send(ctrl.comma);
    d.send("\x1b[B");
    const m = await board(d);
    expect(m.grid.some((r) => /Anthropic\s+key set/.test(r))).toBe(true);
    expect(m.grid.some((r) => /OpenAI\s+key set/.test(r))).toBe(true);
  });
});

describe("outputs, shell and queue, paste and scroll", () => {
  test("outputs opened: an edit shows its diff, a read its first lines, with the pick on the closing row", async () => {
    const d = session({}, false);
    d.daemon({ type: "turn_stopped", sessionId: SID, turnId: "t2", at: NOW });
    d.daemon({ type: "turn_finished", sessionId: SID, turnId: "t2", at: NOW, outcome: { cancelled: true } });
    d.send("\x1b");
    d.send("\x1b");
    const s = d.state.bySession[SID];
    expect(s?.pickAt).not.toBeNull();
    d.daemon({ type: "pick_move", d: -1 });
    d.send("\r");
    const m = await board(d);
    expect(snap(m)).toMatchSnapshot();
    expect(m.grid.some((r) => r.includes("#!/usr/bin/env bash"))).toBe(true);
    expect(m.grid.some((r) => r.includes("  -n, --n-concurrent INTEGER   Trials to run at once"))).toBe(true);
    expect(m.grid.some((r) => r.includes("… 1 more lines"))).toBe(true);
    const add = find(m, "+ ");
    expect(m.cell(add.x + 2, add.y).bg).toBe(A.addBg);
    const del = m.grid.findIndex((r) => r.includes("− "));
    expect(del).toBeGreaterThan(-1);
    expect(m.cell((m.grid[del] as string).indexOf("− ") + 2, del).bg).toBe(A.delBg);
    const hint = m.grid.find((r) => r.includes("↑↓ turn")) as string;
    expect(hint).toContain("enter output");
    expect(hint).toContain("c copy");
    expect(hint).toContain("t thinking");
    expect(hint).toContain("esc back");
    const picked = find(m, "✓ done · 4 steps");
    expect(m.cell(picked.x, picked.y).bg).toBe(A.element);
  });

  test("copy and thinking: c says copied, t opens the reasoning in italics", async () => {
    const d = session({}, false);
    d.daemon({
      type: "turn_finished",
      sessionId: SID,
      turnId: "t2",
      at: NOW,
      outcome: { stopReason: "end_turn" },
    });
    d.send("\x1b");
    d.send("\x1b");
    d.daemon({ type: "pick_move", d: -1 });
    d.send("c");
    d.send("t");
    const m = await board(d);
    expect(m.grid.some((r) => r.includes("✓ copied"))).toBe(true);
    expect(m.grid.some((r) => r.includes("hide thought"))).toBe(true);
    const th = find(m, "Read the run script first");
    expect(m.cell(th.x, th.y).fg).toBe(A.muted);
  });

  test("shell and queue: a ! block with its output below the stopped turn, a dashed queued row, the shell prompt", async () => {
    const d = session({}, false);
    d.daemon({ type: "turn_stopped", sessionId: SID, turnId: "t2", at: NOW });
    d.daemon({ type: "turn_finished", sessionId: SID, turnId: "t2", at: NOW, outcome: { cancelled: true } });
    d.daemon({ type: "shell_started", sessionId: SID, id: "s1", cmd: "git status" });
    d.daemon({
      type: "shell_finished",
      sessionId: SID,
      id: "s1",
      output:
        "On branch dev\nYour branch is up to date with 'origin/dev'.\n\nChanges not staged for commit:\n        modified:   packages/eval/harbor/report.py\n",
      isError: false,
    });
    d.daemon({
      type: "prompt_queued",
      sessionId: SID,
      item: { id: "q1", kind: "prompt", text: "also check the 529 path", images: [] },
    });
    d.send("!");
    d.send("git log --oneline -3");
    const m = await board(d);
    expect(snap(m)).toMatchSnapshot();
    const sh = find(m, "▌! git status");
    expect(m.cell(sh.x, sh.y).bg).toBe(A.youBg);
    expect(m.cell(sh.x, sh.y).fg).toBe(A.you);
    expect(m.grid.some((r) => r.includes("On branch dev"))).toBe(true);
    expect(m.grid.some((r) => r.includes("done · sent to the agent as data"))).toBe(true);
    const q = m.grid.find((r) => r.includes("› also check the 529 path")) as string;
    expect(q).toContain("turn stopped · enter sends it");
    expect(q.trimStart().startsWith("┆")).toBe(true);
    expect(m.grid.some((r) => r.includes("│ ! git log --oneline -3"))).toBe(true);
    const box = find(m, "┌");
    expect(m.cell(box.x, box.y).fg).toBe(A.you);
    const hint = m.grid.find((r) => r.includes("shell · runs in")) as string;
    expect(hint).toContain("shell · runs in ~/Agency · the output goes to the agent as data");
    const label = find(m, "shell · runs");
    expect(m.cell(label.x, label.y).fg).toBe(A.you);
  });

  test("paste and scroll: an image chip over the box, and the marker that says how far below the end the view is", async () => {
    const d = session({ rows: 24 }, false);
    d.daemon({
      type: "turn_finished",
      sessionId: SID,
      turnId: "t2",
      at: NOW,
      outcome: { stopReason: "end_turn" },
    });
    d.daemon({
      type: "image_added",
      chip: { name: "image 1", size: 188_000, mimeType: "image/png", data: "" },
    });
    d.send("the grid breaks at this width");
    d.send("\x1b[5~");
    const m = await board(d);
    expect(snap(m)).toMatchSnapshot();
    expect(m.grid.some((r) => /↓ \d+ newer rows below · ctrl\+end latest/.test(r))).toBe(true);
    expect(m.grid.some((r) => r.includes("▣ image 1 · 184 KB ×") && r.includes("backspace removes"))).toBe(
      true,
    );
    expect(m.grid.some((r) => r.includes("› the grid breaks at this width"))).toBe(true);
    expect(m.grid.some((r) => r.includes("Also count environment start timeouts"))).toBe(false);
    const hint = m.grid.find((r) => r.includes("pgdn newer")) as string;
    expect(hint).toContain("ctrl+end latest");
    d.send("\x1b[1;5F");
    const back = await board(d);
    expect(back.grid.some((r) => r.includes("newer row"))).toBe(false);
    expect(back.grid.some((r) => r.includes("Also count environment start timeouts"))).toBe(true);
  });

  test("a failed turn says stopped once, with the error band and enter to retry", async () => {
    const d = connected();
    d.daemon({ type: "session_opened", sessionId: "path", title: "Sample: failed turn" });
    d.daemon({
      type: "turn_started",
      sessionId: "path",
      turnId: "e1",
      prompt: "Pathfinding stalls near chunk borders.",
      images: [],
      at: NOW - 5000,
    });
    d.daemon({
      type: "turn_event",
      sessionId: "path",
      turnId: "e1",
      at: NOW,
      event: {
        type: "error",
        code: "overloaded",
        message: "The provider is overloaded (HTTP 529). Nothing was lost.",
      },
    });
    d.daemon({ type: "turn_finished", sessionId: "path", turnId: "e1", at: NOW, outcome: {} });
    const m = await board(d);
    expect(snap(m)).toMatchSnapshot();
    expect(
      m.grid.some(
        (r) =>
          r.includes("The provider is overloaded (HTTP 529). Nothing was lost.") && r.includes("enter retry"),
      ),
    ).toBe(true);
    const err = find(m, "The provider is overloaded");
    expect(m.cell(err.x, err.y).bg).toBe(A.delBg);
    const stamp = find(m, "✗ stopped");
    expect(m.cell(stamp.x, stamp.y).fg).toBe(A.del);
    expect(m.grid.filter((r) => r.includes("stopped")).length).toBe(1);
  });
});

describe("review", () => {
  const DIFF = [
    "diff --git a/packages/eval/harbor/run.sh b/packages/eval/harbor/run.sh",
    "index 1111111..2222222 100644",
    "--- a/packages/eval/harbor/run.sh",
    "+++ b/packages/eval/harbor/run.sh",
    "@@ -14,5 +14,6 @@",
    ' harbor run "${source[@]}" "${include[@]}" \\',
    '   -a "${AGENT:-agency_agent:Agency}" -m "${MODEL}" \\',
    '-  --agent-setup-timeout-multiplier 4 --job-name "$JOB" -o "$jobs" -y',
    '+  --agent-setup-timeout-multiplier 4 --job-name "$JOB" -o "$jobs" -y \\',
    "+  -r 2 --retry-include RuntimeError",
    ' python3 "$here/report.py" "$jobs/$JOB"',
    "diff --git a/packages/eval/harbor/report.py b/packages/eval/harbor/report.py",
    "--- a/packages/eval/harbor/report.py",
    "+++ b/packages/eval/harbor/report.py",
    "@@ -8,7 +8,7 @@",
    " # run.sh retries these same types; keep the two lists equal.",
    '-INFRA = ("RuntimeError", "NetworkConnectionError")',
    '+INFRA = ("RuntimeError", "NetworkConnectionError", "EnvironmentStartTimeoutError")',
    "",
  ].join("\n");

  test("the changed files on the left, the diff of one on the right, the commit box below", async () => {
    const d = session();
    d.daemon({
      type: "git_loaded",
      git: {
        repo: true,
        branch: "dev",
        files: [
          { path: "packages/eval/harbor/run.sh", status: "M", added: 2, deleted: 1 },
          { path: "packages/eval/harbor/report.py", status: "M", added: 1, deleted: 1 },
        ],
      },
      diff: { diff: DIFF, untracked: [] },
    });
    d.send("\x12");
    expect(d.state.review.open).toBe(true);
    expect(d.last("load_review")).toBeDefined();
    const m = await board(d);
    expect(snap(m)).toMatchSnapshot();
    expect(
      m.grid.some((r) => r.includes("review") && r.includes("2 files · +3 −2") && r.includes("esc back")),
    ).toBe(true);
    expect(m.grid.some((r) => r.includes("› run.sh") && r.includes("+2 −1"))).toBe(true);
    expect(m.grid.some((r) => r.includes("  report.py") && r.includes("+1 −1"))).toBe(true);
    expect(m.grid.some((r) => r.includes("packages/eval/harbor/run.sh"))).toBe(true);
    const add = find(m, "+ ", 3);
    expect(m.cell(add.x + 4, add.y).bg).toBe(A.addBg);
    const del = find(m, "− ", 3);
    expect(m.cell(del.x + 4, del.y).bg).toBe(A.delBg);
    expect(
      m.grid.some(
        (r) =>
          r.includes("✓ 2 files changed") &&
          r.includes("enter commit") &&
          r.includes("ctrl+enter commit and push"),
      ),
    ).toBe(true);
    const commit = find(m, "enter commit");
    expect(m.cell(commit.x + 2, commit.y).bg).toBe(A.brand);
    // Down picks the next file; esc closes.
    d.send("\x1b[B");
    expect(d.state.review.file).toBe(1);
    const next = await board(d);
    expect(next.grid.some((r) => r.includes("› report.py"))).toBe(true);
    expect(next.grid.some((r) => r.includes("INFRA = ("))).toBe(true);
    d.send("\x1b");
    expect(d.state.review.open).toBe(false);
  });

  test("with nothing changed it says so", async () => {
    const d = session();
    d.daemon({
      type: "git_loaded",
      git: { repo: true, branch: "dev", files: [] },
      diff: { diff: "", untracked: [] },
    });
    d.send("\x12");
    const m = await board(d);
    expect(m.grid.some((r) => r.includes("No changes yet."))).toBe(true);
    expect(m.grid.some((r) => r.includes("✓ Nothing to commit"))).toBe(true);
  });

  test("an untracked file shows as all added", async () => {
    const d = session();
    d.daemon({
      type: "git_loaded",
      git: {
        repo: true,
        branch: "dev",
        files: [{ path: "notes.txt", status: "?", added: null, deleted: null }],
      },
      diff: { diff: "", untracked: [{ path: "notes.txt", text: "one\ntwo\n" }] },
    });
    d.send("\x12");
    const m = await board(d);
    expect(m.grid.some((r) => r.includes("› notes.txt") && r.includes("+2"))).toBe(true);
    expect(m.grid.some((r) => r.includes("+ one"))).toBe(true);
    expect(m.grid.some((r) => r.includes("+ two"))).toBe(true);
  });
});

describe("small checks of the canvas smoke", () => {
  test("an orbit marks a session that runs elsewhere, and only then", async () => {
    const d = session();
    const quiet = await board(d);
    expect(quiet.grid[0]).not.toMatch(/[◜◝◞◟] ctrl\+p/);
    d.daemon({ type: "live_turns", sessionIds: [SID, "tui"] });
    const m = await board(d, { tick: 2 });
    expect(m.grid[0]).toContain("◞ ctrl+p 3 more");
    const mark = find(m, "◞");
    expect(m.cell(mark.x, mark.y).fg).toBe(A.brand);
    await m.tick(3);
    expect(m.grid[0]).toContain("◟ ctrl+p 3 more");
  });

  test("the live turn names what it does once: reasoning and the clock, no esc in the stamp", async () => {
    const m = await board(session());
    const row = m.grid.find((r) => r.includes("•◦◦")) as string;
    expect(row).toContain("reasoning · 1:42");
    expect(row).not.toContain("esc");
  });

  test("subagent work opens to its workers", async () => {
    const d = session({}, false);
    d.daemon({
      type: "turn_finished",
      sessionId: SID,
      turnId: "t2",
      at: NOW,
      outcome: { stopReason: "end_turn" },
    });
    d.daemon({
      type: "turn_started",
      sessionId: SID,
      turnId: "t3",
      prompt: "Tune the stop gates.",
      images: [],
      at: NOW,
    });
    d.daemon({
      type: "turn_event",
      sessionId: SID,
      turnId: "t3",
      at: NOW,
      event: {
        type: "tool_start",
        id: "a1",
        name: "delegate",
        input: { task: "replay 2,148 real turns in 4 workers" },
      },
    });
    d.daemon({
      type: "turn_event",
      sessionId: SID,
      turnId: "t3",
      at: NOW,
      event: {
        type: "tool_result",
        id: "a1",
        content:
          "worker 1 · 537 turns · done · 1:58\nworker 2 · 537 turns · done · 2:04\nworker 3 · 537 turns · done · 1:51\nworker 4 · 537 turns · done · 2:10",
        isError: false,
      },
    });
    d.daemon({
      type: "turn_finished",
      sessionId: SID,
      turnId: "t3",
      at: NOW,
      outcome: { stopReason: "end_turn" },
    });
    d.send("\x1b");
    d.send("\x1b");
    d.send("\r");
    const m = await board(d);
    expect(m.grid.some((r) => /agent\s+replay 2,148 real turns in 4 workers/.test(r))).toBe(true);
    expect(m.grid.filter((r) => /worker \d · 537 turns · done/.test(r))).toHaveLength(4);
  });

  test("a text paste passes through: it lands in the box as typed", async () => {
    const d = session();
    d.send("\x1b[200~line one\nline two\x1b[201~");
    const m = await board(d);
    expect(m.grid.some((r) => r.includes("› line one"))).toBe(true);
    expect(m.grid.some((r) => r.includes("│   line two"))).toBe(true);
  });
});
