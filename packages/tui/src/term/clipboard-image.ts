import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageChip } from "../state/types.ts";
import { TOOL_MS } from "./clipboard.ts";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type Run = (
  argv: string[],
  env?: Record<string, string>,
) => Promise<{ code: number; out: Uint8Array }>;

const isPng = (b: Uint8Array): boolean => [0x89, 0x50, 0x4e, 0x47].every((v, i) => b[i] === v);

/** A helper that outlives `ms` is killed and counts as no image: a stuck one must not leave the paste pending. */
export const runTool =
  (ms: number = TOOL_MS): Run =>
  async (argv, env) => {
    try {
      const proc = Bun.spawn(argv, {
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
        env: { ...process.env, ...env },
      });
      const timer = setTimeout(() => proc.kill(), ms);
      try {
        const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
        return { code: await proc.exited, out };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // The tool is not installed: the next one gets its turn.
      return { code: 127, out: new Uint8Array() };
    }
  };

/** PowerShell 5.1 runs in an STA thread, which the clipboard needs; `Get-Clipboard -Format Image` is null for text. */
const WINDOWS = [
  "Add-Type -AssemblyName System.Drawing",
  "$i = Get-Clipboard -Format Image",
  "if ($null -eq $i) { exit 3 }",
  "$i.Save($env:AGENCY_CLIP, [System.Drawing.Imaging.ImageFormat]::Png)",
].join("; ");

const MAC_SCRIPT = [
  "set png to (the clipboard as «class PNGf»)",
  'set f to open for access POSIX file (system attribute "AGENCY_CLIP") with write permission',
  "set eof of f to 0",
  "write png to f",
  "close access f",
];

/** Tools that print the PNG on stdout, tried in order. */
const STDOUT: Record<string, string[][]> = {
  darwin: [["pngpaste", "-"]],
  linux: [
    ["wl-paste", "--type", "image/png"],
    ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
  ],
};

/** Tools that write the PNG to the file named by AGENCY_CLIP. */
const TO_FILE: Record<string, string[][]> = {
  win32: [
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS],
    ["pwsh", "-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS],
  ],
  darwin: [["osascript", ...MAC_SCRIPT.flatMap((l) => ["-e", l])]],
};

/** The image on the system clipboard as a chip, or null when it holds none. Throws when the image is too large. */
export async function readClipboardImage(
  platform: string = process.platform,
  run: Run = runTool(),
): Promise<ImageChip | null> {
  let png: Uint8Array | null = null;
  for (const argv of STDOUT[platform] ?? []) {
    const r = await run(argv);
    if (r.code === 0 && isPng(r.out)) {
      png = r.out;
      break;
    }
  }
  if (!png && TO_FILE[platform]) {
    const dir = mkdtempSync(join(tmpdir(), "agency-clip-"));
    const file = join(dir, "clip.png");
    try {
      for (const argv of TO_FILE[platform] ?? []) {
        const r = await run(argv, { AGENCY_CLIP: file });
        if (r.code !== 0) continue;
        const bytes = readFileSync(file);
        if (isPng(bytes)) {
          png = bytes;
          break;
        }
      }
    } catch {
      // The tool wrote no file: there is no image.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (!png) return null;
  if (png.length > MAX_IMAGE_BYTES)
    throw new Error(
      `the image is ${(png.length / 1048576).toFixed(1)} MB: the limit is ${MAX_IMAGE_BYTES / 1048576} MB`,
    );
  return { name: "", size: png.length, mimeType: "image/png", data: Buffer.from(png).toString("base64") };
}
