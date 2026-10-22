/** The details pane (ctrl+d, from 120 columns): tasks, context, changes and the run, all from the daemon. */
import { padEnd, wrap } from "../render-model/width.ts";
import { ctxPercent, current, tasks } from "../state/derive.ts";
import { formatCost, formatTokens } from "../state/format.ts";
import type { AppState } from "../state/types.ts";
import type { Palette } from "../term/themes.ts";
import { modelName } from "./chrome.ts";
import { toneColor } from "./ledger.ts";
import { clip, type Row, type Seg, spread } from "./rows.ts";

export const DETAILS_W = 36;

const head = (title: string, right: Seg[], w: number, c: Palette): Row =>
  spread(w, [{ t: title, fg: c.text, b: true }], right, undefined, 1).map((s) =>
    s.fg === undefined ? { ...s, fg: c.muted } : s,
  );

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

export function detailsRows(state: AppState, c: Palette, w = DETAILS_W): Row[] {
  const s = current(state);
  const rows: Row[] = [];
  const todo = tasks(s);
  const done = todo.filter((t) => t.mark === "✓").length;
  rows.push(head("tasks", todo.length ? [{ t: `${done} of ${todo.length} done`, fg: c.muted }] : [], w, c));
  for (const t of todo) {
    const mark = t.mark === "✓" ? c.add : t.mark === "▸" ? c.brand : c.dim;
    for (const [i, l] of wrap(t.text, w - 3).entries())
      rows.push([
        { t: i === 0 ? `${t.mark}  ` : "   ", fg: mark },
        { t: l, fg: toneColor(c, t.tone), b: t.mark === "▸" },
      ]);
  }
  if (!todo.length)
    for (const l of wrap("No task list yet. The agent writes one for longer work.", w))
      rows.push([{ t: l, fg: c.muted }]);

  rows.push([]);
  const pct = ctxPercent(s);
  rows.push(head("context", pct === null ? [] : [{ t: `${pct}%`, fg: c.muted }], w, c));
  const st = s?.status;
  if (st?.contextLimit) {
    const at = st.compactAt ? ` · compacts at ${formatTokens(st.compactAt)}` : "";
    rows.push([
      { t: `${formatTokens(st.contextTokens)} of ${formatTokens(st.contextLimit)}${at}`, fg: c.soft },
    ]);
    const n = Math.min(w, 34);
    const on = Math.round(((pct ?? 0) / 100) * n);
    rows.push([
      { t: "━".repeat(on), fg: (pct ?? 0) >= 80 ? c.del : c.soft },
      { t: "━".repeat(n - on), fg: c.line },
    ]);
  } else rows.push([{ t: "no data yet", fg: c.muted }]);

  rows.push([]);
  const files = state.review.git?.files ?? [];
  rows.push(
    head(
      "changes",
      [
        { t: "ctrl+r", fg: c.soft },
        { t: " review", fg: c.muted },
      ],
      w,
      c,
    ),
  );
  for (const f of files.slice(0, 6)) {
    rows.push(
      spread(
        w,
        [{ t: baseName(f.path), fg: c.soft }],
        [
          ...(f.added ? [{ t: `+${f.added}`, fg: c.add }, { t: " " }] : []),
          ...(f.deleted ? [{ t: `−${f.deleted}`, fg: c.del }] : []),
        ],
        undefined,
        1,
      ),
    );
  }
  if (files.length > 6) rows.push([{ t: `… ${files.length - 6} more`, fg: c.muted }]);
  if (!files.length) rows.push([{ t: "No changes.", fg: c.muted }]);

  rows.push([]);
  rows.push([{ t: "run", fg: c.text, b: true }]);
  const line = (label: string, value: string, fg: Seg["fg"]): Row => [
    { t: `${padEnd(label, 8)} `, fg: c.muted },
    ...clip([{ t: value, fg }], w - 9),
  ];
  rows.push(line("model", st?.model ? modelName(state) : "—", c.text));
  if (st) {
    const cached = st.cacheHitRate === null ? "" : ` · ${Math.round(st.cacheHitRate * 100)}% cached`;
    rows.push(line("cost", `${formatCost(st.costUsd)}${cached}`, c.text));
    if (st.branch) rows.push(line("branch", st.branch, c.soft));
  }
  return rows.map((r) => clip(r, w));
}
