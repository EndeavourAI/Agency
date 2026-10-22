import { describe, expect, test } from "bun:test";
import type { DaemonClient } from "@agency/rpc";
import { createTuiClient } from "../src/client/client.ts";
import { type AppState, type Event, initialState, reduce, type Turn } from "../src/state/index.ts";

const SID = "s1";
const TID = "t1";

/** A daemon the test scripts by method: each answer may be a value or a function that throws. */
function rig(script: Record<string, (params: unknown) => unknown>) {
  let state: AppState = initialState({ cols: 120, rows: 40 });
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const daemon: DaemonClient = {
    call: async (method, params) => {
      const f = script[method];
      if (!f) throw new Error(`unscripted ${method}`);
      return f(params);
    },
    on: (ev, h) => {
      const set = handlers.get(ev) ?? new Set();
      handlers.set(ev, set.add(h));
      return () => set.delete(h);
    },
    subscribe: () => {},
    unsubscribe: () => {},
    close: async () => {},
  };
  const dispatch = (events: Event[]): void => {
    for (const e of events) state = reduce(state, e);
  };
  const client = createTuiClient({
    daemon,
    dispatch,
    getState: () => state,
    now: () => 1000,
    newId: () => "id",
    host: { copy: async () => {}, readClipboardImage: async () => null, quit: () => {} },
  });
  dispatch([
    { type: "conn", status: "online" },
    { type: "session_opened", sessionId: SID },
    { type: "turn_started", sessionId: SID, turnId: TID, prompt: "hi", images: [], at: 1 },
  ]);
  const turn = (): Turn => state.bySession[SID]?.blocks.find((b): b is Turn => b.kind === "turn") as Turn;
  const emit = (ev: string, payload: unknown): void => {
    for (const h of handlers.get(ev) ?? []) h(payload);
  };
  const until = async (ok: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(ok()).toBe(true);
  };
  const lose = () =>
    client.run([
      {
        type: "send_turn",
        sessionId: SID,
        turnId: TID,
        text: "hi",
        images: [],
        mode: "build",
        effort: "medium",
        model: "anthropic/m",
        create: false,
      },
    ]);
  return { client, turn, emit, until, lose };
}

const entries = (text: string) => [
  {
    type: "message",
    id: "e1",
    turnId: TID,
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
  },
  {
    type: "message",
    id: "e2",
    turnId: TID,
    message: { role: "assistant", content: [{ type: "text", text }] },
  },
];

const gone = (): never => {
  throw new Error("connection to daemon closed");
};

describe("reconnect with a turn that ran meanwhile", () => {
  test("a failed turns_list keeps the turn lost instead of cancelling it", async () => {
    let listed = 0;
    const r = rig({
      session_send: gone,
      turns_list: () => {
        if (++listed === 1) throw new Error("daemon busy");
        return { turns: [{ turnId: TID, sessionId: SID, approvals: [] }] };
      },
      session_list: () => ({ sessions: [] }),
      cost_report: () => ({}),
      session_show: () => ({ entries: entries("partial\n"), tipId: "e2" }),
      status_get: () => ({ status: {} }),
      todo_read: () => ({ todos: [] }),
      git_status: () => {
        throw new Error("n/a");
      },
    });
    await r.lose();
    r.client.onConnection(true);
    await r.until(() => listed === 1);
    await new Promise((res) => setTimeout(res, 50));
    expect(r.turn().status).toBe("running");
    r.client.onConnection(true);
    await r.until(() => listed === 2);
    r.emit(`turn.${TID}`, { type: "turn_end", stopReason: "end_turn", cancelled: false });
    await r.until(() => r.turn().status === "done");
  });

  test("a turn the daemon no longer lists is cancelled", async () => {
    const r = rig({
      session_send: gone,
      turns_list: () => ({ turns: [] }),
      session_list: () => ({ sessions: [] }),
      cost_report: () => ({}),
      // The reload never answers: what shows is what the cancel left.
      session_show: () => new Promise(() => {}),
      status_get: () => ({ status: {} }),
      todo_read: () => ({ todos: [] }),
      git_status: () => {
        throw new Error("n/a");
      },
    });
    await r.lose();
    r.client.onConnection(true);
    await r.until(() => r.turn().status === "stopped");
  });

  test("a turn that still runs takes the text the file holds beyond what the screen got", async () => {
    const r = rig({
      session_send: gone,
      turns_list: () => ({ turns: [{ turnId: TID, sessionId: SID, approvals: [] }] }),
      session_list: () => ({ sessions: [] }),
      cost_report: () => ({}),
      session_show: () => ({ entries: entries("Text the outage dropped.\n"), tipId: "e2" }),
      status_get: () => ({ status: {} }),
      todo_read: () => ({ todos: [] }),
      git_status: () => {
        throw new Error("n/a");
      },
    });
    await r.lose();
    r.client.onConnection(true);
    await r.until(() => r.turn().text === "Text the outage dropped.\n");
    expect(r.turn().status).toBe("running");
  });
});
