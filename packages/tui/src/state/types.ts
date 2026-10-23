import type { Completion, SlashEntry } from "../input/completion.ts";
import type { Composer } from "../input/composer.ts";
import type { MdState } from "../render-model/markdown.ts";
import type {
  WireGitStatus,
  WireSessionRow,
  WireStatus,
  WireTodo,
  WireToolMeta,
  WireTurnEnd,
  WireUsage,
} from "./wire.ts";

export type UiMode = "build" | "plan" | "auto";
export const MODES: readonly UiMode[] = ["build", "plan", "auto"];

/** The daemon's permission mode of each canvas mode: build is the daemon default. */
export const PERMISSION_OF: Readonly<Record<UiMode, string>> = { build: "ask", plan: "plan", auto: "auto" };

export type ThemeName = "agency" | "night" | "light";
export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
/** The scale in order; a model's own levels are a subset. */
export const EFFORTS: readonly Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

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
  /** What the tool measured: exit code, +N −M, line count. Absent in a session loaded from its file. */
  meta?: WireToolMeta;
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

/** The plan_exit ask: the tool name the daemon uses, and the three answers of its panel in list order. */
export const PLAN_TOOL = "plan_exit";
export const PLAN_CHOICES = ["auto", "manual", "keep"] as const;
export type PlanChoice = (typeof PLAN_CHOICES)[number];

/** The panel of one plan ask; `requestId` ties it to the ask, so a new ask starts fresh. */
export interface PlanUi {
  requestId: string;
  /** Index in PLAN_CHOICES. */
  at: number;
  /** Plan rows scrolled up out of view. */
  scroll: number;
  /** Feedback typed on "keep planning". */
  note: string;
  /** How far the plan can scroll, as the view measured it; null until it was drawn. */
  max: number | null;
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
  /** The turn's own end record from the daemon: the commit it made and the checks it ran. */
  end?: WireTurnEnd;
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
  /** Absent for a command loaded from the session file. */
  exitCode?: number;
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
  /** A summary that is being written now: since when, and its tokens so far. */
  compaction: { at: number; tokens: number } | null;
  queue: QueueItem[];
  status: WireStatus | null;
  /** The statusLine command output. */
  statusLine: string | null;
  todos: WireTodo[];
  /** Rows scrolled back from the newest (wheel, pgup). */
  scroll: number;
  /** The most rows there are to scroll back, as the view last measured them; null until it reached the oldest block. */
  scrollMax: number | null;
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
  /** Levels the model takes, in scale order; just `off` when it has no reasoning control. */
  efforts: readonly Effort[];
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
  /** `committed on dev` or `committed and pushed to origin/dev`, once a commit landed. */
  commitNote: string;
  /** Rows the diff of the picked file is scrolled down. */
  scroll: number;
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
  /** Mode and preferred effort of the next turn; the daemon keeps them per turn, the TUI per window. */
  mode: UiMode;
  effort: Effort;
  cols: number;
  rows: number;
  details: boolean;
  workspace: string;
  sessions: WireSessionRow[];
  /** Spend of the last 7 days over every session (cost_report since); null until loaded. */
  weekCostUsd: number | null;
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
  /** Where each connected key comes from: a variable name, "login", "keychain" or "config". */
  keySource: Record<string, string>;
  /** Chosen for the next turn: `provider/model`. */
  defaultModel: string | null;
  review: ReviewState;
  planUi: PlanUi;
  settings: SettingsState;
  /** Copy feedback: the key of the turn just copied. */
  copied: string | null;
  /** Time of the last esc and the last ctrl+c: a second one within a window means something else. */
  lastEsc: number;
  lastInterrupt: number;
  flash: Flash | null;
  nextId: number;
}
