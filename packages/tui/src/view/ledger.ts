/**
 * The transcript as rows: a calm ledger. A turn is the prompt on a steel band, its steps as one-liners, the answer, and one
 * closing row. Everything here is a pure function of a block, a palette and a width.
 */
import { visibleBlocks } from "../render-model/markdown.ts";
import { padEnd, stringWidth, wrap } from "../render-model/width.ts";
import { runningThought, stepView, type Tone, turnFoot, turnStamp, youText } from "../state/derive.ts";
import type { EventBlock, ShellBlock, Turn } from "../state/types.ts";
import type { Palette } from "../term/themes.ts";
import { type Color, clip, fill, type Row, type Seg, spread, words, wrapWords } from "./rows.ts";

export interface LedgerCtx {
  c: Palette;
  /** Cells of the transcript column. */
  w: number;
  /** Animation frame; one step every 140 ms. */
  tick: number;
  now: number;
  offline: boolean;
}

export const BEAD = ["•◦◦", "◦•◦", "◦◦•", "◦•◦"] as const;
export const SPIN = ["◜", "◝", "◞", "◟"] as const;
export const MAX_PROSE = 88;
const OUTPUT_COLS = 7;

export const toneColor = (c: Palette, t: Tone): Color => c[t];
const blank: Row = [];
const ind = (row: Row, n = 3): Row => (row.length ? [{ t: " ".repeat(n) }, ...row] : row);

/** m:ss of a running turn. */
export const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A line `── text ──` for compaction and notices. */
export function eventRows(b: EventBlock, x: LedgerCtx): Row[] {
  const text = clip([{ t: b.text, fg: x.c.muted }], Math.max(0, x.w - 6))[0]?.t ?? "";
  const rule = Math.max(1, x.w - stringWidth(text) - 2);
  const left = Math.floor(rule / 2);
  return [
    [
      { t: "─".repeat(left), fg: x.c.line },
      { t: ` ${text} `, fg: x.c.muted },
      { t: "─".repeat(rule - left), fg: x.c.line },
    ],
  ];
}

/** The scrolled-back marker: how far below the end the view is. */
export function scrollRow(newer: string, x: LedgerCtx): Row {
  const label = `↓ ${newer} · `;
  const mid = stringWidth(label) + "ctrl+end".length + " latest".length;
  const rule = Math.max(2, x.w - mid - 2);
  const left = Math.floor(rule / 2);
  return [
    { t: "─".repeat(left), fg: x.c.line },
    { t: ` ${label}`, fg: x.c.soft },
    { t: "ctrl+end", fg: x.c.text },
    { t: " latest ", fg: x.c.soft },
    { t: "─".repeat(rule - left), fg: x.c.line },
  ];
}

/** A prompt that waits its turn: a dashed row with the reason on the right. */
export function queuedRow(text: string, note: string, x: LedgerCtx): Row {
  const edge: Seg = { t: "┆", fg: x.c.dim };
  const inner = spread(x.w - 4, [{ t: text, fg: x.c.muted }], [{ t: note, fg: x.c.muted }], undefined, 2);
  return [edge, { t: " " }, ...inner, { t: " " }, edge];
}

function band(prefix: string, lines: string[], x: LedgerCtx): Row[] {
  return lines.map((l, i) =>
    fill(
      [
        { t: i === 0 ? prefix : " ".repeat(stringWidth(prefix)), fg: x.c.you },
        { t: l, fg: x.c.text },
      ],
      x.w,
      x.c.youBg,
    ),
  );
}

function bandLines(text: string, w: number): string[] {
  return text.split("\n").flatMap((l) => wrap(l, Math.max(1, w)));
}

/** A `!` line and what it printed: data that goes to the agent, not an answer. */
export function shellRows(b: ShellBlock, x: LedgerCtx): Row[] {
  const rows = band("▌! ", bandLines(b.cmd, x.w - 4), x).map((r) => r);
  const more = b.out.length > 5 ? [`… ${b.out.length - 5} more lines`] : [];
  const out = [...b.out.slice(0, 5), ...more];
  rows.push(blank);
  if (b.status === "running") {
    rows.push(ind([{ t: "running…", fg: x.c.muted }]));
    return rows;
  }
  for (const line of out) rows.push(ind(clip([{ t: line, fg: x.c.muted }], x.w - 3)));
  rows.push(blank);
  rows.push(
    ind([
      { t: b.status === "error" ? "failed" : "done", fg: b.status === "error" ? x.c.del : x.c.muted },
      { t: " · sent to the agent as data", fg: x.c.muted },
    ]),
  );
  return rows;
}

function answerRows(t: Turn, x: LedgerCtx, hasAbove: boolean): Row[] {
  const bw = Math.min(MAX_PROSE, x.w - 3);
  const c = x.c;
  const rows: Row[] = [];
  const list = visibleBlocks(t.answer);
  list.forEach((b, i) => {
    if (b.kind === "text") {
      if (b.gap && i > 0) rows.push(blank);
      const parts: Seg[] = b.parts.map((p) =>
        p.code ? { t: ` ${p.t} `, fg: c.text, bg: c.element } : { t: p.t, fg: c.text },
      );
      const lines = wrapWords(words(parts), b.li ? bw - 2 : bw);
      for (const [j, l] of lines.entries())
        rows.push(b.li ? [{ t: j === 0 ? b.bullet : "  ", fg: c.text }, ...l] : l);
    } else {
      rows.push(blank);
      const lines = b.lines.length ? b.lines : [""];
      for (const l of lines) rows.push(fill([{ t: ` ${l}`, fg: c.soft }], bw, c.panel));
    }
  });
  if (t.status === "running" && !x.offline && rows.length) {
    const last = rows[rows.length - 1] as Row;
    const lastBlock = list[list.length - 1];
    if (lastBlock?.kind === "text") last.push({ t: "▍", fg: c.brand });
  }
  return rows.length && hasAbove ? [blank, ...rows] : rows;
}

/** One turn: prompt band, steps, answer, error and the closing row. */
export function turnRows(
  t: Turn,
  x: LedgerCtx,
  opts: { picked: boolean; copied: string | null; canRetry: boolean },
): Row[] {
  const c = x.c;
  const rows: Row[] = band("▌› ", bandLines(youText(t), x.w - 4), x);
  const gap = (): void => {
    if (rows.length && (rows[rows.length - 1] as Row).length) rows.push(blank);
  };

  if (t.thoughtOpen && t.thinking) {
    gap();
    for (const l of bandLines(t.thinking, Math.min(MAX_PROSE, x.w - 3)))
      rows.push(ind([{ t: l, fg: c.muted, i: true }]));
  }

  const views = t.steps.map((s) => stepView(s, x.offline));
  const answer = answerRows(t, x, views.length > 0);
  if (views.length || answer.length) gap();
  const glyphW = Math.max(6, ...views.map((v) => stringWidth(v.glyph)));
  for (const v of views) {
    rows.push(
      ind(
        clip(
          [
            { t: padEnd(v.glyph, glyphW), fg: toneColor(c, v.tone) },
            { t: " " },
            { t: v.target, fg: c.muted },
            { t: v.meta, fg: toneColor(c, v.metaTone) },
            { t: v.meta && v.add ? " " : "" },
            { t: v.add, fg: c.add },
            { t: v.del, fg: c.del },
          ],
          x.w - 3,
        ),
      ),
    );
    if (v.open) {
      const bw = x.w - 3 - OUTPUT_COLS;
      for (const o of v.out) {
        const bg = o.kind === "add" ? c.addBg : o.kind === "del" ? c.delBg : undefined;
        const fg = o.kind === "add" || o.kind === "del" ? c.text : c.muted;
        rows.push(ind(fill([{ t: ` ${o.text}`, fg }], bw, bg), 3 + OUTPUT_COLS));
      }
    }
  }
  rows.push(...answer.map((r) => ind(r)));

  if (t.status === "error" && t.error) {
    const ew = x.w - 3;
    gap();
    const right: Seg[] = opts.canRetry
      ? [
          { t: "enter", fg: c.text },
          { t: " retry", fg: c.soft },
        ]
      : [];
    rows.push(
      ind(
        fill(
          [{ t: " " }, ...spread(ew - 2, [{ t: t.error.message, fg: c.text }], right, c.delBg, 2)],
          ew,
          c.delBg,
        ),
      ),
    );
  }

  // The closing row: the result on the left; copy, the folded reasoning, wall time and stream rate on the right.
  gap();
  const stamp = turnStamp(t, x.offline);
  const glyph = stamp.glyph === "bead" ? (BEAD[Math.floor(x.tick / 2) % BEAD.length] as string) : stamp.glyph;
  const left: Seg[] = [
    { t: `${glyph} ${stamp.label}`, fg: toneColor(c, stamp.tone), b: stamp.glyph !== "·" },
    { t: stamp.note, fg: c.muted },
  ];
  const right: Seg[] = [];
  if (t.status === "running") {
    if (t.thinking) right.push({ t: runningThought(t, x.offline), fg: c.soft });
    right.push({ t: `${t.thinking ? " " : ""}· ${clock(x.now - t.startedAt)}`, fg: c.muted });
  } else if (t.status !== "waiting") {
    const f = turnFoot(t, opts.copied);
    right.push({ t: f.copyLabel, fg: opts.copied === t.id ? c.add : c.soft });
    if (f.thought) {
      right.push({ t: " · ", fg: c.muted }, { t: f.thought, fg: c.soft });
    }
    if (f.stats) right.push({ t: ` ${f.stats}`, fg: c.muted });
  }
  const cw = x.w - 3;
  const close = spread(cw, left, right, opts.picked ? c.element : undefined, 1);
  rows.push(
    ind(
      opts.picked ? close.map((s) => ({ ...s, bg: c.element, fg: s.fg === c.muted ? c.text : s.fg })) : close,
    ),
  );
  return rows;
}

/** The ask that takes over the prompt: what runs, and the keys that answer it. */
export function approvalRows(
  a: { tool: string; title: string; command?: string; path?: string },
  x: LedgerCtx,
): Row[] {
  const c = x.c;
  const verb = a.tool === "bash" ? "Run" : a.tool === "write" ? "Write" : a.tool === "edit" ? "Edit" : a.tool;
  const subject = a.command ?? a.path ?? a.title;
  const inner = x.w - 4;
  const head = clip(
    [
      { t: "? ", fg: c.auto, b: true },
      { t: `${verb} `, fg: c.text },
      { t: ` ${subject} `, fg: c.text, bg: c.element },
      { t: "  no rule allows it yet", fg: c.muted },
    ],
    inner,
  );
  const keys: Row = [
    { t: " y allow once ", fg: c.bg, bg: c.brand },
    { t: "  " },
    { t: " a always for this command ", fg: c.text, bg: c.element },
    { t: "  " },
    { t: " n deny ", fg: c.text, bg: c.element },
  ];
  return boxRows(x.w, [head, clip(keys, inner)], c.dim);
}

export interface BoxSides {
  top?: boolean;
  bottom?: boolean;
  /** The top border is a joint under another box. */
  joined?: boolean;
}

/** A box of whole cells: border, a column of padding, rows. `rows` are already cut to `w - 4` cells. */
export function boxRows(w: number, inner: Row[], edge: Color, sides: BoxSides = {}): Row[] {
  const { top = true, bottom = true, joined = false } = sides;
  const bar = "─".repeat(Math.max(0, w - 2));
  const out: Row[] = [];
  if (top) out.push([{ t: `${joined ? "├" : "┌"}${bar}${joined ? "┤" : "┐"}`, fg: edge }]);
  for (const r of inner) out.push([{ t: "│ ", fg: edge }, ...fill(r, w - 4), { t: " │", fg: edge }]);
  if (bottom) out.push([{ t: `└${bar}┘`, fg: edge }]);
  return out;
}
