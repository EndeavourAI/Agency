/**
 * Terminal rows as plain data: styled segments cut and padded to exact cell widths. The views draw these rows
 * one `<text>` each, so the grid is decided here, in JS, and not by the layout engine's text measuring.
 */
import { stringWidth, truncate } from "../render-model/width.ts";

export type Color = string | import("@opentui/core").RGBA;

export interface Seg {
  t: string;
  fg?: Color;
  bg?: Color;
  b?: boolean;
  i?: boolean;
}

export type Row = Seg[];

export const segsWidth = (segs: readonly Seg[]): number => segs.reduce((n, s) => n + stringWidth(s.t), 0);

/** Cuts a row to `w` cells; the last segment that does not fit ends in an ellipsis. */
export function clip(segs: readonly Seg[], w: number): Row {
  const out: Row = [];
  let used = 0;
  for (const s of segs) {
    const sw = stringWidth(s.t);
    if (used + sw <= w) {
      out.push(s);
      used += sw;
      continue;
    }
    const room = w - used;
    if (room > 0) out.push({ ...s, t: truncate(s.t, room) });
    break;
  }
  return out;
}

/** `left` at the start and `right` at the end of a row `w` cells wide, `gap` cells apart at least; the left side gives way. */
export function spread(
  w: number,
  left: readonly Seg[],
  right: readonly Seg[] = [],
  fill?: Color,
  gap = 1,
): Row {
  const rw = segsWidth(right);
  const room = right.length ? Math.max(0, w - rw - gap) : w;
  const l = clip(left, room);
  const pad = Math.max(0, w - segsWidth(l) - rw);
  return [...l, { t: " ".repeat(pad), ...(fill === undefined ? {} : { bg: fill }) }, ...right];
}

/** A row padded with spaces to exactly `w` cells; `bg` goes under every segment that has none of its own. */
export function fill(segs: readonly Seg[], w: number, bg?: Color): Row {
  const c = clip(segs, w);
  const pad = w - segsWidth(c);
  const row = bg === undefined ? c : onBg(c, bg);
  return pad > 0 ? [...row, { t: " ".repeat(pad), ...(bg === undefined ? {} : { bg }) }] : row;
}

/** The same style on every segment that sets none of its own: how a band paints its fill under its text. */
export const onBg = (segs: readonly Seg[], bg: Color): Row =>
  segs.map((s) => (s.bg === undefined ? { ...s, bg } : s));

/** Splits styled text into words: a run of non-space characters stays one word across segment edges. */
export function words(parts: readonly Seg[]): Row[] {
  const out: Row[] = [];
  let open = false;
  for (const p of parts) {
    for (const chunk of p.t.split(/(\s+)/)) {
      if (chunk === "") continue;
      if (/^\s+$/.test(chunk)) {
        open = false;
        continue;
      }
      if (open) (out[out.length - 1] as Row).push({ ...p, t: chunk });
      else out.push([{ ...p, t: chunk }]);
      open = true;
    }
  }
  return out;
}

/** Greedy word wrap of styled words; a word longer than `w` is cut. */
export function wrapWords(list: readonly Row[], w: number): Row[] {
  const rows: Row[] = [];
  let cur: Row = [];
  let used = 0;
  for (const word of list) {
    const ww = segsWidth(word);
    if (used > 0 && used + 1 + ww > w) {
      rows.push(cur);
      cur = [];
      used = 0;
    }
    if (used > 0) {
      cur.push({ t: " " });
      used += 1;
    }
    const piece = ww > w ? clip(word, w) : word;
    cur.push(...piece);
    used += segsWidth(piece);
  }
  if (cur.length) rows.push(cur);
  return rows.length ? rows : [[]];
}
