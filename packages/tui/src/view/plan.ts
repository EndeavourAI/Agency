/** The plan panel: the plan as markdown in a box that scrolls, and under it the three answers. */
import { PLAN_HEAD_ROWS, planBlocks, planPanel, planWidth } from "../state/derive.ts";
import { type Approval, type AppState, PLAN_CHOICES } from "../state/types.ts";
import type { Palette } from "../term/themes.ts";
import { boxRows, mdRows } from "./ledger.ts";
import { onBg, type Row, type Seg, spread } from "./rows.ts";

const LABELS = [
  "Yes, and auto-accept edits",
  "Yes, and manually approve edits",
  "No, keep planning",
] as const;

export const planDoc = (plan: string, cols: number, c: Palette): Row[] =>
  mdRows(planBlocks(plan), planWidth(cols) - 4, planWidth(cols) - 4, c);

/** Plan rows that do not fit a box `h` rows tall: how far the page keys may scroll. */
export const planOverflow = (state: AppState, c: Palette, ask: Approval, h: number): number =>
  Math.max(0, planDoc(ask.title, state.cols, c).length - Math.max(1, h - PLAN_HEAD_ROWS));

/** The box with the plan, `h` rows tall at most; its bottom edge is the joint of the answers box. */
export function planBody(state: AppState, c: Palette, ask: Approval, h: number): Row[] {
  const w = planWidth(state.cols);
  const doc = planDoc(ask.title, state.cols, c);
  const vis = Math.max(1, h - PLAN_HEAD_ROWS);
  const top = Math.min(planPanel(state, ask.requestId).scroll, Math.max(0, doc.length - vis));
  const where = doc.length > vis ? `${top + 1}–${Math.min(doc.length, top + vis)} of ${doc.length}` : "";
  const head = spread(
    w - 4,
    [{ t: "Ready to code? Here is the plan:", fg: c.text, b: true }],
    [{ t: where, fg: c.muted }],
    undefined,
    2,
  );
  return boxRows(w, [head, [], ...doc.slice(top, top + vis)], c.plan, { bottom: false });
}

/** The question and the numbered answers; the third takes the words that tell the model what to change. */
export function planChoices(state: AppState, c: Palette, ask: Approval): Row[] {
  const w = planWidth(state.cols);
  const ui = planPanel(state, ask.requestId);
  const rows: Row[] = [[{ t: "Would you like to proceed?", fg: c.text }]];
  PLAN_CHOICES.forEach((_, i) => {
    const on = i === ui.at;
    const seg: Seg[] = [
      { t: on ? "› " : "  ", fg: c.plan, b: true },
      { t: `${i + 1}. ${LABELS[i]}`, fg: on ? c.text : c.soft, b: on },
    ];
    if (i === 2 && ui.note) seg.push({ t: `  ${ui.note}`, fg: c.text }, { t: "▍", fg: c.brand });
    else if (i === 2 && on) seg.push({ t: "  type what to change, then enter", fg: c.muted });
    const row = spread(w - 4, seg, [], on ? c.element : undefined, 1);
    rows.push(on ? onBg(row, c.element) : row);
  });
  return boxRows(w, rows, c.plan, { joined: true });
}
