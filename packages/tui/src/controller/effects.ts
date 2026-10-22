import type { Effort, ImageChip, UiMode } from "../state/types.ts";

/** What the controller asks the outside world to do; the client layer runs each one against the daemon or the OS. */
export type Effect =
  | {
      type: "send_turn";
      sessionId: string;
      turnId: string;
      text: string;
      images: ImageChip[];
      mode: UiMode;
      effort: Effort;
      model: string | null;
      /** True when the session does not exist yet: the client creates it first. */
      create: boolean;
    }
  | { type: "slash_command"; sessionId: string; text: string }
  | { type: "cancel_turn"; turnId: string }
  | { type: "respond"; sessionId: string; requestId: string; decision: "once" | "always" | "reject" }
  | { type: "shell_run"; sessionId: string; id: string; command: string }
  | { type: "config_write"; key: string; value: unknown }
  | { type: "open_session"; sessionId: string }
  | { type: "load_review" }
  | { type: "load_settings" }
  | { type: "commit"; push: boolean }
  | { type: "copy"; text: string }
  | { type: "paste_image" }
  | { type: "reconnect" }
  | { type: "quit" };
