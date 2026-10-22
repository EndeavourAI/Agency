import { dispatchKey, dispatchPaste, drainQueue, type Effect, type Out } from "../src/controller/index.ts";
import { InputDecoder } from "../src/input/keys.ts";
import { type AppState, type Event, initialState, reduce } from "../src/state/index.ts";

/** A keyboard-driven session of the pure core: bytes in, state and effects out. */
export class Driver {
  state: AppState;
  effects: Effect[] = [];
  now = 1_000_000;
  private n = 0;
  private readonly decoder = new InputDecoder();

  constructor(init: Partial<AppState> = {}) {
    this.state = { ...initialState({ cols: 120, rows: 40 }), ...init };
  }

  newId = (): string => `id${++this.n}`;

  apply(events: readonly Event[]): void {
    for (const e of events) this.state = reduce(this.state, e);
  }

  private run(out: Out): void {
    this.apply(out.events);
    this.effects.push(...out.effects);
  }

  /** Feeds raw terminal bytes, as the terminal sends them. */
  send(bytes: string): void {
    const events = [...this.decoder.push(bytes), ...this.decoder.flush()];
    for (const ev of events) {
      if (ev.type === "key") this.run(dispatchKey(this.state, ev, { now: this.now, newId: this.newId }));
      else if (ev.type === "paste") this.run(dispatchPaste(this.state, ev.text));
    }
  }

  type(text: string): void {
    this.send(text);
  }

  /** Daemon events, as the client layer delivers them. */
  daemon(...events: Event[]): void {
    this.apply(events);
  }

  drain(): void {
    this.run(drainQueue(this.state, { now: this.now, newId: this.newId }));
  }

  last<T extends Effect["type"]>(type: T): Extract<Effect, { type: T }> | undefined {
    return this.effects.findLast((e): e is Extract<Effect, { type: T }> => e.type === type);
  }
}

export const KEY = {
  enter: "\r",
  tab: "\t",
  shiftTab: "\x1b[Z",
  esc: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  pgup: "\x1b[5~",
  pgdn: "\x1b[6~",
  ctrlEnd: "\x1b[1;5F",
  ctrlComma: "\x1b[44;5u",
  ctrlEnterKitty: "\x1b[13;5u",
  ctrlJ: "\n",
  altEnter: "\x1b\r",
  backspace: "\x7f",
  ctrl: (c: string) => String.fromCharCode(c.charCodeAt(0) - 96),
} as const;
