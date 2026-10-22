/**
 * The prompt buffer: multi-line text and a caret, as pure functions over an immutable value.
 * `shell` is the `!` mode: its text is a command, not a prompt.
 */
import { stringWidth } from "../render-model/width.ts";

export interface Composer {
  text: string;
  /** UTF-16 offset of the caret, always on a grapheme boundary. */
  cursor: number;
  shell: boolean;
}

export const emptyComposer: Composer = { text: "", cursor: 0, shell: false };

const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Reach of the grapheme search around the caret: a 1 MB paste must not be segmented to move or delete one character. */
const NEAR = 64;

/** Grapheme starts within NEAR of `at`. A window cut mid-text may split its first cluster, so its start is not trusted. */
function boundsNear(text: string, at: number): number[] {
  const from = Math.max(0, at - NEAR);
  const to = Math.min(text.length, at + NEAR);
  const out: number[] = [];
  for (const s of seg.segment(text.slice(from, to))) out.push(from + s.index);
  if (from > 0) out.shift();
  if (to === text.length) out.push(to);
  return out;
}

function prevBound(text: string, at: number): number {
  let prev = Math.max(0, at - NEAR);
  for (const b of boundsNear(text, at)) {
    if (b >= at) return prev;
    prev = b;
  }
  return prev;
}

function nextBound(text: string, at: number): number {
  for (const b of boundsNear(text, at)) if (b > at) return b;
  return Math.min(text.length, at + NEAR);
}

export function setText(c: Composer, text: string, cursor = text.length): Composer {
  return { ...c, text, cursor };
}

/** Inserts typed or pasted text at the caret; a typed `!` in an empty prompt switches to shell mode, a pasted one stays text. */
export function insert(c: Composer, text: string, pasted = false): Composer {
  const clean = text.replace(/\r\n?/g, "\n");
  if (!pasted && !c.shell && c.text === "" && clean.startsWith("!")) {
    return insert({ ...c, shell: true }, clean.slice(1));
  }
  return {
    ...c,
    text: c.text.slice(0, c.cursor) + clean + c.text.slice(c.cursor),
    cursor: c.cursor + clean.length,
  };
}

export const newline = (c: Composer): Composer => insert(c, "\n");

/** `\` then enter is a new line: returns the buffer with it replaced, or null. A path end (`C:\`, `a\\`, `a/\`) and shell text send. */
export function continueLine(c: Composer): Composer | null {
  if (c.shell || c.cursor === 0 || c.text[c.cursor - 1] !== "\\") return null;
  if (/[:\\/]/.test(c.text[c.cursor - 2] ?? "")) return null;
  return {
    ...c,
    text: `${c.text.slice(0, c.cursor - 1)}\n${c.text.slice(c.cursor)}`,
    cursor: c.cursor,
  };
}

export function backspace(c: Composer): Composer {
  if (c.cursor === 0) return c;
  const from = prevBound(c.text, c.cursor);
  return { ...c, text: c.text.slice(0, from) + c.text.slice(c.cursor), cursor: from };
}

export function del(c: Composer): Composer {
  if (c.cursor >= c.text.length) return c;
  const to = nextBound(c.text, c.cursor);
  return { ...c, text: c.text.slice(0, c.cursor) + c.text.slice(to) };
}

export const left = (c: Composer): Composer => ({ ...c, cursor: prevBound(c.text, c.cursor) });
export const right = (c: Composer): Composer => ({ ...c, cursor: nextBound(c.text, c.cursor) });

function lineStart(text: string, at: number): number {
  return text.lastIndexOf("\n", at - 1) + 1;
}

function lineEnd(text: string, at: number): number {
  const i = text.indexOf("\n", at);
  return i === -1 ? text.length : i;
}

export const home = (c: Composer): Composer => ({ ...c, cursor: lineStart(c.text, c.cursor) });
export const end = (c: Composer): Composer => ({ ...c, cursor: lineEnd(c.text, c.cursor) });

function wordLeftAt(text: string, at: number): number {
  let i = at;
  while (i > 0 && /\s/.test(text[i - 1] as string)) i--;
  while (i > 0 && !/\s/.test(text[i - 1] as string)) i--;
  return i;
}

function wordRightAt(text: string, at: number): number {
  let i = at;
  while (i < text.length && /\s/.test(text[i] as string)) i++;
  while (i < text.length && !/\s/.test(text[i] as string)) i++;
  return i;
}

export const wordLeft = (c: Composer): Composer => ({ ...c, cursor: wordLeftAt(c.text, c.cursor) });
export const wordRight = (c: Composer): Composer => ({ ...c, cursor: wordRightAt(c.text, c.cursor) });

export function deleteWord(c: Composer): Composer {
  const from = wordLeftAt(c.text, c.cursor);
  return { ...c, text: c.text.slice(0, from) + c.text.slice(c.cursor), cursor: from };
}

export function deleteToStart(c: Composer): Composer {
  const from = lineStart(c.text, c.cursor);
  // At a line start, ctrl+u joins with the line above instead of doing nothing.
  const cut = from === c.cursor && from > 0 ? from - 1 : from;
  return { ...c, text: c.text.slice(0, cut) + c.text.slice(c.cursor), cursor: cut };
}

export function deleteToEnd(c: Composer): Composer {
  const to = lineEnd(c.text, c.cursor);
  const cut = to === c.cursor && to < c.text.length ? to + 1 : to;
  return { ...c, text: c.text.slice(0, c.cursor) + c.text.slice(cut) };
}

export interface CaretPos {
  row: number;
  /** Cell column of the caret in its row. */
  col: number;
}

export const lines = (c: Composer): string[] => c.text.split("\n");

export function caret(c: Composer): CaretPos {
  const before = c.text.slice(0, c.cursor);
  const row = before.split("\n").length - 1;
  return { row, col: stringWidth(before.slice(lineStart(c.text, c.cursor))) };
}

function offsetAtCol(text: string, start: number, endAt: number, col: number): number {
  let w = 0;
  for (const g of seg.segment(text.slice(start, endAt))) {
    const cw = stringWidth(g.segment);
    if (w + cw > col) return start + g.index;
    w += cw;
  }
  return endAt;
}

/** Moves the caret one row up, keeping its cell column; false in `moved` when already on the first row. */
export function up(c: Composer): { c: Composer; moved: boolean } {
  const start = lineStart(c.text, c.cursor);
  if (start === 0) return { c, moved: false };
  const { col } = caret(c);
  const prevStart = lineStart(c.text, start - 1);
  return { c: { ...c, cursor: offsetAtCol(c.text, prevStart, start - 1, col) }, moved: true };
}

export function down(c: Composer): { c: Composer; moved: boolean } {
  const e = lineEnd(c.text, c.cursor);
  if (e >= c.text.length) return { c, moved: false };
  const { col } = caret(c);
  const nextEnd = lineEnd(c.text, e + 1);
  return { c: { ...c, cursor: offsetAtCol(c.text, e + 1, nextEnd, col) }, moved: true };
}

export const isEmpty = (c: Composer): boolean => c.text === "";

/** The trimmed text a submit sends. */
export function submitted(c: Composer): string {
  return c.text.trim();
}
