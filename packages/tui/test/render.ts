import "../src/term/register.ts";
import type { CapturedLine, RGBA } from "@opentui/core";
import { type AppState, reduce } from "../src/state/index.ts";
import { palette } from "../src/term/themes.ts";
import { NOW } from "./boards.ts";

export interface Mounted {
  /** The character grid, one string per row, trailing spaces cut. */
  grid: string[];
  frame: string;
  /** Colours of the cell at (x, y). */
  cell(x: number, y: number): { ch: string; fg: string; bg: string; bold: boolean };
  set(state: AppState): Promise<void>;
  tick(n: number): Promise<void>;
  dispose(): Promise<void>;
}

const hex = (c: RGBA): string =>
  `#${c
    .toInts()
    .slice(0, 3)
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;

/** Draws the app into OpenTUI's test renderer at the size of `state`. */
export async function mount(
  state: AppState,
  o: { tick?: number; now?: number; truecolor?: boolean } = {},
): Promise<Mounted> {
  const { testRender } = await import("@opentui/solid");
  const { createMemo, createSignal } = await import("solid-js");
  const { App } = await import("../src/view/app.tsx");
  const [st, setSt] = createSignal(state);
  const [tick, setTick] = createSignal(o.tick ?? 0);

  const t = await testRender(
    () => {
      const pal = createMemo(() => palette(st().theme, o.truecolor ?? true));
      return App({
        state: st,
        palette: pal,
        tick,
        now: () => o.now ?? NOW,
        version: "0.1.0",
        // As the runtime does: the measured end of the scroll goes back into the state.
        onScrollMax: (sessionId, n) => setSt((s) => reduce(s, { type: "scroll_max", sessionId, n })),
      });
    },
    { width: state.cols, height: state.rows },
  );
  const draw = async () => {
    await t.renderOnce();
    await t.renderOnce();
  };
  await draw();
  const self: Mounted = {
    get grid() {
      return t
        .captureCharFrame()
        .split("\n")
        .map((l) => l.trimEnd());
    },
    get frame() {
      return t.captureCharFrame();
    },
    cell(x, y) {
      const line: CapturedLine | undefined = t.captureSpans().lines[y];
      let at = 0;
      for (const s of line?.spans ?? []) {
        if (x < at + s.width) {
          return {
            ch: [...s.text][x - at] ?? " ",
            fg: hex(s.fg),
            bg: hex(s.bg),
            bold: (s.attributes & 1) !== 0,
          };
        }
        at += s.width;
      }
      return { ch: " ", fg: "#000000", bg: "#000000", bold: false };
    },
    async set(next) {
      setSt(() => next);
      await draw();
    },
    async tick(n) {
      setTick(n);
      await draw();
    },
    dispose: () => t.dispose(),
  };
  return self;
}
