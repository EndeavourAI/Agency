import type { CliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { Runtime } from "../runtime/index.ts";
import { current, othersRunning, runningTurn, showLogo } from "../state/derive.ts";
import type { AppState } from "../state/types.ts";
import { isTruecolor, palette } from "../term/themes.ts";
import { App } from "./app.tsx";

export interface MountOptions {
  version: string;
  reducedMotion: boolean;
  truecolor?: boolean;
}

/** One step of every animation (orbit, beads, logo) per 140 ms; nothing moves with reduced motion. */
const TICK_MS = 140;

/** Something is animating now: the logo on the start screen, a turn that runs here, or another session that runs. */
function animating(s: AppState): boolean {
  if (s.view === "home") return showLogo(s) || s.liveSessions.length > 0;
  const x = current(s);
  return (
    runningTurn(x) !== undefined ||
    othersRunning(s) ||
    (x?.loading ?? false) ||
    (x?.compaction ?? null) !== null
  );
}

export async function mountApp(renderer: CliRenderer, runtime: Runtime, o: MountOptions): Promise<void> {
  await render(() => {
    const [state, setState] = createSignal(runtime.state, { equals: false });
    const [tick, setTick] = createSignal(0);
    const [now, setNow] = createSignal(Date.now());
    const unsubscribe = runtime.subscribe((s) => setState(() => s));
    onCleanup(unsubscribe);
    const live = createMemo(() => !o.reducedMotion && animating(state()));
    const turnRuns = createMemo(
      () => runningTurn(current(state())) !== undefined || (current(state())?.compaction ?? null) !== null,
    );
    createEffect(() => {
      if (!live()) return;
      const t = setInterval(() => setTick((n) => n + 1), TICK_MS);
      onCleanup(() => clearInterval(t));
    });
    // The clock of a running turn moves once a second; the ages in lists once a minute.
    createEffect(() => {
      const every = turnRuns() ? 1000 : 60_000;
      const t = setInterval(() => setNow(Date.now()), every);
      onCleanup(() => clearInterval(t));
    });
    const pal = createMemo(() => palette(state().theme, o.truecolor ?? isTruecolor()));
    createEffect(() => renderer.setBackgroundColor(pal().bg));
    return (
      <App
        state={state}
        palette={pal}
        tick={tick}
        now={now}
        version={o.version}
        onScrollMax={(sessionId, n) => runtime.dispatch([{ type: "scroll_max", sessionId, n }])}
      />
    );
  }, renderer);
}
