/**
 * M0 renderer spike (dev only, not the product): top bar, a list fed at ~100 tokens/s and a bordered
 * 3-row input box. SPIKE_KEYLOG=<file> appends the raw bytes of every key; esc or ctrl+c quits.
 */
import { appendFileSync } from "node:fs";
import { BoxRenderable, createCliRenderer, TextRenderable } from "@opentui/core";

const keylog = process.env.SPIKE_KEYLOG;
const WORDS =
  "the quick brown fox jumps over a lazy dog while the agent streams tokens into the ledger".split(" ");

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  clearOnShutdown: false,
  screenMode: "alternate-screen",
  targetFps: 60,
  useMouse: false,
  prependInputHandlers: [
    (sequence) => {
      if (keylog) appendFileSync(keylog, `${JSON.stringify(sequence)}\n`);
      if (sequence === "\x1b" || sequence === "\x03") {
        void quit();
        return true;
      }
      return false;
    },
  ],
});

// Bracketed paste never reaches the raw handler above: the renderer parses it and raises a paste event.
renderer.keyInput.on("paste", (e) => {
  if (keylog) appendFileSync(keylog, `${JSON.stringify(`paste:${new TextDecoder().decode(e.bytes)}`)}\n`);
});

const bar = new TextRenderable(renderer, { content: " agency  spike  ctrl+p", height: 1, fg: "#e0b46c" });
const list = new TextRenderable(renderer, { content: "", flexGrow: 1, fg: "#ebe9e4" });
const input = new BoxRenderable(renderer, { height: 3, border: true, borderColor: "#6a6760" });
input.add(new TextRenderable(renderer, { content: "> type here (esc quits)", fg: "#8f8c85" }));
const column = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", height: "100%" });
column.add(bar);
column.add(list);
column.add(input);
renderer.root.add(column);

let tokens = 0;
let line = "";
const lines: string[] = [];
const timer = setInterval(() => {
  const word = WORDS[tokens++ % WORDS.length] ?? "";
  if (line.length + word.length > 60) {
    lines.push(line);
    line = word;
  } else line = `${line} ${word}`.trim();
  list.content = [...lines.slice(-(renderer.height - 5)), line].join("\n");
  renderer.requestRender();
}, 10);

let quitting = false;
async function quit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  clearInterval(timer);
  renderer.destroy();
  await renderer.idle?.();
  process.exit(0);
}
