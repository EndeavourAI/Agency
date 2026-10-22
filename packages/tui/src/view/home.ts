/** The start screen: logo, wordmark and the recent sessions. */
import { stringWidth, truncate, wrap } from "../render-model/width.ts";
import { formatCost } from "../state/format.ts";
import type { AppState, Turn } from "../state/types.ts";
import type { Palette } from "../term/themes.ts";
import { workspaceLabel } from "./chrome.ts";
import { SPIN } from "./ledger.ts";
import { logoFrame } from "./logo.ts";
import { fill, type Row, type Seg } from "./rows.ts";

export const HOME_W = 88;
export const LOGO_W = 44;

export function logoRows(tick: number, c: Palette): Row[] {
  return logoFrame(tick).map((l) => fill([{ t: l, fg: c.brand }], LOGO_W));
}

export function wordmarkRow(state: AppState, c: Palette, version: string): Row {
  return [
    { t: "agency", fg: c.text, b: true },
    { t: "  " },
    { t: `v${version} · ${workspaceLabel(state)}`, fg: c.muted },
  ];
}

/** `now`, `4m`, `3h`, `1d`: how long ago a session changed. */
export function ageOf(iso: string | null, now: number): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const lastTurn = (state: AppState, id: string): Turn | undefined =>
  state.bySession[id]?.blocks.findLast((b): b is Turn => b.kind === "turn");

export interface SessionMark {
  mark: string;
  result: "running" | "stopped" | "done";
}

/** The mark of a session in lists: running, stopped by an error, or done. The open session shows `●` while it runs. */
export function sessionMark(state: AppState, id: string, tick: number): SessionMark {
  if (state.liveSessions.includes(id))
    return {
      mark: id === state.sessionId && state.view === "session" ? "●" : (SPIN[tick % SPIN.length] as string),
      result: "running",
    };
  return lastTurn(state, id)?.status === "error"
    ? { mark: "✗", result: "stopped" }
    : { mark: "✓", result: "done" };
}

const pad = (text: string, w: number, right = false): string => {
  const t = truncate(text, w);
  const fillN = " ".repeat(Math.max(0, w - stringWidth(t)));
  return right ? fillN + t : t + fillN;
};

/** The recent list: when, cost and result per session, or the empty state. */
export function recentRows(state: AppState, c: Palette, w: number, tick: number, now: number): Row[] {
  if (!state.sessions.length) {
    const msg =
      "No sessions yet. Describe a task above and press enter. Agency keeps every session running in the daemon.";
    return wrap(msg, w)
      .map((l) => [{ t: pad(l, w).trimEnd(), fg: c.muted }])
      .map((r) => centered(r, w));
  }
  const titleW = w - 2 - 7 - 8 - 7 - 4;
  const head: Row = [
    { t: "   ", fg: c.muted },
    { t: pad("recent", titleW), fg: c.muted },
    { t: ` ${pad("when", 7, true)} ${pad("cost", 8, true)} ${pad("result", 7, true)}`, fg: c.muted },
  ];
  const rows: Row[] = [head];
  for (const r of state.sessions.slice(0, 4)) {
    const m = sessionMark(state, r.id, tick);
    const resultFg = m.result === "running" ? c.brand : m.result === "stopped" ? c.del : c.muted;
    const markFg = m.result === "running" ? c.brand : m.result === "stopped" ? c.del : c.muted;
    const row: Seg[] = [
      { t: `${pad(m.mark, 2)} `, fg: markFg },
      { t: pad(r.title ?? r.lastPrompt ?? r.id, titleW), fg: c.text },
      { t: ` ${pad(ageOf(r.updatedAt, now), 7, true)}`, fg: c.muted },
      { t: ` ${pad(formatCost(r.costUsd), 8, true)}`, fg: c.soft },
      { t: ` ${pad(m.result, 7, true)}`, fg: resultFg },
    ];
    rows.push(row);
  }
  return rows;
}

function centered(row: Row, w: number): Row {
  const used = row.reduce((n, s) => n + stringWidth(s.t), 0);
  return [{ t: " ".repeat(Math.max(0, Math.floor((w - used) / 2))) }, ...row];
}
