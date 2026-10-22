import type { CliRenderer } from "@opentui/core";

/** A helper that has not exited by now is stuck: it is killed so a copy or paste cannot hang for ever. */
export const TOOL_MS = 10_000;

/** The system tools that take text on stdin, tried in order. */
const TOOLS: Record<string, string[][]> = {
  win32: [["clip"]],
  darwin: [["pbcopy"]],
  linux: [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]],
};

/** Runs a tool with `input` on stdin; its exit code. */
export type Feed = (argv: string[], input: Uint8Array) => Promise<number>;

const feed: Feed = async (argv, input) => {
  const proc = Bun.spawn(argv, { stdin: new Blob([input]), stdout: "ignore", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), TOOL_MS);
  try {
    return await proc.exited;
  } finally {
    clearTimeout(timer);
  }
};

/** clip.exe reads its input in the OEM code page unless the text starts with a UTF-16LE byte order mark. */
const encode = (tool: string | undefined, text: string): Uint8Array =>
  tool === "clip"
    ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])
    : new TextEncoder().encode(text);

/** The terminal's own clipboard (OSC 52) first; a system tool when the terminal does not take it. */
export async function copyText(
  text: string,
  renderer?: CliRenderer,
  platform: string = process.platform,
  run: Feed = feed,
): Promise<void> {
  if (renderer?.copyToClipboardOSC52(text)) return;
  for (const argv of TOOLS[platform] ?? []) {
    try {
      if ((await run(argv, encode(argv[0], text))) === 0) return;
    } catch {
      // The tool is not installed: try the next.
    }
  }
  throw new Error("no clipboard: the terminal ignores OSC 52 and no copy tool is installed");
}
