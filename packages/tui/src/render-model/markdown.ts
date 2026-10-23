/**
 * Streaming markdown for answers: paragraphs, headings, lists, quotes, rules, GFM tables, fenced code and inline styles.
 * Settled blocks never change again; the open blocks (the unfinished line, an unclosed fence, a growing table) are still growing.
 */
export interface InlinePart {
  t: string;
  code: boolean;
  b?: true;
  i?: true;
  s?: true;
  /** A link's url: drawn muted, after the text. */
  muted?: true;
}

export type Align = "left" | "center" | "right";

export type MdBlock =
  | {
      kind: "text";
      li: boolean;
      bullet: string;
      parts: InlinePart[];
      gap: boolean;
      /** Cells of nesting for a list item. */
      indent: number;
      /** `>` depth. */
      quote: number;
      /** 1..6 for a heading, else 0. */
      heading: number;
    }
  | { kind: "code"; lang: string; lines: string[]; gap: true }
  | { kind: "rule"; gap: boolean }
  | { kind: "table"; align: Align[]; head: InlinePart[][]; rows: InlinePart[][][]; gap: boolean };

interface Fence {
  lang: string;
  lines: string[];
}

/** A table that has opened: `align` stays null until the separator row confirms the header. */
interface Table {
  raw: string;
  head: string[];
  align: Align[] | null;
  rows: string[][];
}

interface Draft {
  settled: MdBlock[];
  fence: Fence | null;
  table: Table | null;
}

export interface MdState extends Draft {
  /** Raw text of the unfinished line, or of the last line before a newline arrives. */
  tail: string;
}

export const emptyMd: MdState = { settled: [], tail: "", fence: null, table: null };

const INLINE =
  /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*(?=\S)(.+?)(?<=\S)\*\*(?!\*)|(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)|~~(?=\S)(.+?)(?<=\S)~~|\*(?=[^\s*])(.+?)(?<=[^\s*])\*|(?<!\w)_(?=[^\s_])(.+?)(?<=[^\s_])_(?!\w)/g;

type Style = { b?: true; i?: true; s?: true };

export function inline(text: string, st: Style = {}): InlinePart[] {
  const out: InlinePart[] = [];
  const plain = (t: string): void => {
    if (t) out.push({ t, code: false, ...st });
  };
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    plain(text.slice(at, m.index));
    at = m.index + m[0].length;
    const bold = m[4] ?? m[5];
    const em = m[7] ?? m[8];
    if (m[1] !== undefined) out.push({ t: m[1], code: true, ...st });
    else if (m[2] !== undefined) {
      out.push(...inline(m[2], st));
      if (m[2] !== m[3]) out.push({ t: ` (${m[3]})`, code: false, muted: true });
    } else if (bold !== undefined) out.push(...inline(bold, { ...st, b: true }));
    else if (m[6] !== undefined) out.push(...inline(m[6], { ...st, s: true }));
    else if (em !== undefined) out.push(...inline(em, { ...st, i: true }));
  }
  plain(text.slice(at));
  return out;
}

const RULE = /^ {0,3}([-*_])(?: *\1){2,} *$/;
const HEADING = /^ {0,3}(#{1,6}) +(.+?)(?: +#+)? *$/;
const ITEM = /^([ \t]*)(?:([-*+])|(\d{1,9})[.)]) +(.*)$/;
const TASK = /^\[([ xX])\] +(.*)$/;

/** One line as a block: rule, heading, list item or paragraph, inside any `>` depth. Null for a blank line. */
function textBlock(line: string, prev: MdBlock | undefined): MdBlock | null {
  let quote = 0;
  let rest = line;
  for (let m = /^ {0,3}> ?/.exec(rest); m; m = /^ {0,3}> ?/.exec(rest)) {
    rest = rest.slice(m[0].length);
    quote++;
  }
  if (!rest.trim()) return null;
  const first = prev === undefined;
  if (RULE.test(rest)) return { kind: "rule", gap: !first };
  const h = HEADING.exec(rest);
  if (h) {
    const level = (h[1] as string).length;
    return {
      kind: "text",
      li: false,
      bullet: "",
      parts: inline(h[2] as string),
      gap: !first,
      indent: 0,
      quote,
      heading: level,
    };
  }
  const it = ITEM.exec(rest);
  const prevText = prev?.kind === "text" ? prev : undefined;
  if (it) {
    const task = TASK.exec(it[4] as string);
    const bullet = it[3] ? `${Number(it[3])}. ` : task ? (task[1] === " " ? "[ ] " : "[x] ") : "• ";
    return {
      kind: "text",
      li: true,
      bullet,
      parts: inline(task ? (task[2] as string) : (it[4] as string)),
      gap: !first && !prevText?.li,
      indent: (it[1] as string).replace(/\t/g, "    ").length,
      quote,
      heading: 0,
    };
  }
  return {
    kind: "text",
    li: false,
    bullet: "",
    parts: inline(rest),
    gap: !first && !(quote > 0 && prevText !== undefined && prevText.quote > 0),
    indent: 0,
    quote,
    heading: 0,
  };
}

function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

const fit = (row: string[], n: number): string[] => Array.from({ length: n }, (_, i) => row[i] ?? "");

/** The alignments of a `|---|:-:|` separator row with `n` columns, or null when the line is not one. */
function separator(line: string, n: number): Align[] | null {
  const cs = cells(line);
  if (cs.length !== n || !cs.every((c) => /^:?-+:?$/.test(c))) return null;
  return cs.map((c) =>
    c.startsWith(":") ? (c.endsWith(":") ? "center" : "left") : c.endsWith(":") ? "right" : "left",
  );
}

function push(d: Draft, b: MdBlock | null): void {
  if (b) d.settled.push(b);
}

/** A header the separator never confirmed is a plain line after all. */
function release(d: Draft): void {
  const t = d.table as Table;
  d.table = null;
  push(d, textBlock(t.raw, d.settled.at(-1)));
}

function settleTable(d: Draft): void {
  const t = d.table as Table;
  d.table = null;
  d.settled.push({
    kind: "table",
    align: t.align ?? [],
    head: t.head.map((c) => inline(c)),
    rows: t.rows.map((r) => r.map((c) => inline(c))),
    gap: d.settled.length > 0,
  });
}

/** Feeds one complete line into a draft that the caller owns: its arrays are copies, so they grow in place. */
function step(d: Draft, text: string): void {
  const fence = /^```(.*)$/.exec(text);
  if (d.fence) {
    if (fence) {
      d.settled.push({ kind: "code", lang: d.fence.lang, lines: d.fence.lines, gap: true });
      d.fence = null;
    } else d.fence.lines.push(text);
    return;
  }
  const t = d.table;
  if (t) {
    if (!t.align) {
      const align = separator(text, t.head.length);
      if (align) {
        t.align = align;
        return;
      }
      release(d);
    } else if (text.includes("|")) {
      t.rows.push(fit(cells(text), t.head.length));
      return;
    } else settleTable(d);
  }
  if (fence) d.fence = { lang: (fence[1] ?? "").trim(), lines: [] };
  else if (text.includes("|")) d.table = { raw: text, head: cells(text), align: null, rows: [] };
  else push(d, textBlock(text, d.settled.at(-1)));
}

/** Settles what a draft still holds: an unclosed fence, a table, a header waiting for its separator. */
function flush(d: Draft): void {
  if (d.fence) d.settled.push({ kind: "code", lang: d.fence.lang, lines: d.fence.lines, gap: true });
  d.fence = null;
  if (d.table) (d.table.align ? settleTable : release)(d);
}

const copyOf = (state: MdState, settled: MdBlock[]): Draft => ({
  settled,
  fence: state.fence ? { lang: state.fence.lang, lines: state.fence.lines.slice() } : null,
  table: state.table ? { ...state.table, rows: state.table.rows.slice() } : null,
});

/**
 * Appends streamed text. Complete lines settle (code at its closing fence, a table at its first other line); the rest stays open.
 * One copy per push, so a delta of many lines costs its own size, not its square; one copy per delta stays linear in the blocks so far.
 */
export function pushMd(state: MdState, delta: string): MdState {
  const parts = (state.tail + delta).split("\n");
  const tail = parts.pop() ?? "";
  if (parts.length === 0) return { ...state, tail };
  const d = copyOf(state, state.settled.slice());
  for (const l of parts) step(d, l);
  return { ...d, tail };
}

// A header line waits for its separator; the separator's first characters must not flip it back to text.
const SEPARATOR_PREFIX = /^[\s|:-]+$/;

/** The blocks still growing: an unclosed fence, a table, the unfinished line. Empty when there are none. */
export function openBlocks(state: MdState): MdBlock[] {
  const d = copyOf(state, state.settled.slice(-1));
  const base = d.settled.length;
  const waiting = d.table !== null && d.table.align === null && SEPARATOR_PREFIX.test(state.tail);
  if (state.tail !== "" && !waiting) step(d, state.tail);
  flush(d);
  return d.settled.slice(base);
}

/** Settles everything: the end of the answer. */
export function finishMd(state: MdState): MdState {
  const d = copyOf(state, state.settled.slice());
  if (state.tail !== "") step(d, state.tail);
  flush(d);
  return { ...d, tail: "" };
}

/** All blocks of a finished text, as the canvas `md(text)`. */
export function renderMd(text: string): MdBlock[] {
  return finishMd(pushMd(emptyMd, text)).settled;
}

/** Settled blocks plus the open ones: what a view draws while the answer streams. */
export function visibleBlocks(state: MdState): MdBlock[] {
  const open = openBlocks(state);
  return open.length ? [...state.settled, ...open] : state.settled;
}
