/**
 * The whole core against a real daemon: raw key bytes in, the real client layer in the middle, the reducer's state out.
 * The provider is scripted (scenario.ts); the daemon, its approval gate, its session store and the RPC are real.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket, connect as tcpConnect } from "node:net";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { createTuiClient, type TuiClient } from "../src/client/index.ts";
import { dispatchKey, dispatchPaste, type Out } from "../src/controller/index.ts";
import { InputDecoder } from "../src/input/keys.ts";
import {
  type AppState,
  current,
  type Event,
  initialState,
  reduce,
  showAsk,
  type Turn,
  turnStamp,
} from "../src/state/index.ts";
import { KEY } from "./helpers.ts";
import { ANSWER, type Scenario, startScenario } from "./scenario.ts";

const PREFACE = "Looking at the run script.\n";

let scenario: Scenario;
beforeAll(async () => {
  scenario = await startScenario();
});
afterAll(async () => {
  await scenario.stop();
});

/** A TCP relay in front of the daemon: `drop()` cuts every connection, as a network fault would. */
async function relay(
  target: number,
): Promise<{ port: number; drop: () => void; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const upstream = tcpConnect(target, "127.0.0.1");
    sockets.add(client);
    client.on("error", () => {});
    upstream.on("error", () => {});
    client.pipe(upstream);
    upstream.pipe(client);
    client.on("close", () => upstream.end());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    port: (server.address() as { port: number }).port,
    drop: () => {
      for (const s of sockets) s.destroy();
      sockets.clear();
    },
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

class Live {
  state: AppState = initialState({ cols: 120, rows: 40 });
  client!: TuiClient;
  daemon!: DaemonClient;
  private static seq = 0;
  private readonly tag = `e2e${++Live.seq}`;
  private n = 0;
  private readonly decoder = new InputDecoder();
  pending: Promise<void>[] = [];
  readonly copied: string[] = [];

  newId = (): string => `${this.tag}-${++this.n}`;

  dispatch = (events: Event[]): void => {
    for (const e of events) this.state = reduce(this.state, e);
  };

  async attach(
    open: (onConnection: (online: boolean) => void) => ReturnType<typeof connectToDaemon>,
  ): Promise<void> {
    const daemon = await open((online) => this.client?.onConnection(online));
    this.daemon = daemon;
    this.client = createTuiClient({
      daemon,
      dispatch: this.dispatch,
      getState: () => this.state,
      now: () => Date.now(),
      newId: this.newId,
      host: {
        copy: async (t) => void this.copied.push(t),
        readClipboardImage: async () => null,
        quit: () => {},
      },
    });
  }

  private apply(out: Out): void {
    this.dispatch(out.events);
    this.pending.push(this.client.run(out.effects));
  }

  send(bytes: string): void {
    for (const ev of [...this.decoder.push(bytes), ...this.decoder.flush()]) {
      if (ev.type === "key") this.apply(dispatchKey(this.state, ev, { now: Date.now(), newId: this.newId }));
      else if (ev.type === "paste") this.apply(dispatchPaste(this.state, ev.text));
    }
  }

  async settle(): Promise<void> {
    while (this.pending.length) await this.pending.shift();
  }

  async until(what: string, ok: () => boolean, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  turns = (): Turn[] => (current(this.state)?.blocks ?? []).filter((b): b is Turn => b.kind === "turn");
}

describe("a person drives a real daemon", () => {
  const live = new Live();
  let sessionId = "";

  test("bootstrap loads sessions, commands and the model list from the daemon", async () => {
    await live.attach((onConnection) => scenario.connect(onConnection));
    await live.client.bootstrap();
    expect(live.state.conn).toBe("online");
    expect(live.state.sessions).toEqual([]);
    expect(live.state.slash.map((s) => s.name)).toContain("compact");
    // The scripted provider has no catalog entry: the person's model choice is a plain ref.
    live.state = { ...live.state, defaultModel: "anthropic/fixture-model" };
  });

  test("a prompt streams a turn: steps, approvals answered by key, markdown answer, cost", async () => {
    live.send("Make the 54 task runs faster without changing results.");
    live.send(KEY.enter);
    expect(live.state.view).toBe("session");
    sessionId = live.state.sessionId as string;
    for (let asks = 0; asks < 2; asks++) {
      await live.until("an approval", () => showAsk(live.state));
      live.send("y");
    }
    await live.until("turn done", () => live.turns()[0]?.status === "done");
    await live.settle();
    const t = live.turns()[0] as Turn;
    expect(t.steps.map((s) => [s.tool, s.status])).toEqual([
      ["read", "ok"],
      ["edit", "ok"],
      ["bash", "ok"],
    ]);
    expect(t.text).toBe(`${PREFACE}${ANSWER}`);
    expect(t.answer.settled.map((b) => b.kind)).toEqual(["text", "text", "code", "text", "text"]);
    expect(t.thinking).toBe("Read the run script first, then change the retry flags.");
    expect(t.costUsd).toBeCloseTo(0.015, 6);
    expect(t.usage.outputTokens).toBe(200);
    expect(current(live.state)?.runningTurnId).toBeNull();
  }, 30_000);

  test("after the turn the daemon's own numbers arrive: session row, status, prompt history", async () => {
    await live.until("session listed", () => live.state.sessions.some((s) => s.id === sessionId));
    await live.until("status", () => current(live.state)?.status !== null);
    expect(live.state.sessions[0]?.costUsd).toBeCloseTo(0.015, 6);
    expect(current(live.state)?.status?.costUsd).toBeCloseTo(0.015, 6);
    expect(live.state.history[0]).toBe("Make the 54 task runs faster without changing results.");
  });

  test("n denies the ask: the daemon is told, the turn is cancelled and reads denied", async () => {
    live.send("Now clean the build folder.");
    live.send(KEY.enter);
    await live.until("an approval", () => showAsk(live.state));
    live.send("n");
    await live.until(
      "turn ended",
      () => current(live.state)?.runningTurnId === null && live.turns()[1]?.status === "denied",
    );
    await live.settle();
    const t = live.turns()[1] as Turn;
    expect(t.status).toBe("denied");
    expect(t.steps[0]).toMatchObject({ tool: "bash", status: "denied" });
  }, 30_000);

  test("a session opened later rebuilds the same transcript from the daemon", async () => {
    const other = new Live();
    await other.attach((onConnection) => scenario.connect(onConnection));
    await other.client.bootstrap();
    other.dispatch([{ type: "session_opened", sessionId }]);
    await other.client.openSession(sessionId);
    const blocks = other.turns();
    expect(blocks.map((t) => t.prompt)).toEqual([
      "Make the 54 task runs faster without changing results.",
      "Now clean the build folder.",
    ]);
    expect(blocks[0]?.steps.map((s) => s.tool)).toEqual(["read", "edit", "bash"]);
    expect(blocks[0]?.text).toBe(`${PREFACE}${ANSWER}`);
    expect(blocks[1]?.steps[0]?.status).toBe("denied");
  });
});

describe("the connection drops and comes back", () => {
  test("the turn survives in the daemon: paused while away, the ask still answerable, then settled", async () => {
    const net = await relay(scenario.daemon.server.port);
    const live = new Live();
    await live.attach((onConnection) =>
      connectToDaemon(net.port, "127.0.0.1", { token: scenario.daemon.server.token as string, onConnection }),
    );
    await live.client.bootstrap();
    live.state = { ...live.state, defaultModel: "anthropic/fixture-model" };

    live.send("First prompt of the other session.");
    live.send(KEY.enter);
    await live.until("an approval", () => showAsk(live.state));
    const sid = live.state.sessionId as string;

    net.drop();
    await live.until("offline", () => live.state.conn === "offline");
    expect(live.turns()[0]?.status).toBe("running");
    expect(turnStamp(live.turns()[0] as Turn, true).label).toBe("paused");

    await live.until("online again", () => live.state.conn === "online", 15_000);
    // The daemon still runs the turn and still waits for the answer: the ask on screen is real.
    expect(showAsk(live.state)).toBe(true);
    live.send("y");
    await live.until("turn settled", () => live.turns()[0]?.status === "done", 15_000);
    await live.settle();
    expect(current(live.state)?.runningTurnId).toBeNull();
    expect(live.turns()).toHaveLength(1);
    expect(live.turns()[0]?.text).toBe("Ran it.\n");
    expect(live.state.sessions.some((r) => r.id === sid)).toBe(true);
    await live.daemon.close();
    await net.close();
  }, 40_000);
});
