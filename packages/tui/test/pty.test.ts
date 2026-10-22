/**
 * L2: the real dev entry under a real pseudo-terminal, against a real daemon whose only fake part is the provider.
 * Everything a person does here goes in as bytes and is read back from the screen.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ESC, launch, type Pty, runScript } from "./pty.ts";

const has = (rows: string[], text: string): boolean => rows.some((r) => r.includes(text));
let pty: Pty;
afterAll(async () => {
  await pty?.stop();
});

describe("the TUI in a terminal", () => {
  test("starts on the home screen with the box, the hints and the empty state", async () => {
    pty = await launch();
    const rows = await pty.until("home", (r) => has(r, "What should Agency work on?"), 45_000);
    expect(has(rows, "agency")).toBe(true);
    expect(has(rows, "enter start")).toBe(true);
    expect(has(rows, "No sessions yet")).toBe(true);
    expect(has(rows, "daemon ready")).toBe(true);
    // The alternate screen is on, and bracketed paste with it.
    expect(pty.out.lastIndexOf(`${ESC}[?1049h`)).toBeGreaterThan(-1);
    expect(pty.out.lastIndexOf(`${ESC}[?2004h`)).toBeGreaterThan(-1);
  }, 60_000);

  test("a prompt streams a turn: steps, two asks answered with y, the answer and the closing row", async () => {
    pty.send("Make the 54 task runs faster without changing results.");
    pty.send("\r");
    // Each ask is awaited by what it asks for: a key sent early would be typed into the prompt.
    await pty.until("the ask to edit", (r) => has(r, "? Edit"));
    pty.send("y");
    await pty.until("the ask to run", (r) => has(r, "? Run"));
    pty.send("y");
    const rows = await pty.until("the closing row", (r) => has(r, "✓ done"));
    expect(has(rows, "▌› Make the 54 task runs faster")).toBe(true);
    expect(has(rows, "edit")).toBe(true);
    expect(has(rows, "Retries replace the failed trial in place")).toBe(true);
    expect(has(rows, "harbor run -r 2 --retry-include RuntimeError")).toBe(true);
    expect(has(rows, "copy")).toBe(true);
    expect(rows.find((r) => r.includes("✓ done"))).toContain("3 steps");
  }, 60_000);

  // A prompt sent while a turn still ends would queue: the hint row says when the turn is over.
  const idle = (r: string[]) => has(r, "esc esc turns");

  test("n denies an ask and the turn reads denied", async () => {
    await pty.until("idle", idle);
    pty.send("Now clean the build folder.");
    pty.send("\r");
    await pty.until("an ask", (r) => has(r, "? Run"));
    pty.send("n");
    const rows = await pty.until("denied", (r) => has(r, "✗ denied"));
    expect(has(rows, "you denied bash")).toBe(true);
  }, 60_000);

  test("esc stops a running turn", async () => {
    await pty.until("idle", idle);
    pty.send("Take your time with this one.");
    pty.send("\r");
    await pty.until("streaming", (r) => has(r, "word3"));
    pty.send(ESC);
    const rows = await pty.until("interrupted", (r) => has(r, "✗ interrupted"));
    expect(has(rows, "you pressed esc")).toBe(true);
    // The daemon still ends the turn: until it has, the session counts as running.
    await pty.until("the turn ended", idle);
  }, 60_000);

  test("ctrl+n goes home, ctrl+p lists the sessions and enter opens one", async () => {
    pty.send("\x0e");
    await pty.until("home", (r) => has(r, "What should Agency work on?"));
    pty.send("\x10");
    const palette = await pty.until("palette", (r) => has(r, "session or /command"));
    expect(has(palette, "sessions")).toBe(true);
    expect(has(palette, "commands")).toBe(true);
    expect(has(palette, "/settings")).toBe(true);
    pty.send("\r");
    // The palette lists newest first, and enter on the first row reloads the transcript from the daemon.
    const rows = await pty.until("the session again", (r) => has(r, "▌› Take your time with this one."));
    expect(has(rows, "▌› Now clean the build folder.")).toBe(true);
    expect(has(rows, "Retries replace the failed trial in place")).toBe(true);
  }, 60_000);

  test("ctrl+c twice quits and leaves the terminal as it was", async () => {
    pty.send("\x03");
    await pty.until("the quit hint", (r) => has(r, "press ctrl+c again to quit"));
    pty.send("\x03");
    expect(await pty.exited).toBe(0);
    const last = (n: number) =>
      pty.out.lastIndexOf(`${ESC}[?${n}h`) > pty.out.lastIndexOf(`${ESC}[?${n}l`) ? "h" : "l";
    expect(last(1049)).toBe("l");
    expect(last(25)).toBe("h");
    expect(last(2004)).toBe("l");
  }, 60_000);
});

describe("leaving the terminal as it was", () => {
  const crash = join(import.meta.dir, "crash-entry.ts");
  const restored = (out: string) => {
    const last = (n: number) =>
      out.lastIndexOf(`${ESC}[?${n}h`) > out.lastIndexOf(`${ESC}[?${n}l`) ? "h" : "l";
    expect(last(1049)).toBe("l");
    expect(last(25)).toBe("h");
    expect(last(2004)).toBe("l");
  };

  test("an exception that nobody catches restores the screen, says what failed and exits 1", async () => {
    const { out, code } = await runScript(crash, { CRASH_HOW: "throw" });
    expect(code).toBe(1);
    expect(out.lastIndexOf(`${ESC}[?1049h`)).toBeGreaterThan(-1);
    expect(out).toContain("agency crashed: Error: boom in a timer");
    restored(out);
  }, 30_000);

  test("a rejected promise nobody awaits does the same", async () => {
    const { out, code } = await runScript(crash, { CRASH_HOW: "reject" });
    expect(code).toBe(1);
    expect(out).toContain("boom in a promise");
    restored(out);
  }, 30_000);

  test.skipIf(process.platform === "win32")(
    "SIGTERM restores the screen and exits",
    async () => {
      const { out } = await runScript(crash, { CRASH_HOW: "signal" });
      restored(out);
    },
    30_000,
  );

  test("AGENCY_FULL_REPAINT still draws the screen and quits clean", async () => {
    const full = await launch({ env: { AGENCY_FULL_REPAINT: "1" } });
    try {
      await full.until("home", (r) => has(r, "What should Agency work on?"), 45_000);
      full.send("\x03");
      full.send("\x03");
      expect(await full.exited).toBe(0);
      restored(full.out);
    } finally {
      await full.stop();
    }
  }, 60_000);
});
