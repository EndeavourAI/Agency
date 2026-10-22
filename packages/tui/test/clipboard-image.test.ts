import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { MAX_IMAGE_BYTES, type Run, readClipboardImage } from "../src/term/clipboard-image.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const none = { code: 1, out: new Uint8Array() };

describe("the clipboard image of each platform", () => {
  test("linux tries wl-paste, then xclip, and takes the first PNG", async () => {
    const tried: string[] = [];
    const run: Run = async (argv) => {
      tried.push(argv[0] as string);
      return argv[0] === "xclip" ? { code: 0, out: PNG } : none;
    };
    const chip = await readClipboardImage("linux", run);
    expect(tried).toEqual(["wl-paste", "xclip"]);
    expect(chip).toMatchObject({ mimeType: "image/png", size: PNG.length, name: "" });
    expect(Buffer.from(chip?.data ?? "", "base64")).toEqual(Buffer.from(PNG));
  });

  test("windows asks PowerShell for the image and reads the PNG it saved", async () => {
    const calls: Array<{ argv: string[]; env?: Record<string, string> }> = [];
    const run: Run = async (argv, env) => {
      calls.push({ argv, ...(env ? { env } : {}) });
      writeFileSync(env?.AGENCY_CLIP as string, PNG);
      return { code: 0, out: new Uint8Array() };
    };
    const chip = await readClipboardImage("win32", run);
    expect(calls[0]?.argv.slice(0, 4)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-STA"]);
    expect(calls[0]?.argv.at(-1)).toContain("Get-Clipboard -Format Image");
    expect(chip?.size).toBe(PNG.length);
  });

  test("macOS uses pngpaste, then osascript", async () => {
    const tried: string[] = [];
    const run: Run = async (argv, env) => {
      tried.push(argv[0] as string);
      if (argv[0] === "osascript") {
        writeFileSync(env?.AGENCY_CLIP as string, PNG);
        return { code: 0, out: new Uint8Array() };
      }
      return { code: 127, out: new Uint8Array() };
    };
    expect((await readClipboardImage("darwin", run))?.size).toBe(PNG.length);
    expect(tried).toEqual(["pngpaste", "osascript"]);
  });

  test("text on the clipboard, or no tool at all, is no image", async () => {
    expect(
      await readClipboardImage("linux", async () => ({ code: 0, out: new TextEncoder().encode("hi") })),
    ).toBeNull();
    expect(await readClipboardImage("win32", async () => ({ code: 3, out: new Uint8Array() }))).toBeNull();
    expect(await readClipboardImage("freebsd", async () => none)).toBeNull();
  });

  test("an image over the limit is refused with its size", async () => {
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(PNG);
    await expect(readClipboardImage("linux", async () => ({ code: 0, out: big }))).rejects.toThrow(
      /the image is 8\.0 MB: the limit is 8 MB/,
    );
  });
});
