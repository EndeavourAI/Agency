import type { SlashEntry } from "../input/completion.ts";
import type { Connection, Effort, ImageChip, ModelRow, QueueItem, ThemeName, UiMode, View } from "./types.ts";
import type {
  WireEntry,
  WireEvent,
  WireGitDiff,
  WireGitStatus,
  WireSessionRow,
  WireStatus,
  WireTodo,
} from "./wire.ts";

export type ComposerOp =
  | { op: "insert"; text: string }
  | { op: "newline" }
  | { op: "backspace" }
  | { op: "delete" }
  | { op: "left" }
  | { op: "right" }
  | { op: "home" }
  | { op: "end" }
  | { op: "wordLeft" }
  | { op: "wordRight" }
  | { op: "deleteWord" }
  | { op: "toStart" }
  | { op: "toEnd" }
  | { op: "up" }
  | { op: "down" }
  | { op: "set"; text: string; shell?: boolean }
  | { op: "clear" };

/** What the daemon or the RPC layer tells the reducer. Every one carries ids so a late event finds its turn. */
export type DaemonEvent =
  | { type: "conn"; status: Connection }
  | { type: "sessions_loaded"; rows: WireSessionRow[] }
  | { type: "live_turns"; sessionIds: string[] }
  | { type: "session_live"; sessionId: string; live: boolean }
  | { type: "session_loading"; sessionId: string }
  | { type: "session_loaded"; sessionId: string; entries: WireEntry[]; tipId: string | null }
  | { type: "status_loaded"; sessionId: string; status: WireStatus; line: string | null }
  | { type: "todos_loaded"; sessionId: string; todos: WireTodo[] }
  | { type: "files_loaded"; files: string[] }
  | { type: "slash_loaded"; slash: SlashEntry[] }
  | { type: "history_loaded"; prompts: string[] }
  | { type: "models_loaded"; models: ModelRow[]; connected: string[]; defaultModel: string | null }
  | { type: "git_loaded"; git: WireGitStatus; diff?: WireGitDiff }
  | { type: "config_loaded"; config: Record<string, unknown>; theme?: ThemeName }
  | {
      type: "turn_started";
      sessionId: string;
      turnId: string;
      prompt: string;
      images: ImageChip[];
      at: number;
    }
  | { type: "turn_event"; sessionId: string; turnId: string; event: WireEvent; at: number }
  | {
      type: "turn_finished";
      sessionId: string;
      turnId: string;
      at: number;
      outcome: { stopReason?: string; cancelled?: boolean; error?: { code: string; message: string } };
    }
  | { type: "turn_stopped"; sessionId: string; turnId: string; at: number }
  | {
      type: "approval_answered";
      sessionId: string;
      turnId: string;
      requestId: string;
      decision: "once" | "always" | "reject";
    }
  | { type: "prompt_queued"; sessionId: string; item: QueueItem }
  | { type: "queue_shifted"; sessionId: string; id: string }
  | { type: "shell_started"; sessionId: string; id: string; cmd: string }
  | { type: "shell_finished"; sessionId: string; id: string; output: string; isError: boolean }
  | { type: "session_opened"; sessionId: string; title?: string }
  | { type: "model_applied"; sessionId: string | null; ref: string }
  | { type: "notice"; sessionId: string; id: string; text: string }
  | { type: "committed"; pushed: boolean }
  | { type: "suggestion_used"; sessionId: string };

/** What the person does at the keyboard. */
export type UiEvent =
  | { type: "viewport"; cols: number; rows: number }
  | { type: "go"; view: View }
  | { type: "new_session" }
  | { type: "mode_cycle"; back?: boolean }
  | { type: "mode_set"; mode: UiMode }
  | { type: "palette_toggle" }
  | { type: "palette_close" }
  | { type: "palette_query"; q: string }
  | { type: "palette_move"; d: number; n: number }
  | { type: "model_open" }
  | { type: "model_close" }
  | { type: "model_query"; q: string }
  | { type: "model_move"; d: number; n: number }
  | { type: "effort_set"; effort: Effort }
  | { type: "details_toggle" }
  | { type: "review_open" }
  | { type: "review_close" }
  | { type: "review_file"; i: number }
  | { type: "pick_enter" }
  | { type: "pick_move"; d: number }
  | { type: "pick_exit" }
  | { type: "outputs_toggle" }
  | { type: "thinking_toggle" }
  | { type: "copied"; key: string | null }
  | { type: "scroll"; d: number }
  | { type: "scroll_latest" }
  | { type: "edit"; edit: ComposerOp }
  | { type: "ac_move"; d: number; n: number }
  | { type: "ac_close" }
  | { type: "ac_accept"; text: string }
  | { type: "history"; dir: "prev" | "next" }
  | { type: "image_added"; chip: ImageChip }
  | { type: "settings_move"; d: number }
  | { type: "settings_in" }
  | { type: "settings_out" }
  | { type: "settings_value"; path: string; value: unknown }
  | { type: "flash"; text: string; tone: "info" | "error" }
  | { type: "flash_clear" }
  | { type: "composer_sent" }
  | { type: "esc"; at: number }
  | { type: "interrupt"; at: number };

export type Event = DaemonEvent | UiEvent;
