/** L3: the compiled `agency` binary (bun scripts/build.ts) under a pseudo-terminal; skipped when none is built here. */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ESC, launch, type Pty } from "./pty.ts";

const os = process.platform === "win32" ? "windows" : process.platform;
const BIN = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "dist",
  `agency-${os}-${process.arch}${os === "windows" ? ".exe" : ""}`,
);
const built = existsSync(BIN);
const has = (rows: string[], text: string): boolean => rows.some((r) => r.includes(text));
let pty: Pty | undefined;
afterAll(async () => {
  await pty?.stop();
});

describe.skipIf(!built)("the compiled binary", () => {
  test("opens on the home screen and ctrl+c twice leaves the terminal as it was", async () => {
    const p = await launch({ bin: BIN });
    pty = p;
    const rows = await p.until("home", (r) => has(r, "What should Agency work on?"), 45_000);
    expect(has(rows, "enter start")).toBe(true);
    p.send("\x03");
    await p.until("the quit hint", (r) => has(r, "press ctrl+c again to quit"));
    p.send("\x03");
    expect(await p.exited).toBe(0);
    const last = (n: number) =>
      p.out.lastIndexOf(`${ESC}[?${n}h`) > p.out.lastIndexOf(`${ESC}[?${n}l`) ? "h" : "l";
    expect(last(1049)).toBe("l");
    expect(last(25)).toBe("h");
    expect(last(2004)).toBe("l");
  }, 60_000);

  test("--version and -p keep the line-oriented CLI", async () => {
    const version = Bun.spawnSync([BIN, "--version"]);
    expect(version.exitCode).toBe(0);
    expect(version.stdout.toString().trim()).toMatch(/^\d+\.\d+\.\d+/);
    // No model is configured under the test home: -p fails with a message and never opens a screen.
    const p = Bun.spawnSync([BIN, "-p", "hi"], { stdin: Buffer.from("") });
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain("No model configured");
    expect(p.stdout.toString()).not.toContain(`${ESC}[?1049h`);
  }, 30_000);
});
