#!/usr/bin/env bun
/**
 * Dev entry of the TUI: connects to (or starts) the daemon of this folder and runs the screen. The `agency` command does
 * not open it yet.
 */
import { readFileSync } from "node:fs";
import { connectHeadlessClient } from "@agency/cli";
import { connectToDaemon } from "@agency/rpc";
import type { Runtime } from "./runtime/index.ts";
import { createRuntime } from "./runtime/index.ts";
import { fullRepaint, reducedMotion } from "./term/caps.ts";
import { copyText } from "./term/clipboard.ts";
import { readClipboardImage } from "./term/clipboard-image.ts";
import "./term/register.ts";
import { openTerminal } from "./term/terminal.ts";

if (!process.stdout.isTTY || !process.stdin.isTTY) {
  process.stderr.write("agency tui needs a terminal on stdin and stdout\n");
  process.exit(2);
}

const workspace = process.cwd();
let runtime: Runtime | undefined;
// Spawn and connect messages print before the alternate screen opens.
const { client } = await connectHeadlessClient({
  workspaceRoot: workspace,
  // A test hook: a daemon entry with a scripted provider, started the way the real one is.
  ...(process.env.AGENCY_TUI_DAEMON_ENTRY ? { daemonEntryPath: process.env.AGENCY_TUI_DAEMON_ENTRY } : {}),
  connect: (port, host, options) =>
    connectToDaemon(port, host, { ...options, onConnection: (online) => runtime?.onConnection(online) }),
});

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
  workspace,
  host: {
    copy: (text) => copyText(text, renderer),
    readClipboardImage: () => readClipboardImage(),
    quit: () => void term.close(0),
  },
});

const { mountApp } = await import("./view/root.tsx");
const version = (
  JSON.parse(readFileSync(new URL("../../cli/package.json", import.meta.url), "utf8")) as { version: string }
).version;
await runtime.bootstrap();
await mountApp(renderer, runtime, {
  version,
  reducedMotion: reducedMotion(process.env, runtime.state.settings.config),
});
