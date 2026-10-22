/** Runs the dev entry under a real pseudo-terminal (ConPTY on Windows) and reads its screen with a terminal emulator. */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultInstanceDir } from "@agency/cli";
import { Terminal } from "@xterm/headless";

const MAIN = join(import.meta.dir, "..", "..", "cli", "src", "entrypoint.ts");
const DAEMON = join(import.meta.dir, "scripted-daemon.ts");
export const ESC = "\x1b";

export interface Pty {
  /** Raw bytes the app wrote, for the checks of what it restored. */
  readonly out: string;
  send(bytes: string): void;
  /** Resizes the pseudo-terminal and the emulator that reads it, as dragging a window edge does. */
  resize(cols: number, rows: number): void;
  screen(): Promise<string[]>;
  /** Polls the screen until `ok` holds; the error carries the last screen. */
  until(what: string, ok: (rows: string[]) => boolean, ms?: number): Promise<string[]>;
  exited: Promise<number>;
  stop(): Promise<void>;
}

export async function launch(
  o: { cols?: number; rows?: number; env?: Record<string, string>; bin?: string } = {},
): Promise<Pty> {
  let cols = o.cols ?? 120;
  let rows = o.rows ?? 36;
  const workspace = mkdtempSync(join(tmpdir(), "agency-tui-pty-ws-"));
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  let out = "";
  let chain: Promise<void> = Promise.resolve();
  // A compiled binary starts its own daemon: the scripted one is a Bun script it cannot run.
  const proc = Bun.spawn(o.bin ? [o.bin] : [process.execPath, MAIN], {
    cwd: workspace,
    env: {
      ...process.env,
      COLORTERM: "truecolor",
      AGENCY_ANTHROPIC_API_KEY: "test-key-not-real",
      AGENCY_DISABLE_MODELS_FETCH: "1",
      ...(o.bin ? {} : { AGENCY_TUI_DAEMON_ENTRY: DAEMON }),
      AGENCY_REDUCED_MOTION: "1",
      ...o.env,
    },
    terminal: {
      cols,
      rows,
      data(_t: unknown, d: Uint8Array) {
        const s = Buffer.from(d).toString("utf8");
        out += s;
        chain = chain.then(() => new Promise<void>((r) => term.write(s, r)));
      },
    },
  });
  const screen = async (): Promise<string[]> => {
    await chain;
    return Array.from(
      { length: rows },
      (_, y) => term.buffer.active.getLine(y)?.translateToString(true, 0, cols) ?? "",
    );
  };
  const self: Pty = {
    get out() {
      return out;
    },
    send: (bytes) => proc.terminal?.write(bytes),
    resize(c, r) {
      cols = c;
      rows = r;
      proc.terminal?.resize(c, r);
      term.resize(c, r);
    },
    screen,
    async until(what, ok, ms = 20_000) {
      const end = Date.now() + ms;
      let last: string[] = [];
      while (Date.now() < end) {
        last = await screen();
        if (ok(last)) {
          // The renderer writes a frame in pieces: the screen counts when it still holds a moment later.
          await Bun.sleep(80);
          const again = await screen();
          if (ok(again)) return again;
        }
        await Bun.sleep(50);
      }
      throw new Error(`timed out waiting for ${what}\n${last.join("\n")}`);
    },
    exited: proc.exited,
    async stop() {
      proc.kill();
      await proc.exited.catch(() => undefined);
      // The daemon outlives its client by design: stop the one this run started.
      const dir = defaultInstanceDir();
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
        try {
          const info = JSON.parse(readFileSync(join(dir, f), "utf8")) as { pid?: number };
          if (info.pid) process.kill(info.pid);
        } catch {
          // Already gone.
        }
      }
      term.dispose();
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch {
        // The daemon of the workspace may still hold a file open on Windows.
      }
    },
  };
  return self;
}

/** Runs a script under a pseudo-terminal and gives back its raw output and exit code. */
export async function runScript(
  path: string,
  env: Record<string, string>,
): Promise<{ out: string; code: number }> {
  let out = "";
  const proc = Bun.spawn([process.execPath, path], {
    env: { ...process.env, ...env },
    terminal: {
      cols: 80,
      rows: 24,
      data(_t: unknown, d: Uint8Array) {
        out += Buffer.from(d).toString("utf8");
      },
    },
  });
  const code = await proc.exited;
  return { out, code };
}
