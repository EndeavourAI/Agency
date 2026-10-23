/**
 * The running app, without a screen: the state, the key and paste entry points, and the client that talks to the
 * daemon. The terminal and the views plug into it; a test can drive it with bytes alone.
 */
import { randomUUID } from "node:crypto";
import type { DaemonClient } from "@agency/rpc";
import { createTuiClient, type TuiClient, type TuiClientDeps } from "../client/index.ts";
import { dispatchKey, dispatchPaste, dispatchWheel, type Out } from "../controller/index.ts";
import type { InputEvent } from "../input/keys.ts";
import { type AppState, type Event, initialState, noProviders, reduce } from "../state/index.ts";

export interface RuntimeOptions {
  daemon: DaemonClient;
  cols: number;
  rows: number;
  workspace: string;
  host: TuiClientDeps["host"];
  /** Clock, for tests. */
  now?: () => number;
  /** Calls subscribers on the spot instead of once per tick; for tests. */
  sync?: boolean;
}

export interface Runtime {
  readonly state: AppState;
  readonly client: TuiClient;
  dispatch(events: readonly Event[]): void;
  input(event: InputEvent): void;
  resize(cols: number, rows: number): void;
  /** Wire this to `connectToDaemon`'s `onConnection` option. */
  onConnection(online: boolean): void;
  subscribe(fn: (state: AppState) => void): () => void;
  bootstrap(): Promise<void>;
  /** Waits for the effects that keys started. */
  settled(): Promise<void>;
}

const FLASH_MS = 4000;
/** One notification per frame at 60 fps: a streaming turn changes the state far more often than the screen can show. */
const NOTIFY_MS = 16;

export function createRuntime(o: RuntimeOptions): Runtime {
  const now = o.now ?? Date.now;
  let state = initialState({ cols: o.cols, rows: o.rows, workspace: o.workspace });
  const listeners = new Set<(s: AppState) => void>();
  const pending = new Set<Promise<void>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  const notify = (): void => {
    timer = undefined;
    for (const fn of listeners) fn(state);
  };

  const dispatch = (events: readonly Event[]): void => {
    if (!events.length) return;
    const flash = state.flash;
    const before = state;
    for (const e of events) state = reduce(state, e);
    // Nothing changed: no redraw, so a view that reports what it measured does not report again and again.
    if (state === before) return;
    if (state.flash && state.flash !== flash) {
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => dispatch([{ type: "flash_clear" }]), FLASH_MS);
    }
    if (o.sync) notify();
    else if (timer === undefined) timer = setTimeout(notify, NOTIFY_MS);
  };

  const newId = (): string => randomUUID();
  const client = createTuiClient({
    daemon: o.daemon,
    dispatch: (events) => dispatch(events),
    getState: () => state,
    now,
    newId,
    host: o.host,
  });

  const apply = (out: Out): void => {
    dispatch(out.events);
    if (!out.effects.length) return;
    const p = client.run(out.effects).finally(() => pending.delete(p));
    pending.add(p);
  };

  return {
    get state() {
      return state;
    },
    client,
    dispatch,
    input(ev) {
      if (ev.type === "key") apply(dispatchKey(state, ev, { now: now(), newId }));
      else if (ev.type === "paste") apply(dispatchPaste(state, ev.text));
      else if (ev.type === "wheel") apply(dispatchWheel(state, ev.d));
    },
    resize: (cols, rows) => dispatch([{ type: "viewport", cols, rows }]),
    onConnection: (online) => client.onConnection(online),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async bootstrap() {
      await client.bootstrap();
      // No provider has a key: the picker opens by itself with the way to add one.
      if (noProviders(state)) dispatch([{ type: "model_open" }]);
    },
    async settled() {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}
