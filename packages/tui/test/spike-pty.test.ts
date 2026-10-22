import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal } from "@xterm/headless";

/** M0 evidence: the OpenTUI spike runs under a real pseudo-terminal (ConPTY on Windows) and restores it on exit. */
const dir = mkdtempSync(join(tmpdir(), "agency-tui-spike-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const SPIKE = join(import.meta.dir, "..", "scripts", "spike.ts");
const ESC = "\x1b";

async function run(keys: string[]): Promise<{ out: string; code: number; keylog: string[] }> {
  const keylog = join(dir, `keys-${Math.random().toString(36).slice(2)}.log`);
  let out = "";
  const proc = Bun.spawn([process.execPath, SPIKE], {
    env: { ...process.env, SPIKE_KEYLOG: keylog },
    terminal: {
      cols: 80,
      rows: 24,
      data(_t: unknown, d: Uint8Array) {
        out += Buffer.from(d).toString("utf8");
      },
    },
  });
  const until = Date.now() + 15_000;
  while (!out.includes("agency") && Date.now() < until) await Bun.sleep(50);
  await Bun.sleep(700);
  for (const k of keys) {
    proc.terminal?.write(k);
    await Bun.sleep(250);
  }
  proc.terminal?.write(ESC);
  const code = await proc.exited;
  let keylog_: string[] = [];
  try {
    keylog_ = readFileSync(keylog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string);
  } catch {}
  return { out, code, keylog: keylog_ };
}

async function screen(out: string): Promise<string[]> {
  // Replay only up to the alternate-screen exit, where the last frame still stands.
  const frame = out.slice(0, out.lastIndexOf(`${ESC}[?1049l`));
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(frame, resolve));
  const lines = Array.from(
    { length: 24 },
    (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? "",
  );
  term.dispose();
  return lines;
}

describe("renderer spike under a pty", () => {
  test("draws top bar, streaming list and a 3-row bordered box, then restores the terminal", async () => {
    const { out, code } = await run([]);
    expect(code).toBe(0);
    const rows = await screen(out);
    expect(rows[0]).toContain("agency  spike");
    expect(rows.slice(1, 21).filter((r) => r.trim() !== "").length).toBeGreaterThan(2);
    expect(rows[21]?.startsWith("┌")).toBe(true);
    expect(rows[22]).toContain("type here");
    expect(rows[23]?.startsWith("└")).toBe(true);
    const last = (n: number) =>
      out.lastIndexOf(`${ESC}[?${n}h`) > out.lastIndexOf(`${ESC}[?${n}l`) ? "h" : "l";
    expect(last(1049)).toBe("l");
    expect(last(25)).toBe("h");
    expect(last(2004)).toBe("l");
  }, 30_000);

  test("keys arrive as the bytes a terminal sends", async () => {
    const sent = ["\x1b[Z", "\n", "\x1b\r", "\x1b[5~", "\x1b[1;5F", "\x1b[44;5u", "\x1b[13;5u"];
    const { keylog } = await run([...sent, "\x1b[200~pasted\x1b[201~"]);
    for (const bytes of sent) expect(keylog).toContain(bytes);
    // A bracketed paste is parsed by the renderer: only the paste event carries it.
    expect(keylog).toContain("paste:pasted");
    expect(keylog.some((k) => k.includes("[200~"))).toBe(false);
  }, 30_000);
});
