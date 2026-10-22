/**
 * Labels and flags the canvas computes in `renderVals`, as pure functions of the state. Colours stay symbolic
 * (`Tone`); the view maps them to the theme.
 */
import { completionItems } from "../input/completion.ts";
import { diffStats, stepDiff } from "../render-model/diff.ts";
import { stepOutput } from "../render-model/output.ts";
import { truncate } from "../render-model/width.ts";
import { pickable } from "./reduce.ts";
import { COMMANDS, rowValue, type SettingRow } from "./settings.ts";
import type { AppState, Block, ImageChip, ModelRow, SessionState, Step, Turn } from "./types.ts";

export type Tone = "text" | "soft" | "muted" | "dim" | "brand" | "add" | "del";

export const WIDE_COLS = 120;
export const LOGO_MIN_ROWS = 30;

export function current(state: AppState): SessionState | null {
  return state.sessionId ? (state.bySession[state.sessionId] ?? null) : null;
}

export const isWide = (state: AppState): boolean => state.cols >= WIDE_COLS;
export const detailsShown = (state: AppState): boolean => state.details && isWide(state);

const lastTurn = (s: SessionState): Turn | undefined =>
  s.blocks.findLast((b): b is Turn => b.kind === "turn");

export const runningTurn = (s: SessionState | null): Turn | undefined =>
  s?.blocks.findLast(
    (b): b is Turn => b.kind === "turn" && (b.status === "running" || b.status === "waiting"),
  );

/** A turn runs here now and the daemon is reachable. */
export function isWorking(state: AppState): boolean {
  const s = current(state);
  return state.view === "session" && s?.runningTurnId != null;
}

/** The last turn ended because the person stopped or denied it: a queued prompt waits for enter. */
export function isHalted(state: AppState): boolean {
  const s = current(state);
  const t = s ? lastTurn(s) : undefined;
  return t?.status === "stopped" || t?.status === "denied";
}

export const showAsk = (state: AppState): boolean => {
  const s = current(state);
  return state.view === "session" && !state.review.open && !!runningTurn(s)?.approval;
};

export const canRetry = (state: AppState): boolean => {
  const s = current(state);
  const t = s ? lastTurn(s) : undefined;
  return !!t && t.status === "error" && s?.runningTurnId == null;
};

/** The glyph word the ledger shows for a tool. */
const GLYPH: Record<string, string> = {
  read: "read",
  grep: "search",
  glob: "search",
  bash: "run",
  edit: "edit",
  write: "write",
  notebook_edit: "edit",
  delegate: "agent",
  spawn: "agent",
};
export const toolGlyph = (tool: string): string => GLYPH[tool] ?? tool.replace(/_/g, " ");

const TARGET_KEYS = ["path", "command", "pattern", "query", "url", "task", "prompt", "name"] as const;

/** What a step acted on: its path, command, pattern or query, cut to one line. */
export function stepTarget(step: Step): string {
  for (const k of TARGET_KEYS) {
    const v = step.input?.[k];
    if (typeof v === "string" && v.trim()) return truncate(v.split("\n")[0]?.trim() ?? "", 80);
  }
  return "";
}

export interface StepView {
  id: string;
  glyph: string;
  tone: Tone;
  target: string;
  /** ` · note` text after the target, or "". */
  meta: string;
  metaTone: Tone;
  add: string;
  del: string;
  open: boolean;
  out: ReturnType<typeof stepOutput>;
  live: boolean;
}

export function stepView(step: Step, paused: boolean): StepView {
  const diff = stepDiff(step.tool, step.input);
  const stats = diff ? diffStats(diff) : null;
  const fail = step.status === "error" || step.status === "denied";
  const live = step.status === "running" && !paused;
  const answer = step.answer === "once" ? "allowed once" : step.answer === "always" ? "always allowed" : "";
  const meta = step.status === "denied" ? "denied" : step.status === "error" ? "failed" : answer;
  return {
    id: step.id,
    glyph: (fail ? "✗ " : "") + toolGlyph(step.tool),
    tone: fail ? "del" : live ? "brand" : "soft",
    target: stepTarget(step) + (meta ? " · " : " "),
    meta,
    metaTone: fail ? "del" : "muted",
    add: stats && stats.add + stats.del > 0 ? `+${stats.add} ` : "",
    del: stats && stats.add + stats.del > 0 ? `−${stats.del}` : "",
    open: step.open && !live,
    out: live ? [] : stepOutput(step.tool, step.input, step.content),
    live,
  };
}

const sec = (ms: number): string => `${Math.max(0, Math.round(ms / 1000))}s`;

export interface Stamp {
  /** "bead" means the running abacus animation. */
  glyph: "✓" | "✗" | "·" | "bead";
  label: string;
  note: string;
  tone: Tone;
}

/** What a turn is doing now, for the stamp: its running step, else thinking or writing. */
export function doing(t: Turn): string {
  const step = t.steps.findLast((s) => s.status === "running");
  if (step) return `${toolGlyph(step.tool)} ${stepTarget(step)}`.trim();
  return t.answer.settled.length > 0 || t.answer.tail ? "writing" : "thinking";
}

export function turnStamp(t: Turn, offline: boolean): Stamp {
  if (t.status === "waiting") return { glyph: "·", label: "waiting", note: "", tone: "muted" };
  if (t.status === "running")
    return offline
      ? { glyph: "·", label: "paused", note: " · waiting for the daemon", tone: "muted" }
      : { glyph: "bead", label: doing(t), note: t.note ? ` · ${t.note}` : "", tone: "brand" };
  if (t.status === "denied")
    return { glyph: "✗", label: "denied", note: ` · ${t.stoppedBy ?? "you denied it"}`, tone: "del" };
  if (t.status === "stopped")
    return { glyph: "✗", label: "interrupted", note: ` · ${t.stoppedBy ?? "you pressed esc"}`, tone: "del" };
  if (t.status === "error") return { glyph: "✗", label: "stopped", note: "", tone: "del" };
  return { glyph: "✓", label: "done", note: ` · ${t.steps.length} steps`, tone: "add" };
}

export interface TurnFoot {
  copyLabel: string;
  thought: string;
  stats: string;
}

/** Closing row of a finished turn: copy, the folded reasoning, wall time and stream rate. */
export function turnFoot(t: Turn, copied: string | null): TurnFoot {
  const wall = t.endedAt !== undefined && t.endedAt > t.startedAt ? sec(t.endedAt - t.startedAt) : "";
  const rate =
    t.streamMs > 0 && t.usage.outputTokens > 0 ? Math.round((t.usage.outputTokens / t.streamMs) * 1000) : 0;
  const stats = [wall, rate > 0 ? `${rate} tok/s` : ""].filter(Boolean).join(" · ");
  return {
    copyLabel: copied === t.id ? "✓ copied" : "copy",
    thought: t.thoughtOpen ? "hide thought" : t.thinking ? `thought ${sec(t.ttftMs + t.streamMs)}` : "",
    stats: stats ? `· ${stats}` : "",
  };
}

/** The thought label of a running turn. */
export const runningThought = (t: Turn, offline: boolean): string =>
  t.thoughtOpen ? "hide reasoning" : offline ? "reasoning (paused)" : "reasoning";

/** A pasted image in the prompt box: "▣ image 1 · 184 KB". */
export const imageLabel = (chip: ImageChip, index: number): string =>
  `▣ ${chip.name || `image ${index + 1}`} · ${Math.max(1, Math.round(chip.size / 1024))} KB`;

/** The prompt as the ledger shows it: the text, then one `[image n]` tag per attached image. */
export const youText = (t: Turn): string =>
  t.images.length ? `${t.prompt}  ${t.images.map((x) => `[${x.name}]`).join(" ")}` : t.prompt;

/** No provider has a key: the model picker opens on its own with the way to add one. */
export const noProviders = (state: AppState): boolean =>
  state.conn === "online" && state.connectedProviders.length === 0 && state.models.length === 0;

/** The value a settings row shows: theme and effort live in the state, the rest in the config. */
export function settingValue(state: AppState, row: SettingRow): string | boolean {
  if (row.key === "theme") return state.theme;
  if (row.key === "effort") return state.effort;
  return rowValue(row, state.settings.config);
}

export const formatCost = (usd: number): string => `$${usd.toFixed(2)}`;

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** Context used, 0 to 100, or null while the limit is unknown. */
export function ctxPercent(s: SessionState | null): number | null {
  const st = s?.status;
  if (!st || !st.contextLimit) return null;
  return Math.min(100, Math.round((st.contextTokens / st.contextLimit) * 100));
}

export interface Task {
  mark: "✓" | "▸" | "○";
  text: string;
  tone: Tone;
}

export function tasks(s: SessionState | null): Task[] {
  return (s?.todos ?? []).map((t) => ({
    mark: t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "○",
    text: t.content,
    tone: t.status === "completed" ? "muted" : "text",
  }));
}

/** Context and task counts that ride in the hint row while the details pane is hidden. */
export function ctxNote(state: AppState): string {
  const s = current(state);
  if (state.view !== "session" || detailsShown(state) || !s) return "";
  const pct = ctxPercent(s);
  const done = s.todos.filter((t) => t.status === "completed").length;
  return (
    (pct === null ? "" : ` · ${pct}% ctx`) + (s.todos.length ? ` · ${done}/${s.todos.length} tasks` : "")
  );
}

export const effortNote = (state: AppState): string => (isWide(state) ? ` · ${state.effort}` : "");

/** The statusLine command output; wide screens only. */
export function statusText(state: AppState): string {
  const s = current(state);
  return isWide(state) && state.view === "session" && s?.statusLine ? s.statusLine.trim() : "";
}

export interface Hint {
  key: string;
  label: string;
}

/** Only the keys that matter now; the palette lists every command with its key. */
export function hints(state: AppState): Hint[] {
  const s = current(state);
  const picks = s ? pickable(s.blocks) : [];
  if (s && s.pickAt !== null && picks.includes(s.pickAt))
    return [
      { key: "↑↓", label: "turn" },
      { key: "enter", label: "output" },
      { key: "c", label: "copy" },
      { key: "t", label: "thinking" },
      { key: "esc", label: "back" },
    ];
  if (s && s.scroll > 0)
    return [
      { key: "pgdn", label: "newer" },
      { key: "ctrl+end", label: "latest" },
    ];
  if (isWorking(state) && state.conn !== "offline")
    return [
      { key: "esc", label: "stop" },
      { key: "ctrl+p", label: "commands" },
    ];
  return [
    ...(isWide(state) ? [{ key: "↑", label: "history" }] : []),
    { key: "esc esc", label: "turns" },
    { key: "ctrl+p", label: "commands" },
  ];
}

export function footer(state: AppState): { text: string; tone: Tone } {
  if (state.conn === "offline")
    return { text: "✗ daemon unreachable · run agency daemon start", tone: "del" };
  const n = state.sessions.length;
  if (!n) return { text: "daemon ready", tone: "muted" };
  const spent = state.sessions.reduce((sum, r) => sum + r.costUsd, 0);
  return {
    text: `daemon ready · ${n} session${n === 1 ? "" : "s"} · ${formatCost(spent)} total`,
    tone: "muted",
  };
}

export interface QueuedRow {
  text: string;
  note: string;
}

export function queuedRows(state: AppState): QueuedRow[] {
  const s = current(state);
  if (!s || s.scroll > 0) return [];
  const halted = isHalted(state);
  return s.queue.map((q) => ({
    text: q.kind === "shell" ? `! ${q.text}` : `› ${q.text}`,
    note: halted ? "turn stopped · enter sends it" : "queued · sends when this turn ends",
  }));
}

export interface PaletteItem {
  kind: "session" | "command";
  label: string;
  hint: string;
  key: string;
  /** Session id or command action. */
  ref: string;
  /** `running`, `done` or `stopped` for a session row. */
  result?: string;
}

/** One list: sessions first, then commands, walked by the arrow keys. */
export function paletteItems(state: AppState): PaletteItem[] {
  const q = state.palette.query.trim().toLowerCase();
  const sessions = state.sessions
    .filter((r) => !q || (r.title ?? r.id).toLowerCase().includes(q))
    .map<PaletteItem>((r) => ({
      kind: "session",
      label: r.title ?? r.lastPrompt ?? r.id,
      hint: formatCost(r.costUsd),
      key: "",
      ref: r.id,
      result: state.liveSessions.includes(r.id) ? "running" : "done",
    }));
  const commands = COMMANDS.filter(
    (c) => !q || `${c.name} ${c.hint}`.toLowerCase().includes(q),
  ).map<PaletteItem>((c) => ({
    kind: "command",
    label: c.name,
    hint: c.hint,
    key: c.key,
    ref: c.act,
  }));
  return [...sessions, ...commands];
}

export interface ModelGroup {
  title: string;
  items: ModelRow[];
}

/** Recent first, then one group per provider; every word of the query must match. */
export function modelGroups(state: AppState): ModelGroup[] {
  const words = state.model.q.toLowerCase().split(/\s+/).filter(Boolean);
  const match = state.models.filter((m) =>
    words.every((w) => `${m.name} ${m.providerName} ${m.tags}`.toLowerCase().includes(w)),
  );
  const groups: ModelGroup[] = [];
  if (!words.length) {
    const recent = state.model.recent
      .map((r) => match.find((m) => m.ref === r))
      .filter((m): m is ModelRow => !!m);
    groups.push({ title: "recent", items: recent });
  }
  for (const p of new Set(match.map((m) => m.providerName)))
    groups.push({ title: p.toLowerCase(), items: match.filter((m) => m.providerName === p) });
  return groups.filter((g) => g.items.length);
}

export const flatModels = (state: AppState): ModelRow[] => modelGroups(state).flatMap((g) => g.items);

export function completion(state: AppState) {
  return completionItems(state.ac, { files: state.files, slash: state.slash });
}

/** Blocks up to the scrolled-back position. */
export function scrolledBlocks(s: SessionState): Block[] {
  return s.scroll ? s.blocks.slice(0, Math.max(0, s.blocks.length - s.scroll)) : s.blocks;
}

export const newerLabel = (s: SessionState): string =>
  `${s.scroll} newer block${s.scroll === 1 ? "" : "s"} below`;

/** The other sessions that run: the orbit beside "N more". */
export function othersRunning(state: AppState): boolean {
  return state.liveSessions.some((id) => id !== state.sessionId);
}

export function othersLabel(state: AppState): string {
  const n = state.sessions.length;
  if (state.view === "home") return n ? `${n} sessions` : "go to";
  return n > 1 ? `${n - 1} more` : "go to";
}

/** Home hides the logo below 30 rows. */
export const showLogo = (state: AppState): boolean => state.rows >= LOGO_MIN_ROWS;
