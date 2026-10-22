/** Terminal cell width of a string: wide glyphs take 2 cells, combining marks 0. */
export function stringWidth(text: string): number {
  return Bun.stringWidth(text);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Cuts `text` to at most `cols` cells, ending in an ellipsis when it was cut. */
export function truncate(text: string, cols: number): string {
  if (cols <= 0) return "";
  if (stringWidth(text) <= cols) return text;
  let out = "";
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const w = stringWidth(segment);
    if (used + w > cols - 1) break;
    out += segment;
    used += w;
  }
  return `${out}…`;
}

/** Pads with spaces on the right up to `cols` cells (never cuts). */
export function padEnd(text: string, cols: number): string {
  return text + " ".repeat(Math.max(0, cols - stringWidth(text)));
}

/** Hard-wraps one logical line to `cols` cells, breaking at spaces when it can. */
export function wrap(text: string, cols: number): string[] {
  if (cols <= 0) return [text];
  const rows: string[] = [];
  let row = "";
  let rowW = 0;
  let lastSpace = -1;
  for (const { segment } of graphemes.segment(text)) {
    const w = stringWidth(segment);
    if (rowW + w > cols) {
      if (segment === " ") {
        rows.push(row);
        row = "";
        rowW = 0;
        lastSpace = -1;
        continue;
      }
      if (lastSpace > 0) {
        rows.push(row.slice(0, lastSpace));
        row = row.slice(lastSpace + 1);
        rowW = stringWidth(row);
      } else {
        rows.push(row);
        row = "";
        rowW = 0;
      }
      lastSpace = -1;
    }
    if (segment === " ") lastSpace = row.length;
    row += segment;
    rowW += w;
  }
  rows.push(row);
  return rows;
}
