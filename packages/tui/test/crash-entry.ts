/** Opens the terminal like the dev entry does, then fails the way a bug would: the PTY test checks what is left behind. */
import "../src/term/register.ts";
import { openTerminal } from "../src/term/terminal.ts";

const term = await openTerminal({ fullRepaint: false, onInput: () => {}, onResize: () => {} });
term.renderer.requestRender();
const how = process.env.CRASH_HOW ?? "throw";
setTimeout(() => {
  if (how === "reject") void Promise.reject(new Error("boom in a promise"));
  else if (how === "signal") process.kill(process.pid, "SIGTERM");
  else throw new Error("boom in a timer");
}, 600);
