/** The review screen (ctrl+r): the changed files of the workspace and the diff of one, with the commit box under them. */
import { truncate } from "../render-model/width.ts";
import { reviewFiles } from "../state/derive.ts";
import type { AppState } from "../state/types.ts";
import type { Palette } from "../term/themes.ts";
import { boxRows } from "./ledger.ts";
import { clip, fill, type Row, type Seg, spread } from "./rows.ts";

const LIST_W = 30;
const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

const no = (n: number | undefined, w: number): string =>
  n === undefined ? " ".repeat(w) : String(n).padStart(w);

/** Rows of the body: the header, then the file list and the diff side by side, `h` rows tall in all. */
export function reviewBody(state: AppState, c: Palette, w: number, h: number): Row[] {
  const files = reviewFiles(state);
  const at = Math.min(state.review.file, Math.max(0, files.length - 1));
  const add = files.reduce((n, f) => n + f.add, 0);
  const del = files.reduce((n, f) => n + f.del, 0);
  const head: Row = spread(
    w,
    [
      { t: "review", fg: c.text, b: true },
      { t: `  ${files.length} files · +${add} −${del}`, fg: c.muted },
    ],
    [
      { t: "esc", fg: c.text },
      { t: " back", fg: c.muted },
    ],
    undefined,
    2,
  );
  const left: Row[] = files.length
    ? files.map((f, i) => {
        const on = i === at;
        return spread(
          LIST_W,
          [
            { t: on ? "› " : "  ", fg: on ? c.text : c.muted },
            { t: truncate(baseName(f.path), LIST_W - 12), fg: on ? c.text : c.muted },
          ],
          [
            ...(f.add ? [{ t: `+${f.add}`, fg: c.add }, { t: " " }] : []),
            ...(f.del ? [{ t: `−${f.del}`, fg: c.del }] : []),
          ],
          undefined,
          1,
        );
      })
    : [[{ t: "No changes yet.", fg: c.muted }]];
  const f = files[at];
  const rightW = w - LIST_W - 2;
  const vis = Math.max(1, h - 4);
  const lines = f?.lines ?? [];
  const top = Math.min(state.review.scroll, Math.max(0, lines.length - vis));
  const where =
    lines.length > vis ? `${top + 1}–${Math.min(lines.length, top + vis)} of ${lines.length}` : "";
  const right: Row[] = [
    spread(
      rightW,
      [{ t: f?.path ?? "nothing to review", fg: c.soft }],
      [{ t: where, fg: c.muted }],
      undefined,
      2,
    ),
    [],
  ];
  const numW = Math.max(2, ...lines.map((l) => String(l.newNo ?? l.oldNo ?? 0).length));
  for (const l of lines.slice(top, top + vis)) {
    if (l.k === "h") {
      right.push([{ t: l.text, fg: c.you }]);
      continue;
    }
    const bg = l.k === "+" ? c.addBg : l.k === "-" ? c.delBg : undefined;
    const tone = l.k === "+" ? c.add : l.k === "-" ? c.del : c.muted;
    const sign = l.k === "+" ? "+ " : l.k === "-" ? "− " : "  ";
    const seg: Seg[] = [
      { t: `${no(l.oldNo, numW)} ${no(l.newNo, numW)} `, fg: tone },
      { t: sign, fg: tone },
      { t: l.text, fg: l.k === " " ? c.soft : c.text },
    ];
    right.push(fill(seg, rightW, bg));
  }
  if (f && lines.length === 0) right.push([{ t: "No text diff for this file.", fg: c.muted }]);
  const rows: Row[] = [head, []];
  const body = Math.max(0, h - rows.length);
  for (let i = 0; i < body; i++)
    rows.push([...fill(left[i] ?? [], LIST_W), { t: "  " }, ...clip(right[i] ?? [], rightW)]);
  return rows;
}

/** The commit box: the message that enter commits (the daemon's suggestion), the keys, and after a commit what happened. */
export function commitBox(state: AppState, c: Palette, w: number): Row[] {
  const r = state.review;
  const files = reviewFiles(state);
  const inner = w - 4;
  if (r.committed)
    return boxRows(
      w,
      [
        spread(
          inner,
          [
            { t: "✓ ", fg: c.add },
            { t: r.commitMessage, fg: c.text },
          ],
          [{ t: r.commitNote, fg: c.add }],
          undefined,
          2,
        ),
      ],
      c.dim,
    );
  if (!files.length)
    return boxRows(
      w,
      [
        [
          { t: "✓ ", fg: c.add },
          { t: "Nothing to commit", fg: c.muted },
        ],
      ],
      c.dim,
    );
  const msg = r.commitMessage || `${files.length} file${files.length === 1 ? "" : "s"} changed`;
  const buttons: Seg[] = [
    { t: " enter commit ", fg: c.bg, bg: c.brand },
    { t: "  " },
    { t: " ctrl+enter commit and push ", fg: c.text, bg: c.element },
  ];
  return boxRows(
    w,
    [
      spread(
        inner,
        [
          { t: "✓ ", fg: c.add },
          { t: msg, fg: c.text },
        ],
        buttons,
        undefined,
        2,
      ),
    ],
    c.dim,
  );
}
