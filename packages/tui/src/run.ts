/** The TUI entry shared by the `agency` command and the tests: the caller owns daemon discovery and the version. */
import type { DaemonClient } from "@agency/rpc";
import type { Runtime } from "./runtime/index.ts";
import { createRuntime } from "./runtime/index.ts";
import { fullRepaint, reducedMotion } from "./term/caps.ts";
import { copyText } from "./term/clipboard.ts";
import { readClipboardImage } from "./term/clipboard-image.ts";
import "./term/register.ts";
import { openTerminal } from "./term/terminal.ts";

export interface RunTuiOptions {
  version: string;
  workspace: string;
  /** Called before the alternate screen opens, so spawn and connect messages stay on the plain terminal. */
  connect: (onConnection: (online: boolean) => void) => Promise<DaemonClient>;
}

export async function runTui(o: RunTuiOptions): Promise<void> {
  let runtime: Runtime | undefined;
  const client = await o.connect((online) => runtime?.onConnection(online));
  const term = await openTerminal({
    fullRepaint: fullRepaint(),
    onInput: (e) => runtime?.input(e),
    onResize: (cols, rows) => runtime?.resize(cols, rows),
  });
  const { renderer } = term;

  runtime = createRuntime({
    daemon: client,
    cols: renderer.width,
    rows: renderer.height,
    workspace: o.workspace,
    host: {
      copy: (text) => copyText(text, renderer),
      readClipboardImage: () => readClipboardImage(),
      quit: () => void term.close(0),
    },
  });

  const { mountApp } = await import("./view/root.tsx");
  await runtime.bootstrap();
  await mountApp(renderer, runtime, {
    version: o.version,
    reducedMotion: reducedMotion(process.env, runtime.state.settings.config),
  });
}
