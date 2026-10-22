/** The settings screen: sections on the left, the rows of one section on the right; each change is one config_write. */
import { padEnd, truncate, wrap } from "../render-model/width.ts";
import { settingValue } from "../state/derive.ts";
import { rowsOf, SETTINGS, type SettingRow } from "../state/settings.ts";
import type { AppState } from "../state/types.ts";
import type { Palette } from "../term/themes.ts";
import { clip, fill, type Row, type Seg, spread } from "./rows.ts";

export const SECTIONS_W = 22;
const LABEL_W = 22;

export interface SettingsView {
  /** Rows of the body, `cols - 4` cells wide each. */
  body: Row[];
  /** The bottom row: where the file is written and the keys. */
  keys: Row;
}

function valueSegs(state: AppState, c: Palette, r: SettingRow, active: boolean): Seg[] {
  const v = settingValue(state, r);
  if (r.kind === "text") {
    const editing = active && state.settings.edit !== null;
    if (editing)
      return [
        { t: state.settings.edit ?? "", fg: c.text },
        { t: " ", fg: c.bg, bg: c.text },
      ];
    if (!String(v)) return [{ t: "not set", fg: c.muted }];
    return [{ t: r.key.startsWith("budgets.") ? `$${String(v)}` : String(v), fg: c.text }];
  }
  if (r.kind === "toggle") return [{ t: v ? "on" : "off", fg: v ? c.text : c.muted }];
  if (r.kind === "model") return [{ t: `${modelLabel(state)} …`, fg: c.text }];
  return [{ t: String(v), fg: r.kind === "info" ? (v === "no key" ? c.del : c.soft) : c.text }];
}

function modelLabel(state: AppState): string {
  const ref = state.defaultModel;
  if (!ref) return "none";
  return state.models.find((m) => m.ref === ref)?.name ?? ref;
}

/** Where a key comes from, as the row says it. */
export function sourceNote(source: string | undefined): string {
  if (!source) return "";
  if (source === "keychain") return "from the keychain";
  if (source === "login") return "from your login";
  if (source === "config") return "from your config file";
  return `from ${source}`;
}

/** Info rows the daemon supplies: the providers that have a key, and where it comes from. */
function providerRows(state: AppState, section: number): Array<{ label: string; note: string }> {
  if (SETTINGS[section]?.dynamic !== "providers") return [];
  const names = new Map(state.models.map((m) => [m.provider, m.providerName]));
  return state.connectedProviders.map((id) => ({
    label: names.get(id) ?? id,
    note: sourceNote(state.keySource[id]),
  }));
}

export function settingsView(state: AppState, c: Palette, cols: number): SettingsView {
  const w = cols - 4;
  const sec = SETTINGS[state.settings.sec];
  const inRows = state.settings.row !== null;
  const rightW = Math.min(100, w - SECTIONS_W - 2 - 1) - 2;
  const left: Row[] = SETTINGS.map((s, i) => {
    const on = i === state.settings.sec;
    const cell = fill(
      [{ t: ` ${s.name}`, fg: on ? c.text : c.muted, b: on && !inRows }],
      SECTIONS_W,
      on && !inRows ? c.element : undefined,
    );
    return on && !inRows ? cell.map((x) => ({ ...x, bg: x.bg ?? c.element })) : cell;
  });
  const right: Row[] = [];
  rowsOf(state.settings.config, state.settings.sec).forEach((r, j) => {
    const sel = j === state.settings.row;
    const value = valueSegs(state, c, r, sel);
    const note: Seg[] = r.note ? [{ t: r.note, fg: c.muted }] : [];
    const head: Seg[] = [{ t: padEnd(truncate(r.label, LABEL_W), LABEL_W), fg: c.text }, { t: "  " }];
    const row = fill(
      [{ t: " " }, ...head, ...value, ...(note.length ? [{ t: "  " }, ...note] : [])],
      rightW,
      sel ? c.element : undefined,
    );
    right.push(sel ? row.map((x) => ({ ...x, fg: x.fg ?? c.text, bg: x.bg ?? c.element, b: true })) : row);
  });
  for (const r of providerRows(state, state.settings.sec)) {
    const head: Seg[] = [{ t: padEnd(truncate(r.label, LABEL_W), LABEL_W), fg: c.text }, { t: "  " }];
    right.push(
      fill(
        [
          { t: " " },
          ...head,
          { t: "key set", fg: c.soft },
          ...(r.note ? [{ t: "  " }, { t: r.note, fg: c.muted }] : []),
        ],
        rightW,
      ),
    );
  }
  const empty: Record<string, string> = {
    Permissions: "No rules in your user config. A tool with no rule asks unless it only reads.",
    "Tools and MCP": "No MCP servers in your user config: agency mcp add puts one there.",
    Hooks: "No hooks in your user config.",
  };
  const added = rowsOf(state.settings.config, state.settings.sec).length - (sec?.rows.length ?? 0);
  if (sec?.name === "Permissions") {
    right.push([]);
    for (const l of wrap(
      added === 0
        ? (empty.Permissions ?? "")
        : "Rules apply in this order. A project rule needs a trusted workspace.",
      rightW - 2,
    ))
      right.push([{ t: ` ${l}`, fg: c.muted }]);
  } else if (sec?.dynamic && sec.dynamic !== "providers" && added === 0) {
    right.push([]);
    for (const l of wrap(empty[sec.name] ?? "", rightW - 2)) right.push([{ t: ` ${l}`, fg: c.muted }]);
  }
  const height = Math.max(left.length, right.length);
  const body: Row[] = [];
  for (let i = 0; i < height; i++) {
    body.push([
      ...(left[i] ?? fill([], SECTIONS_W)),
      { t: "  " },
      { t: "│", fg: c.line },
      { t: " " },
      ...(right[i] ?? []),
    ]);
  }
  const editing = state.settings.edit !== null;
  const keyList: Array<[string, string]> = editing
    ? [
        ["enter", "save"],
        ["esc", "cancel"],
      ]
    : [
        ["↑↓", "move"],
        ["→", "open"],
        ["space", "change"],
        ["esc", "back"],
      ];
  const rightKeys: Seg[] = [];
  keyList.forEach(([k, l], i) => {
    if (i) rightKeys.push({ t: "  " });
    rightKeys.push({ t: k, fg: c.soft }, { t: ` ${l}`, fg: c.muted });
  });
  const keys = [
    { t: " " },
    ...spread(w - 2, [{ t: "writes your user config", fg: c.muted }], rightKeys, undefined, 2),
    { t: " " },
  ];
  return { body: body.map((r) => clip(r, w)), keys };
}
