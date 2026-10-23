/** The bars: top bar, hint row and footer, plus the labels the hint row needs. */
import {
  ctxNote,
  current,
  effortNote,
  footer,
  hints,
  othersLabel,
  othersRunning,
  statusText,
} from "../state/derive.ts";
import type { AppState } from "../state/types.ts";
import { modeColor, type Palette } from "../term/themes.ts";
import { SPIN, toneColor } from "./ledger.ts";
import { fill, onBg, type Row, type Seg, spread } from "./rows.ts";

/** The name of the model for the next turn, as the picker shows it. */
export function modelName(state: AppState): string {
  const ref = (state.sessionId ? state.bySession[state.sessionId]?.model : null) ?? state.defaultModel;
  if (!ref) return "no model";
  return state.models.find((m) => m.ref === ref)?.name ?? ref.slice(ref.indexOf("/") + 1);
}

/** `~/Agency` for the workspace folder, as the canvas writes it. */
export function workspaceLabel(
  state: AppState,
  home = process.env.HOME ?? process.env.USERPROFILE ?? "",
): string {
  const ws = state.workspace.replace(/\\/g, "/");
  const h = home.replace(/\\/g, "/");
  return h && ws.startsWith(h) ? `~${ws.slice(h.length)}` : ws;
}

export function branchOf(state: AppState): string {
  return (
    current(state)?.status?.branch ??
    state.review.git?.branch ??
    state.sessions.find((s) => s.branch)?.branch ??
    ""
  );
}

export function topBar(state: AppState, c: Palette, tick: number): Row {
  const w = state.cols;
  const left: Seg[] = [{ t: "agency", fg: c.brand, b: true }];
  if (state.view === "session") {
    const title = current(state)?.title ?? "";
    if (title) left.push({ t: "  " }, { t: title, fg: c.text });
  } else if (state.view === "settings") left.push({ t: "  " }, { t: "settings", fg: c.text });
  let right: Seg[];
  if (state.conn === "offline") {
    right = [
      { t: "✗ daemon unreachable", fg: c.del },
      { t: "  " },
      { t: "r", fg: c.text },
      { t: " retry", fg: c.muted },
    ];
  } else {
    const orbit = othersRunning(state) ? [{ t: `${SPIN[tick % SPIN.length]} `, fg: c.brand }] : [];
    right = [...orbit, { t: "ctrl+p", fg: c.soft }, { t: ` ${othersLabel(state)}`, fg: c.muted }];
    const branch = branchOf(state);
    if (branch) right.push({ t: "  " }, { t: branch, fg: c.soft });
  }
  return onBg(
    fill([{ t: "  " }, ...spread(w - 4, left, right, c.panel, 2), { t: "  " }], w, c.panel),
    c.panel,
  );
}

/** The mode of the next turn: plan and auto say what they allow and how to leave, build is just its name. */
function modeBadge(state: AppState, c: Palette): Seg[] {
  const tag: Seg = { t: " (shift+tab to cycle)", fg: c.muted };
  if (state.mode === "plan") return [{ t: "⏸ plan mode on", fg: modeColor(c, "plan"), b: true }, tag];
  if (state.mode === "auto") return [{ t: "⏵⏵ accept edits on", fg: modeColor(c, "auto"), b: true }, tag];
  return [{ t: state.mode, fg: modeColor(c, state.mode), b: true }];
}

/** The one row under the prompt: mode, model, context, the statusLine output and only the keys that matter now. */
export function hintRow(state: AppState, c: Palette, w: number): Row {
  const left: Seg[] = [];
  if (state.composer.shell && state.view === "session") {
    left.push(
      { t: "shell", fg: c.you, b: true },
      { t: ` · runs in ${workspaceLabel(state)} · the output goes to the agent as data`, fg: c.muted },
    );
  } else if (state.flash) {
    // Short-lived, so it takes the place of the summary instead of fighting the hints for room.
    left.push({ t: state.flash.text, fg: state.flash.tone === "error" ? c.del : c.text });
  } else {
    left.push(
      ...modeBadge(state, c),
      { t: " · ", fg: c.muted },
      { t: modelName(state), fg: c.text },
      { t: `${effortNote(state)}${ctxNote(state)}`, fg: c.muted },
    );
    const status = statusText(state);
    if (status) left.push({ t: "  " }, { t: "│", fg: c.dim }, { t: "  " }, { t: status, fg: c.soft });
  }
  const right: Seg[] = [];
  const list = state.view === "home" ? homeHints() : hints(state);
  list.forEach((h, i) => {
    if (i) right.push({ t: "  " });
    right.push({ t: h.key, fg: c.soft }, { t: ` ${h.label}`, fg: c.muted });
  });
  return [{ t: " " }, ...spread(w - 2, left, right, undefined, 2), { t: " " }].map((s) =>
    s.fg === undefined ? { ...s, fg: c.muted } : s,
  );
}

const homeHints = () => [
  { key: "enter", label: "start" },
  { key: "ctrl+p", label: "commands" },
];

export function footerRow(state: AppState, c: Palette): Row {
  const f = footer(state);
  const body = spread(state.cols - 4, [], [{ t: f.text, fg: toneColor(c, f.tone) }], c.panel);
  return onBg(fill([{ t: "  " }, ...body, { t: "  " }], state.cols, c.panel), c.panel);
}
