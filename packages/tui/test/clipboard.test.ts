import { describe, expect, test } from "bun:test";
import { copyText, type Feed } from "../src/term/clipboard.ts";

const TEXT = "héllo ✓ 日本 😀";

describe("copying with a system tool", () => {
  test("clip.exe gets UTF-16LE with a byte order mark, so non-ASCII survives", async () => {
    let got: { argv: string[]; input: Uint8Array } | undefined;
    const run: Feed = async (argv, input) => {
      got = { argv, input };
      return 0;
    };
    await copyText(TEXT, undefined, "win32", run);
    expect(got?.argv).toEqual(["clip"]);
    expect([...(got?.input.slice(0, 2) ?? [])]).toEqual([0xff, 0xfe]);
    expect(Buffer.from(got?.input.slice(2) ?? []).toString("utf16le")).toBe(TEXT);
  });

  test("other tools get UTF-8, and a failing tool hands over to the next", async () => {
    const tried: string[] = [];
    const run: Feed = async (argv, input) => {
      tried.push(argv[0] as string);
      if (argv[0] === "wl-copy") return 1;
      expect(new TextDecoder().decode(input)).toBe(TEXT);
      return 0;
    };
    await copyText(TEXT, undefined, "linux", run);
    expect(tried).toEqual(["wl-copy", "xclip"]);
  });

  test("with no tool that works it says so", async () => {
    const run: Feed = async () => {
      throw new Error("not installed");
    };
    await expect(copyText("x", undefined, "linux", run)).rejects.toThrow(/no clipboard/);
  });
});
