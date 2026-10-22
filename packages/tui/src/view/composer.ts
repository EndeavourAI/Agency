/** The prompt box and what sits on it: the completion list and the image chips. */
import { caret, lines as composerLines } from "../input/composer.ts";
import { padEnd, stringWidth } from "../render-model/width.ts";
import { completion, imageLabel } from "../state/derive.ts";
import type { AppState } from "../state/types.ts";
import { modeColor, type Palette } from "../term/themes.ts";
import { boxRows } from "./ledger.ts";
import { clip, type Row, type Seg, spread } from "./rows.ts";

export const MAX_COMPOSER_LINES = 6;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The text of one line cut to a window `avail` cells wide that keeps the caret in view. */
function window(line: string, col: number, avail: number): { text: string; col: number } {
  if (stringWidth(line) < avail) return { text: line, col };
  let drop = 0;
  const parts = [...graphemes.segment(line)].map((g) => g.segment);
  let cut = 0;
  while (col - drop > avail - 2 && cut < parts.length) {
    drop += stringWidth(parts[cut] as string);
    cut += 1;
  }
  return { text: parts.slice(cut).join(""), col: col - drop };
}

/** One line of the draft with the caret drawn as an inverse cell. */
function withCaret(text: string, col: number, c: Palette): Seg[] {
  const out: Seg[] = [];
  let used = 0;
  let placed = false;
  for (const g of graphemes.segment(text)) {
    const gw = stringWidth(g.segment);
    if (!placed && used >= col) {
      out.push({ t: g.segment, fg: c.bg, bg: c.text });
      placed = true;
    } else out.push({ t: g.segment, fg: c.text });
    used += gw;
  }
  if (!placed) out.push({ t: " ", fg: c.bg, bg: c.text });
  return out;
}

export interface ComposerView {
  rows: Row[];
}

/** The box, 3 rows tall for one line of text and one row more per extra line. */
export function composerBox(
  state: AppState,
  c: Palette,
  w: number,
  opts: { focused: boolean; placeholder: string; joined: boolean },
): Row[] {
  const comp = state.composer;
  const on = comp.shell ? c.you : modeColor(c, state.mode);
  const inner = w - 4;
  const avail = inner - 2;
  const all = composerLines(comp);
  const at = caret(comp);
  const start = Math.max(0, Math.min(at.row - (MAX_COMPOSER_LINES - 1), all.length - MAX_COMPOSER_LINES));
  const shown = all.slice(start, start + MAX_COMPOSER_LINES);
  const glyph: Seg = { t: comp.shell ? "!" : "›", fg: opts.focused ? on : c.muted };
  const rows: Row[] = shown.map((line, i) => {
    const row = start + i;
    const head: Seg = i === 0 && start === 0 ? glyph : { t: " " };
    if (comp.text === "") {
      const p = clip([{ t: opts.placeholder, fg: c.muted }], avail);
      const first = p[0];
      const caretCell: Seg[] =
        opts.focused && first
          ? [
              { t: [...first.t][0] ?? " ", fg: c.bg, bg: c.text },
              { ...first, t: [...first.t].slice(1).join("") },
              ...p.slice(1),
            ]
          : p;
      return [head, { t: " " }, ...caretCell];
    }
    if (row !== at.row || !opts.focused) return [head, { t: " " }, ...clip([{ t: line, fg: c.text }], avail)];
    const win = window(line, at.col, avail);
    return [head, { t: " " }, ...withCaret(win.text, win.col, c)];
  });
  return boxRows(w, rows, opts.focused ? on : c.dim, { joined: opts.joined });
}

/** The completion list above the box: files for `@`, commands for `/`. Selected row on a quiet fill. */
export function completionBox(state: AppState, c: Palette, w: number): Row[] {
  const ac = state.ac;
  if (!ac) return [];
  const items = completion(state);
  const inner = w - 4;
  if (!items.length)
    return boxRows(
      w,
      [[{ t: ac.kind === "@" ? "No file matches." : "No command matches.", fg: c.muted }]],
      c.dim,
      {
        bottom: false,
      },
    );
  const at = Math.min(ac.i, items.length - 1);
  const rows = items.map((it, i) => {
    const on = i === at;
    const labelW = 24;
    const descW = Math.max(0, inner - labelW - 2 - 8 - 2);
    const row = spread(
      inner,
      [
        { t: padEnd(clip([{ t: it.label }], labelW)[0]?.t ?? "", labelW), fg: c.text, b: on },
        { t: "  " },
        ...clip([{ t: it.desc, fg: c.muted }], descW),
      ],
      [{ t: it.meta, fg: c.muted }],
      on ? c.element : undefined,
      2,
    );
    return on ? row.map((s) => ({ ...s, bg: s.bg ?? c.element })) : row;
  });
  return boxRows(w, rows, c.dim, { bottom: false });
}

export function imageChipsBox(state: AppState, c: Palette, w: number): Row[] {
  if (!state.images.length) return [];
  const left: Seg[] = [];
  state.images.forEach((chip, i) => {
    if (i) left.push({ t: "  " });
    left.push({ t: imageLabel(chip, i), fg: c.text }, { t: " ×", fg: c.muted });
  });
  return boxRows(w, [spread(w - 4, left, [{ t: "backspace removes", fg: c.muted }], undefined, 2)], c.dim, {
    bottom: false,
  });
}

/** The box replaced by a note: while an ask waits for y, a or n, or while the daemon is away. */
export function noteBox(c: Palette, w: number, text: string): Row[] {
  return boxRows(w, [[{ t: text, fg: c.muted }]], c.dim);
}
