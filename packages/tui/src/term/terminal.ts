import { writeSync } from "node:fs";
import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { InputDecoder, type InputEvent } from "../input/keys.ts";

export interface TerminalOptions {
  /** AGENCY_FULL_REPAINT: send every cell on every frame. */
  fullRepaint: boolean;
  onInput: (event: InputEvent) => void;
  onResize: (cols: number, rows: number) => void;
}

export interface Terminal {
  renderer: CliRenderer;
  /** Leaves the alternate screen, shows the cursor, ends bracketed paste, then exits the process. */
  close(code?: number): Promise<never>;
}

/** Alternate screen off, cursor on, bracketed paste off, mouse and Kitty keyboard modes off, attributes reset. */
export const RESTORE =
  "\x1b[?1049l\x1b[?25h\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[<u\x1b[0m";
/** A lone ESC waits this long for the rest of a sequence before it counts as the escape key. */
const ESC_MS = 25;

function restore(): void {
  try {
    writeSync(1, RESTORE);
  } catch {
    // stdout is gone: there is no terminal left to restore.
  }
}

/**
 * The one terminal session: alternate screen, bracketed paste, a 60 fps cap. Raw input goes through the keys decoder of
 * the input layer; the renderer parses a bracketed paste itself and hands it over as one event. Every way out (esc
 * from the app, a signal, a crash, a plain process exit) restores the terminal.
 */
export async function openTerminal(o: TerminalOptions): Promise<Terminal> {
  const decoder = new InputDecoder();
  let escTimer: ReturnType<typeof setTimeout> | undefined;
  const emit = (events: InputEvent[]): void => {
    for (const e of events) o.onInput(e);
  };
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    targetFps: 60,
    maxFps: 60,
    useMouse: false,
    // The decoder owns every byte that is not a paste, so the legacy codes work and Kitty only when the terminal sends them.
    prependInputHandlers: [
      (sequence) => {
        clearTimeout(escTimer);
        emit(decoder.push(sequence));
        escTimer = setTimeout(() => emit(decoder.flush()), ESC_MS);
        return true;
      },
    ],
  });
  renderer.keyInput.on("paste", (e) => {
    o.onInput({ type: "paste", text: new TextDecoder().decode(e.bytes) });
  });
  renderer.on("resize", (cols: number, rows: number) => o.onResize(cols, rows));

  if (o.fullRepaint) {
    const redraw = (renderer as unknown as { processResize(w: number, h: number, repaint: boolean): void })
      .processResize;
    renderer.on("frame", () => redraw.call(renderer, renderer.width, renderer.height, true));
  }

  let closing = false;
  const close = async (code = 0): Promise<never> => {
    if (!closing) {
      closing = true;
      clearTimeout(escTimer);
      try {
        renderer.destroy();
        await Promise.race([renderer.idle(), new Promise((r) => setTimeout(r, 300))]);
      } catch {
        // A renderer that cannot stop cleanly still leaves the terminal restored below.
      }
      restore();
    }
    return process.exit(code);
  };
  const crash = (error: unknown): void => {
    try {
      renderer.destroy();
    } catch {}
    restore();
    process.stderr.write(
      `agency crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  for (const sig of ["SIGTERM", "SIGHUP"] as const) process.on(sig, () => void close(0));
  process.on("exit", restore);
  return { renderer, close };
}
