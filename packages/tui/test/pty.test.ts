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
    expect(last(2027)).toBe("l");
  }, 60_000);
});

describe("a daemon with no provider key", () => {
  test("the model picker opens on its own with the way to add a key", async () => {
    const bare = await launch({ env: { AGENCY_ANTHROPIC_API_KEY: "" } });
    try {
      // The screen is read between two writes of the renderer: wait for the whole dialog.
      const rows = await bare.until(
        "the picker",
        (r) => has(r, "No provider has a key yet.") && has(r, "effort"),
        45_000,
      );
      expect(has(rows, "agency auth login <provider>")).toBe(true);
      bare.send(ESC);
      await bare.until("home", (r) => !has(r, "No provider has a key yet."));
    } finally {
      await bare.stop();
    }
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
    expect(last(2027)).toBe("l");
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

  test("AGENCY_FULL_REPAINT sends the whole screen for one typed letter, and a plain run sends the changed cells", async () => {
    const bytesForOneLetter = async (env: Record<string, string>): Promise<number> => {
      const p = await launch({ env });
      try {
        await p.until("home", (r) => has(r, "What should Agency work on?"), 45_000);
        await Bun.sleep(400);
        const before = p.out.length;
        p.send("x");
        await p.until("the letter", (r) => r.some((l) => l.includes("x")), 10_000);
        await Bun.sleep(400);
        const sent = p.out.length - before;
        // The first ctrl+c clears the letter, the second asks, the third quits.
        for (let i = 0; i < 3; i++) {
          p.send("\x03");
          await Bun.sleep(100);
        }
        expect(await p.exited).toBe(0);
        restored(p.out);
        return sent;
      } finally {
        await p.stop();
      }
    };
    const plain = await bytesForOneLetter({});
    const full = await bytesForOneLetter({ AGENCY_FULL_REPAINT: "1" });
    expect(full).toBeGreaterThan(120 * 36);
    expect(full).toBeGreaterThan(plain * 3);
  }, 120_000);
});

describe("the keyboard", () => {
  const pushes = (out: string): number => out.split(`${ESC}[>1u`).length - 1;

  test("a terminal that answers the Kitty probe gets the flags and ctrl+, opens settings", async () => {
    const p = await launch();
    try {
      await p.until("home", (r) => has(r, "What should Agency work on?"), 45_000);
      expect(p.out).toContain(`${ESC}[?u`);
      expect(pushes(p.out)).toBe(0);
      p.send(`${ESC}[?0u${ESC}[?62;4c`);
      const end = Date.now() + 10_000;
      while (pushes(p.out) === 0 && Date.now() < end) await Bun.sleep(50);
      expect(pushes(p.out)).toBe(1);
      p.send(`${ESC}[44;5u`);
      await p.until("settings", (r) => has(r, "General") && has(r, "Theme"));
      p.send(ESC);
      await Bun.sleep(150);
      p.send("\x03");
      await Bun.sleep(100);
      p.send("\x03");
      await p.exited;
      expect(p.out).toContain(`${ESC}[<u`);
    } finally {
      await p.stop();
    }
  }, 90_000);

  test("a legacy terminal never gets the flags: ctrl+, is a comma in the prompt", async () => {
    const p = await launch();
    try {
      await p.until("home", (r) => has(r, "What should Agency work on?"), 45_000);
      p.send(",");
      await p.until("the comma", (r) => has(r, "› ,"));
      expect(pushes(p.out)).toBe(0);
    } finally {
      await p.stop();
    }
  }, 90_000);
});

describe("resizing the terminal", () => {
  const boxWidth = (rows: string[]): { at: number; w: number } => {
    // The top border of the prompt box: the one row that holds both corners.
    const row = rows.find((r) => r.includes("┌") && r.includes("┐")) ?? "";
    return { at: row.indexOf("┌"), w: row.lastIndexOf("┐") - row.indexOf("┌") + 1 };
  };
  const logo = (rows: string[]) => has(rows, "▓▓");
  const sizes = [
    [120, 40],
    [200, 60],
    [80, 24],
  ] as const;

  test("home re-lays out on every size: the logo needs 30 rows, the box is 88 wide at most and stays centred", async () => {
    const p = await launch({ cols: 80, rows: 24 });
    try {
      let rows = await p.until("home", (r) => has(r, "What should Agency work on?"), 45_000);
      expect(logo(rows)).toBe(false);
      expect(boxWidth(rows)).toEqual({ at: 2, w: 76 });
      const expected = [
        { logo: true, at: 16, w: 88 },
        { logo: true, at: 56, w: 88 },
        { logo: false, at: 2, w: 76 },
      ];
      for (const [i, [c, r]] of sizes.entries()) {
        const want = expected[i] as (typeof expected)[number];
        p.resize(c, r);
        rows = await p.until(
          `${c}x${r}`,
          (s) => boxWidth(s).w === want.w && boxWidth(s).at === want.at && logo(s) === want.logo,
          15_000,
        );
        expect(has(rows, "enter start")).toBe(true);
        expect(rows.length).toBe(r);
      }
    } finally {
      await p.stop();
    }
  }, 120_000);

  test("a session shows the details pane from 120 columns and hides it below, at every size", async () => {
    const p = await launch({ cols: 80, rows: 24 });
    try {
      await p.until("home", (r) => has(r, "What should Agency work on?"), 45_000);
      p.send("Make the 54 task runs faster without changing results.");
      p.send("\r");
      await p.until("the ask to edit", (r) => has(r, "? Edit"));
      p.send("y");
      await p.until("the ask to run", (r) => has(r, "? Run"));
      p.send("y");
      await p.until("the closing row", (r) => has(r, "✓ done"), 30_000);
      // Measure the idle screen: the frame that first shows the closing row can still hold the ask box.
      let rows = await p.until("idle", (r) => has(r, "esc esc turns"));
      expect(has(rows, "No task list yet")).toBe(false);
      expect(boxWidth(rows).w).toBe(76);
      const steps = [
        { size: [120, 40], details: true, box: 75 },
        { size: [200, 60], details: true, box: 155 },
        { size: [80, 24], details: false, box: 76 },
      ] as const;
      for (const s of steps) {
        p.resize(s.size[0], s.size[1]);
        rows = await p.until(
          `${s.size[0]}x${s.size[1]}`,
          (r) => has(r, "No task list yet") === s.details && boxWidth(r).w === s.box,
          15_000,
        );
        expect(has(rows, "↑ history")).toBe(s.details);
        expect(has(rows, "✓ done")).toBe(true);
        expect(rows.length).toBe(s.size[1]);
      }
    } finally {
      await p.stop();
    }
  }, 150_000);
});
