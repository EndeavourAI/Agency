/** Markdown blocks as ledger rows: pure functions of a block, a palette and a width. */
import type { Align, InlinePart, MdBlock } from "../render-model/markdown.ts";
import { stringWidth, wrap } from "../render-model/width.ts";
import type { Palette } from "../term/themes.ts";
import { type Color, clip, fill, type Row, type Seg, segsWidth, words, wrapWords } from "./rows.ts";

const blank: Row = [];

function segs(parts: readonly InlinePart[], c: Palette, fg: Color = c.text, bold = false): Seg[] {
  return parts.map((p) =>
    p.code
      ? { t: ` ${p.t} `, fg: c.text, bg: c.element }
      : {
          t: p.t,
          fg: p.muted ? c.muted : fg,
          ...(p.b || bold ? { b: true } : {}),
          ...(p.i ? { i: true } : {}),
          ...(p.s ? { s: true } : {}),
        },
  );
}

/** Wraps styled words to `w` cells; a word wider than `w` is split across rows, never cut. */
function wrapCell(parts: Seg[], w: number): Row[] {
  const list = words(parts).flatMap((word) => {
    const one = word[0];
    if (segsWidth(word) <= w || !one || word.length > 1) return [word];
    return wrap(one.t, w).map((t): Row => [{ ...one, t }]);
  });
  return wrapWords(list, w);
}

/** Column widths for `n` columns that want `want` cells each, shrunk (widest first) to fit `room` cells in all. */
function shrink(want: number[], room: number): number[] {
  const widths = want.slice();
  for (const floor of [3, 1]) {
    for (let sum = widths.reduce((a, b) => a + b, 0); sum > room; sum--) {
      const widest = widths.indexOf(Math.max(...widths));
      if ((widths[widest] as number) <= floor) break;
      widths[widest] = (widths[widest] as number) - 1;
    }
  }
  return widths;
}

const edge = (l: string, m: string, r: string, widths: number[]): string =>
  l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;

function place(row: Row, w: number, align: Align): Row {
  const pad = Math.max(0, w - segsWidth(row));
  const left = align === "right" ? pad : align === "center" ? Math.floor(pad / 2) : 0;
  return [{ t: " ".repeat(left) }, ...row, { t: " ".repeat(pad - left) }];
}

/** A GFM table as a boxed grid, `w` cells wide at most: columns shrink and cell text wraps inside its cell. */
export function tableRows(b: Extract<MdBlock, { kind: "table" }>, w: number, c: Palette): Row[] {
  const n = b.head.length;
  const lines = [b.head, ...b.rows].map((r, ri) => r.map((cell) => segs(cell, c, c.text, ri === 0)));
  const want = Array.from({ length: n }, (_, i) =>
    Math.max(1, ...lines.map((r) => segsWidth(r[i] as Seg[]))),
  );
  const widths = shrink(want, w - (3 * n + 1));
  const line = (t: string): Row => clip([{ t, fg: c.dim }], w);
  const bar: Seg = { t: "│", fg: c.dim };
  const out: Row[] = [line(edge("┌", "┬", "┐", widths))];
  lines.forEach((r, ri) => {
    const wrapped = r.map((cell, i) => wrapCell(cell, widths[i] as number));
    const height = Math.max(...wrapped.map((x) => x.length));
    for (let k = 0; k < height; k++) {
      const row: Row = [bar];
      for (const [i, cell] of wrapped.entries())
        row.push(
          { t: " " },
          ...place(cell[k] ?? [], widths[i] as number, b.align[i] ?? "left"),
          { t: " " },
          bar,
        );
      out.push(clip(row, w));
    }
    if (ri === 0) out.push(line(edge("├", "┼", "┤", widths)));
  });
  out.push(line(edge("└", "┴", "┘", widths)));
  return out;
}

/** The rows of one block; `bw` is the prose width, `full` the whole column that tables may use. */
export function blockRows(b: MdBlock, first: boolean, bw: number, full: number, c: Palette): Row[] {
  const rows: Row[] = [];
  if (b.kind === "code") {
    rows.push(blank);
    for (const l of b.lines.length ? b.lines : [""])
      rows.push(fill([{ t: ` ${l}`, fg: c.soft }], bw, c.panel));
    return rows;
  }
  if (b.gap && !first) rows.push(blank);
  if (b.kind === "rule") rows.push([{ t: "─".repeat(Math.max(1, bw)), fg: c.dim }]);
  else if (b.kind === "table") rows.push(...tableRows(b, full, c));
  else {
    const head = b.heading > 0;
    const fg = head ? (b.heading <= 2 ? c.brand : c.text) : b.quote > 0 ? c.soft : c.text;
    const lead: Row = [
      ...(b.quote > 0 ? [{ t: "│ ".repeat(b.quote), fg: c.dim }] : []),
      ...(b.indent > 0 ? [{ t: " ".repeat(b.indent) }] : []),
    ];
    const bulletW = stringWidth(b.bullet);
    const room = Math.max(1, bw - segsWidth(lead) - bulletW);
    const lines = wrapWords(words(segs(b.parts, c, fg, head)), room);
    for (const [j, l] of lines.entries())
      rows.push([
        ...lead,
        ...(bulletW ? [{ t: j === 0 ? b.bullet : " ".repeat(bulletW), fg: c.text }] : []),
        ...l,
      ]);
  }
  return rows;
}
