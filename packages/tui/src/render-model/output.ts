import { type DiffLine, stepDiff } from "./diff.ts";

/** One row of a step's opened output. `add` and `del` rows carry a diff fill; `more` is the trim note. */
export interface OutLine {
  kind: "plain" | "add" | "del" | "ctx" | "more";
  text: string;
}

export const OUTPUT_LINES = 5;

/** The first five lines, then "… N more lines": the full output stays one key away in review or the log. */
export function trimLines(lines: readonly OutLine[], max = OUTPUT_LINES): OutLine[] {
  if (lines.length <= max) return [...lines];
  return [...lines.slice(0, max), { kind: "more", text: `… ${lines.length - max} more lines` }];
}

const SIGN = { "+": "+ ", "-": "− ", " ": "  " } as const;

function fromDiff(rows: readonly DiffLine[]): OutLine[] {
  return rows
    .filter((r) => r.k !== "h")
    .map((r) => ({
      kind: r.k === "+" ? "add" : r.k === "-" ? "del" : "ctx",
      text: SIGN[r.k as "+" | "-" | " "] + r.text,
    }));
}

/** Rows a step shows when opened: the diff for an edit or write, else the tool's text output. */
export function stepOutput(
  tool: string,
  input: Record<string, unknown> | undefined,
  content: string | undefined,
): OutLine[] {
  const diff = stepDiff(tool, input);
  const text = (content ?? "").replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const all: OutLine[] = diff
    ? fromDiff(diff)
    : (text === "" ? [] : text.split("\n")).map((line) => ({ kind: "plain", text: line }));
  return trimLines(all);
}
