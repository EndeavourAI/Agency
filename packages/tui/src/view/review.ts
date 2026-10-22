/** The review screen (ctrl+r): the changed files of the workspace and the diff of one, with the commit box under them. */
import { parseUnifiedDiff } from "../render-model/diff.ts";
import { truncate } from "../render-model/width.ts";
import type { AppState } from "../state/types.ts";
import type { Palette } from "../term/themes.ts";
import { boxRows } from "./ledger.ts";
import { clip, fill, type Row, type Seg, spread } from "./rows.ts";

const LIST_W = 30;
const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

interface FileView {
  path: string;
  add: number;
  del: number;
  lines: Array<{
    k: "h" | "+" | "-" | " ";
    text: string;
    oldNo?: number | undefined;
    newNo?: number | undefined;
  }>;
}

/** Tracked files with their hunks, then untracked ones as all added. */
export function reviewFiles(state: AppState): FileView[] {
  const r = state.review;
  const diffs = new Map(parseUnifiedDiff(r.diff).map((f) => [f.path, f]));
  const tracked = (r.git?.files ?? [])
    .filter((f) => !r.untracked.some((u) => u.path === f.path))
    .map((f) => {
      const d = diffs.get(f.path);
      return {
        path: f.path,
        add: d?.add ?? f.added ?? 0,
        del: d?.del ?? f.deleted ?? 0,
        lines: d?.lines ?? [],
      };
    });
  const fresh = r.untracked.map((u) => {
    const lines = (u.text ?? "").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return {
      path: u.path,
      add: lines.length,
      del: 0,
      lines: u.text === null ? [] : lines.map((text, i) => ({ k: "+" as const, text, newNo: i + 1 })),
    };
  });
  return [...tracked, ...fresh];
}

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
  const right: Row[] = [[{ t: truncate(f?.path ?? "nothing to review", rightW), fg: c.soft }], []];
  const numW = Math.max(2, ...(f?.lines ?? []).map((l) => String(l.newNo ?? l.oldNo ?? 0).length));
  for (const l of f?.lines ?? []) {
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
  if (f && f.lines.length === 0) right.push([{ t: "No text diff for this file.", fg: c.muted }]);
  const rows: Row[] = [head, []];
  const body = Math.max(0, h - rows.length);
  for (let i = 0; i < body; i++)
    rows.push([...fill(left[i] ?? [], LIST_W), { t: "  " }, ...clip(right[i] ?? [], rightW)]);
  return rows;
}

/** The commit box: what would be committed, and the keys. The daemon has no commit method yet, so a press says so. */
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
          [{ t: r.committed === "pushed" ? "committed and pushed" : "committed", fg: c.add }],
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
  const msg = `${files.length} file${files.length === 1 ? "" : "s"} changed`;
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
