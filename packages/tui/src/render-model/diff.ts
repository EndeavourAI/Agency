/** Diff rows: `h` hunk header, `+` added, `-` removed, ` ` context. Numbers are 1-based, absent when unknown. */
export interface DiffLine {
  k: "h" | "+" | "-" | " ";
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface FileDiff {
  path: string;
  lines: DiffLine[];
  add: number;
  del: number;
}

const split = (text: string): string[] => (text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n"));

/** Rows of one search/replace hunk: the common head and tail are context, the middle is `-` then `+`. */
export function hunkLines(oldText: string, newText: string): DiffLine[] {
  const a = split(oldText);
  const b = split(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a.at(-1 - tail) === b.at(-1 - tail)) tail++;
  const rows: DiffLine[] = [];
  for (const t of a.slice(0, head)) rows.push({ k: " ", text: t });
  for (const t of a.slice(head, a.length - tail)) rows.push({ k: "-", text: t });
  for (const t of b.slice(head, b.length - tail)) rows.push({ k: "+", text: t });
  for (const t of a.slice(a.length - tail)) rows.push({ k: " ", text: t });
  return rows;
}

export function diffStats(lines: readonly DiffLine[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.k === "+") add++;
    else if (l.k === "-") del++;
  }
  return { add, del };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The change an `edit` or `write` call makes, read from its input (the daemon sends no diff with the step).
 * Null for any other tool or an input without the expected fields.
 */
export function stepDiff(tool: string, input: Record<string, unknown> | undefined): DiffLine[] | null {
  if (!input) return null;
  if (tool === "write" && typeof input.content === "string")
    return split(input.content).map((text) => ({ k: "+", text }));
  if (tool !== "edit") return null;
  if (Array.isArray(input.hunks)) {
    const rows: DiffLine[] = [];
    for (const h of input.hunks as Array<Record<string, unknown>>)
      rows.push(...hunkLines(str(h.oldText), str(h.newText)));
    return rows;
  }
  if (typeof input.oldText === "string" || typeof input.newText === "string")
    return hunkLines(str(input.oldText), str(input.newText));
  return null;
}

/** Parses `git diff` output (git_diff) into per-file rows with real line numbers. */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | undefined;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
    if (head) {
      cur = { path: head[2] ?? "", lines: [], add: 0, del: 0 };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      cur.lines.push({ k: "h", text: raw });
      continue;
    }
    if (cur.lines.length === 0) continue; // file header lines (index, ---, +++, mode) before the first hunk
    if (raw.startsWith("+")) {
      cur.lines.push({ k: "+", text: raw.slice(1), newNo: newNo++ });
      cur.add++;
    } else if (raw.startsWith("-")) {
      cur.lines.push({ k: "-", text: raw.slice(1), oldNo: oldNo++ });
      cur.del++;
    } else if (raw.startsWith(" ")) {
      cur.lines.push({ k: " ", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return files;
}
