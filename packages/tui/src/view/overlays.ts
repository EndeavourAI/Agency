/** The two dialogs that float over the screen: the palette (ctrl+p) and the model picker. */
import { padEnd, stringWidth, truncate, wrap } from "../render-model/width.ts";
import { flatModels, modelGroups, paletteItems, pickerRow, snapEffort } from "../state/derive.ts";
import { formatCost, formatTokens } from "../state/format.ts";
import type { AppState } from "../state/types.ts";
import { EFFORTS } from "../state/types.ts";
import type { Palette } from "../term/themes.ts";
import { workspaceLabel } from "./chrome.ts";
import { ageOf, sessionMark } from "./home.ts";
import { clip, fill, onBg, type Row, type Seg, spread } from "./rows.ts";

export const PALETTE_W = 84;
export const MODEL_W = 76;

interface Line {
  row: Row;
  /** The row of the item the arrow keys stand on. */
  sel?: boolean;
}

/** `pinned` rows stay; of `body` the window of `room` rows that holds the selected row. */
function windowed(pinned: Line[], body: Line[], room: number): Line[] {
  const space = Math.max(1, room - pinned.length);
  if (body.length <= space) return [...pinned, ...body];
  const at = Math.max(
    0,
    body.findIndex((l) => l.sel),
  );
  const start = Math.max(0, Math.min(body.length - space, at - Math.floor(space / 2)));
  return [...pinned, ...body.slice(start, start + space)];
}

/** One dialog row: inset by 2, padded to the dialog width on the panel fill; a selected row on the element fill. */
function dialogRow(inner: Row, w: number, c: Palette, sel = false): Row {
  const bg = sel ? c.element : c.panel;
  const body = fill([{ t: "  " }, ...clip(inner, w - 4), { t: "  " }], w, bg);
  return onBg(body, bg).map((s) => (sel ? { ...s, fg: s.fg ?? c.text, b: true } : s));
}

const rule = (w: number, c: Palette): Seg => ({ t: "─".repeat(Math.max(1, w)), fg: c.line });

function header(title: string, right: string, w: number, c: Palette): Row {
  return [
    { t: title, fg: c.text, b: true },
    { t: " " },
    rule(w - 4 - stringWidth(title) - stringWidth(right) - 2, c),
    { t: " " },
    { t: right, fg: c.muted },
  ];
}

/** The input line of a dialog: a prompt glyph, the query (or the placeholder) and the caret. */
function queryRow(glyph: string, q: string, placeholder: string, c: Palette): Row {
  const text: Row = q
    ? [
        { t: q, fg: c.text },
        { t: " ", fg: c.bg, bg: c.text },
      ]
    : [
        { t: placeholder.slice(0, 1), fg: c.bg, bg: c.text },
        { t: placeholder.slice(1), fg: c.muted },
      ];
  return [{ t: `${glyph} `, fg: c.text }, ...text];
}

export function paletteRows(
  state: AppState,
  c: Palette,
  cols: number,
  room: number,
  tick: number,
  now: number,
): Row[] {
  const w = Math.min(PALETTE_W, cols - 4);
  const items = paletteItems(state);
  const at = Math.min(state.palette.at, Math.max(0, items.length - 1));
  const pinned: Line[] = [
    { row: [] },
    { row: header("go to", "↑↓ enter · esc", w, c) },
    { row: [] },
    { row: queryRow("›", state.palette.query, "session or /command", c) },
    { row: [] },
  ];
  const sessions = items.filter((i) => i.kind === "session");
  const commands = items.filter((i) => i.kind === "command");
  const project = workspaceLabel(state).split("/").pop() ?? "";
  const body: Line[] = [{ row: [{ t: "sessions", fg: c.muted }] }];
  sessions.forEach((s, i) => {
    const row = state.sessions.find((r) => r.id === s.ref);
    const m = sessionMark(state, s.ref, tick);
    const mark = m.result === "running" ? c.brand : m.result === "stopped" ? c.del : c.muted;
    body.push({
      row: spread(
        w - 4,
        [
          { t: `${m.mark}  `, fg: mark },
          { t: s.label, fg: c.text },
        ],
        [{ t: `${project}  ${s.hint}  ${ageOf(row?.updatedAt ?? null, now)}`.trimEnd(), fg: c.muted }],
        undefined,
        2,
      ),
      sel: i === at,
    });
  });
  if (!sessions.length) body.push({ row: [{ t: "No session matches.", fg: c.muted }] });
  body.push({ row: [] }, { row: [{ t: "commands", fg: c.muted }] });
  commands.forEach((cm, i) => {
    body.push({
      row: spread(
        w - 4,
        [{ t: padEnd(cm.label, 12), fg: c.text }, { t: "  " }, { t: cm.hint, fg: c.muted }],
        [{ t: cm.key, fg: c.muted }],
        undefined,
        2,
      ),
      sel: sessions.length + i === at,
    });
  });
  if (!commands.length) body.push({ row: [{ t: "No command matches.", fg: c.muted }] });
  body.push({ row: [] });
  return windowed(pinned, body, room).map((l) => dialogRow(l.row, w, c, l.sel));
}

const price = (n: number | null): string => (n === null ? "n/a" : formatCost(n));

export function modelRows(state: AppState, c: Palette, cols: number, room: number): Row[] {
  const w = Math.min(MODEL_W, cols - 4);
  const groups = modelGroups(state);
  const flat = flatModels(state);
  const at = Math.min(state.model.at, Math.max(0, flat.length - 1));
  const keys = state.connectedProviders.length > 0;
  const current = (state.sessionId ? state.bySession[state.sessionId]?.model : null) ?? state.defaultModel;
  const cell = (text: string, n: number): string => padEnd(truncate(text, n), n).padStart(n);
  const grid = (check: string, name: string, ctx: string, inp: string, out: string, inner: number): Row => {
    const fixed = 2 + 6 + 9 + 9 + 4;
    return [
      { t: `${padEnd(check, 2)} ` },
      { t: padEnd(truncate(name, inner - fixed), Math.max(0, inner - fixed)) },
      { t: ` ${cell(ctx, 6)} ${cell(inp, 9)} ${cell(out, 9)}` },
    ];
  };
  const pinned: Line[] = [
    { row: [] },
    { row: header("model", "esc", w, c) },
    { row: [] },
    { row: queryRow("/", state.model.q, "search", c) },
    { row: [] },
    ...(keys
      ? [{ row: grid("", "", "ctx", "in /MTok", "out /MTok", w - 4).map((s) => ({ ...s, fg: c.muted })) }]
      : []),
  ];
  const body: Line[] = [];
  let n = 0;
  for (const g of groups) {
    body.push({ row: [] }, { row: [{ t: g.title, fg: c.muted }] });
    for (const m of g.items) {
      body.push({
        row: grid(
          m.ref === current ? "●" : "",
          m.name,
          formatTokens(m.contextWindow),
          price(m.inPerMTok),
          price(m.outPerMTok),
          w - 4,
        ).map((s) => ({ ...s, fg: c.text })),
        sel: n === at,
      });
      n += 1;
    }
  }
  if (!flat.length && keys) body.push({ row: [] }, { row: [{ t: "No model matches.", fg: c.muted }] });
  if (!keys) {
    body.push({ row: [] });
    const msg = "No provider has a key yet. Run agency auth login <provider>, then open this list again.";
    for (const l of wrap(msg, w - 4)) {
      const at2 = l.indexOf("agency auth login <provider>");
      body.push({
        row:
          at2 < 0
            ? [{ t: l, fg: c.muted }]
            : [
                { t: l.slice(0, at2), fg: c.muted },
                { t: "agency auth login <provider>", fg: c.text },
                { t: l.slice(at2 + "agency auth login <provider>".length), fg: c.muted },
              ],
      });
    }
  }
  body.push({ row: [] });
  const effort: Row = [{ t: "effort", fg: c.muted }, { t: " " }];
  const offered = pickerRow(state)?.efforts ?? EFFORTS;
  const shown = snapEffort(state.effort, offered);
  const levels: Seg[] =
    offered.length < 2
      ? [{ t: "no reasoning control", fg: c.muted }]
      : offered.flatMap((e, i) => [
          ...(i ? [{ t: " " }] : []),
          e === shown ? { t: ` ${e} `, fg: c.text, bg: c.element, b: true } : { t: ` ${e} `, fg: c.muted },
        ]);
  const lines = windowed(pinned, body, room - 2);
  lines.push({ row: spread(w - 4, effort, levels, undefined, 1) });
  lines.push({ row: [] });
  return lines.map((l) => dialogRow(l.row, w, c, l.sel));
}
