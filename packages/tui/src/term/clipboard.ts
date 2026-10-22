import type { CliRenderer } from "@opentui/core";

/** The system tools that take text on stdin, tried in order. */
const TOOLS: Record<string, string[][]> = {
  win32: [["clip"]],
  darwin: [["pbcopy"]],
  linux: [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]],
};

/** The terminal's own clipboard (OSC 52) first; a system tool when the terminal does not take it. */
export async function copyText(text: string, renderer?: CliRenderer): Promise<void> {
  if (renderer?.copyToClipboardOSC52(text)) return;
  for (const argv of TOOLS[process.platform] ?? []) {
    try {
      const proc = Bun.spawn(argv, { stdin: new Blob([text]), stdout: "ignore", stderr: "ignore" });
      if ((await proc.exited) === 0) return;
    } catch {
      // The tool is not installed: try the next.
    }
  }
  throw new Error("no clipboard: the terminal ignores OSC 52 and no copy tool is installed");
}
