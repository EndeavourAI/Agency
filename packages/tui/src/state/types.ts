import type { Completion, SlashEntry } from "../input/completion.ts";
import type { Composer } from "../input/composer.ts";
import type { MdState } from "../render-model/markdown.ts";
import type { WireGitStatus, WireSessionRow, WireStatus, WireTodo, WireUsage } from "./wire.ts";

export type UiMode = "build" | "plan" | "auto";
export const MODES: readonly UiMode[] = ["build", "plan", "auto"];

/** The daemon's permission mode of each canvas mode: build is the daemon default. */
export const PERMISSION_OF: Readonly<Record<UiMode, string>> = { build: "ask", plan: "plan", auto: "auto" };

export type ThemeName = "agency" | "night" | "light";
export type Effort = "low" | "medium" | "high" | "xhigh";
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh"];

export type Connection = "connecting" | "online" | "offline";
export type View = "home" | "session" | "settings";

export type StepStatus = "running" | "ok" | "error" | "denied";

export interface Step {
  /** Tool call id from the daemon. */
  id: string;
  tool: string;
  input?: Record<string, unknown>;
  status: StepStatus;
  content?: string;
  /** Last tool_progress line while running. */
  progress?: string;
  /** Output opened (enter or o on a picked turn). */
  open: boolean;
  /** How the person answered the ask that this step waited on. */
  answer?: "once" | "always";
}

export interface Approval {
  requestId: string;
  tool: string;
  title: string;
  command?: string;
  path?: string;
  riskTier: string;
  argsSummary: string;
}

export interface ImageChip {
  name: string;
  /** Bytes; the chip label shows KB. */
  size: number;
  mimeType: string;
  data: string;
}

export type TurnStatus = "waiting" | "running" | "done" | "error" | "stopped" | "denied";

export interface Turn {
  kind: "turn";
  /** Stable key: the daemon turn id when known, else a local id. */
  id: string;
  prompt: string;
  images: ImageChip[];
  steps: Step[];
  answer: MdState;
  /** The raw answer text, for copy. */
  text: string;
  thinking: string;
  /** Reasoning time from the daemon (thinking_end); 0 when unknown, as in a session loaded from its file. */
  thoughtMs: number;
  thoughtOpen: boolean;
  status: TurnStatus;
  stopReason?: string;
  usage: WireUsage;
  costUsd: number;
  ttftMs: number;
  streamMs: number;
  startedAt: number;
  endedAt?: number;
  error?: { code: string; message: string };
  /** The ask this turn waits on; it takes over the prompt box. */
  approval: Approval | null;
  /** True once the prompt was answered by anything (a step, text or the end). */
  answered: boolean;
  /** Model fallback or retry notes shown in the stamp. */
  note?: string;
  /** What the denied or stopped ask was, for the stamp note. */
  stoppedBy?: string;
  /** Pending next-prompt suggestion (prompt_suggestion). */
  suggestion?: string;
}

export interface EventBlock {
  kind: "event";
  id: string;
  text: string;
}

export interface ShellBlock {
  kind: "shell";
  id: string;
  cmd: string;
  out: string[];
  status: "running" | "done" | "error";
}

export type Block = Turn | EventBlock | ShellBlock;

export interface QueueItem {
  id: string;
  kind: "prompt" | "shell";
  text: string;
  images: ImageChip[];
}

export interface SessionState {
  id: string;
  title: string;
  /** The `provider/model` chosen for this session in the picker; the daemon's own model is in `status`. */
  model: string | null;
  blocks: Block[];
  loading: boolean;
  /** The daemon turn that runs now in this session, if any. */
  runningTurnId: string | null;
  compacting: boolean;
  queue: QueueItem[];
  status: WireStatus | null;
  /** The statusLine command output. */
  statusLine: string | null;
  todos: WireTodo[];
  /** Blocks scrolled back from the newest (pgup). */
  scroll: number;
  /** Index of the picked turn block, or null. */
  pickAt: number | null;
  /** Running totals of the current turn from cost_meter. */
  runCostUsd: number;
  tipId: string | null;
}

export interface PaletteState {
  open: boolean;
  query: string;
  at: number;
}

export interface ModelRow {
  /** `provider/model` as the daemon addresses it. */
  ref: string;
  provider: string;
  providerName: string;
  id: string;
  name: string;
  contextWindow: number;
  inPerMTok: number | null;
  outPerMTok: number | null;
  tags: string;
}

export interface ModelPicker {
  open: boolean;
  q: string;
  at: number;
  recent: string[];
}

export interface ReviewState {
  open: boolean;
  file: number;
  git: WireGitStatus | null;
  diff: string;
  untracked: Array<{ path: string; text: string | null }>;
  /** What the last commit did: shown in place of the commit box. */
  committed: "local" | "pushed" | null;
  commitMessage: string;
}

export interface SettingsState {
  sec: number;
  /** Row inside the section, or null while the section list has focus. */
  row: number | null;
  /** The text of a row that is being typed, or null. */
  edit: string | null;
  /** Values from config_user, as nested JSON. */
  config: Record<string, unknown>;
}

export interface Flash {
  text: string;
  tone: "info" | "error";
}

export interface AppState {
  conn: Connection;
  view: View;
  back: "home" | "session";
  theme: ThemeName;
  /** Mode and effort of the next turn; the daemon keeps them per turn, the TUI per window. */
  mode: UiMode;
  effort: Effort;
  cols: number;
  rows: number;
  details: boolean;
  workspace: string;
  sessions: WireSessionRow[];
  /** Sessions with a turn that runs now (turns_list). */
  liveSessions: string[];
  sessionId: string | null;
  bySession: Record<string, SessionState>;
  composer: Composer;
  /** -1 when not browsing history. */
  histAt: number;
  history: string[];
  ac: Completion | null;
  files: string[];
  slash: SlashEntry[];
  images: ImageChip[];
  palette: PaletteState;
  model: ModelPicker;
  models: ModelRow[];
  connectedProviders: string[];
  /** Chosen for the next turn: `provider/model`. */
  defaultModel: string | null;
  review: ReviewState;
  settings: SettingsState;
  /** Copy feedback: the key of the turn just copied. */
  copied: string | null;
  /** Time of the last esc and the last ctrl+c: a second one within a window means something else. */
  lastEsc: number;
  lastInterrupt: number;
  flash: Flash | null;
  nextId: number;
}
