/**
 * Keys and pastes to events and effects: the behaviour of the canvas `onRootKey`, `onSessionKey`, `onHomeKey`,
 * `onPaletteKey` and `onModelKey`, as a pure function of the state. Nothing runs here; the client layer runs effects.
 */
import { CLIENT_SLASH, type SlashEntry } from "../input/completion.ts";
import { continueLine, isEmpty, submitted } from "../input/composer.ts";
import { type Command, type Context, resolveKey } from "../input/keymap.ts";
import type { KeyEvent } from "../input/keys.ts";
import {
  canRetry,
  completion,
  current,
  flatModels,
  isHalted,
  isWorking,
  paletteItems,
  runningTurn,
  settingValue,
} from "../state/derive.ts";
import type { Event } from "../state/events.ts";
import { nextValue, parseText, SETTINGS } from "../state/settings.ts";
import {
  type AppState,
  type Block,
  EFFORTS,
  type Effort,
  type QueueItem,
  type Turn,
} from "../state/types.ts";
import type { Effect } from "./effects.ts";

export interface Out {
  events: Event[];
  effects: Effect[];
}

export interface KeyContext {
  now: number;
  /** A fresh unique id: turn ids, session ids and queue ids come from here so the reducer stays pure. */
  newId: () => string;
}

const none: Out = { events: [], effects: [] };
const out = (events: Event[], effects: Effect[] = []): Out => ({ events, effects });

const ESC_TWICE_MS = 600;
const QUIT_TWICE_MS = 1500;

/** The focused context first, `global` last; an open dialog hides the global keys it does not own. */
export function activeContexts(state: AppState): Context[] {
  if (state.model.open) return ["overlay"];
  if (state.palette.open) return ["overlay", "global"];
  if (state.view === "settings")
    return [state.settings.edit === null ? "settings" : "settingsEdit", "global"];
  if (state.conn === "offline") return ["offline", "global"];
  const s = current(state);
  if (state.view === "session") {
    if (runningTurn(s)?.approval && !state.review.open) return ["approval", "global"];
    if (state.review.open) return ["review", "global"];
    if (s && s.pickAt !== null) return ["pick", "global"];
  }
  if (state.ac && completion(state).length > 0) return ["completion", "composer", "global"];
  return ["composer", "global"];
}

/** Only these global keys work while the palette is open. */
const PALETTE_GLOBALS: ReadonlySet<Command> = new Set(["palette.toggle", "settings.open"]);

function startPrompt(state: AppState, ctx: KeyContext, text: string, kind: "prompt" | "shell"): Out {
  const sessionId = state.sessionId ?? ctx.newId();
  const create = state.sessionId === null;
  const events: Event[] = [];
  if (create) events.push({ type: "session_opened", sessionId });
  events.push({ type: "composer_sent" });
  if (kind === "shell") {
    const id = ctx.newId();
    events.push({ type: "shell_started", sessionId, id, cmd: text });
    return out(events, [{ type: "shell_run", sessionId, id, command: text }]);
  }
  const turnId = ctx.newId();
  events.push({ type: "turn_started", sessionId, turnId, prompt: text, images: state.images, at: ctx.now });
  return out(events, [
    {
      type: "send_turn",
      sessionId,
      turnId,
      text,
      images: state.images,
      mode: state.mode,
      effort: state.effort,
      model: state.bySession[sessionId]?.model ?? state.defaultModel,
      create,
    },
  ]);
}

/** Sends a queued item now; also how the client drains the queue after a turn ends. */
export function sendQueued(state: AppState, ctx: KeyContext, item: QueueItem): Out {
  const sessionId = state.sessionId;
  if (!sessionId) return none;
  const shift: Event = { type: "queue_shifted", sessionId, id: item.id };
  if (item.kind === "shell") {
    const id = ctx.newId();
    return out(
      [shift, { type: "shell_started", sessionId, id, cmd: item.text }],
      [{ type: "shell_run", sessionId, id, command: item.text }],
    );
  }
  const turnId = ctx.newId();
  return out(
    [shift, { type: "turn_started", sessionId, turnId, prompt: item.text, images: item.images, at: ctx.now }],
    [
      {
        type: "send_turn",
        sessionId,
        turnId,
        text: item.text,
        images: item.images,
        mode: state.mode,
        effort: state.effort,
        model: state.bySession[sessionId]?.model ?? state.defaultModel,
        create: false,
      },
    ],
  );
}

/** After a turn ends on its own, the next queued prompt goes; after a stop it waits for enter. */
export function drainQueue(state: AppState, ctx: KeyContext): Out {
  const s = current(state);
  if (!s || s.runningTurnId !== null || isHalted(state) || state.conn === "offline") return none;
  const first = s.queue[0];
  return first ? sendQueued(state, ctx, first) : none;
}

function clientAct(act: NonNullable<SlashEntry["act"]>): Out {
  switch (act) {
    case "review":
      return out([{ type: "review_open" }], [{ type: "load_review" }]);
    case "focus":
    case "details":
      return out([{ type: "details_toggle" }]);
    case "home":
      return out([{ type: "new_session" }]);
    case "model":
      return out([{ type: "model_open" }]);
    case "mode":
      return out([{ type: "mode_cycle" }]);
    case "turns":
      return out([{ type: "pick_enter" }]);
    case "settings":
      return out([{ type: "go", view: "settings" }], [{ type: "load_settings" }]);
  }
}

function submit(state: AppState, ctx: KeyContext): Out {
  const c = state.composer;
  const cont = continueLine(c);
  if (cont)
    return out([
      { type: "edit", edit: { op: "backspace" } },
      { type: "edit", edit: { op: "newline" } },
    ]);
  const text = submitted(c);
  const s = current(state);
  if (text === "" && state.images.length === 0) {
    if (isHalted(state) && s && s.queue[0]) return sendQueued(state, ctx, s.queue[0]);
    if (canRetry(state) && s) {
      const last = s.blocks.findLast((b): b is Turn => b.kind === "turn");
      if (last) return startPrompt({ ...state, images: [] }, ctx, last.prompt, "prompt");
    }
    return none;
  }
  if (!c.shell) {
    const act = [...CLIENT_SLASH, ...state.slash].find((x) => `/${x.name}` === text && x.act);
    if (act?.act) {
      const a = clientAct(act.act);
      return out([{ type: "composer_sent" }, ...a.events], a.effects);
    }
    if (text.startsWith("/") && state.sessionId) {
      return out([{ type: "composer_sent" }], [{ type: "slash_command", sessionId: state.sessionId, text }]);
    }
  }
  const kind = c.shell ? "shell" : "prompt";
  if (isWorking(state) && state.conn !== "offline" && state.sessionId) {
    const item: QueueItem = { id: ctx.newId(), kind, text, images: state.images };
    return out([{ type: "prompt_queued", sessionId: state.sessionId, item }, { type: "composer_sent" }]);
  }
  return startPrompt(state, ctx, text, kind);
}

function pickedTurn(state: AppState): { block: Block; index: number } | null {
  const s = current(state);
  if (!s || s.pickAt === null) return null;
  const block = s.blocks[s.pickAt];
  return block ? { block, index: s.pickAt } : null;
}

function approve(state: AppState, decision: "once" | "always" | "reject"): Out {
  const s = current(state);
  const t = runningTurn(s);
  if (!s || !t?.approval || s.runningTurnId === null) return none;
  const event: Event = {
    type: "approval_answered",
    sessionId: s.id,
    turnId: t.id,
    requestId: t.approval.requestId,
    decision,
  };
  const respond: Effect = { type: "respond", sessionId: s.id, requestId: t.approval.requestId, decision };
  // A denial stops the turn, as the canvas does; the daemon alone would let the model go on without the tool.
  return decision === "reject"
    ? out([event], [respond, { type: "cancel_turn", turnId: t.id }])
    : out([event], [respond]);
}

function overlayRun(state: AppState): Out {
  if (state.model.open) {
    const m = flatModels(state)[state.model.at];
    return m ? out([{ type: "model_applied", sessionId: state.sessionId, ref: m.ref }]) : none;
  }
  const item = paletteItems(state)[state.palette.at];
  if (!item) return none;
  if (item.kind === "session")
    return out(
      [
        { type: "session_opened", sessionId: item.ref },
        { type: "session_loading", sessionId: item.ref },
      ],
      [{ type: "open_session", sessionId: item.ref }],
    );
  const a = clientAct(item.ref as NonNullable<SlashEntry["act"]>);
  return out([{ type: "palette_close" }, ...a.events], a.effects);
}

function run(state: AppState, command: Command, ctx: KeyContext): Out {
  const s = current(state);
  switch (command) {
    case "palette.toggle":
      return out([{ type: "palette_toggle" }]);
    case "settings.open":
      return out([{ type: "go", view: "settings" }], [{ type: "load_settings" }]);
    case "review.toggle":
      return state.review.open && state.view === "session"
        ? out([{ type: "review_close" }])
        : out([{ type: "review_open" }], [{ type: "load_review" }]);
    case "details.toggle":
      return out([{ type: "details_toggle" }]);
    case "session.new":
      return out([{ type: "new_session" }]);
    case "interrupt": {
      if (!isEmpty(state.composer) || state.images.length)
        return out([{ type: "edit", edit: { op: "clear" } }]);
      if (isWorking(state) && s?.runningTurnId)
        return out(
          [{ type: "turn_stopped", sessionId: s.id, turnId: s.runningTurnId, at: ctx.now }],
          [{ type: "cancel_turn", turnId: s.runningTurnId }],
        );
      if (ctx.now - state.lastInterrupt < QUIT_TWICE_MS) return out([], [{ type: "quit" }]);
      return out([
        { type: "interrupt", at: ctx.now },
        { type: "flash", text: "press ctrl+c again to quit", tone: "info" },
      ]);
    }
    case "mode.next":
      return out([{ type: "mode_cycle" }]);
    case "mode.prev":
      return out([{ type: "mode_cycle", back: true }]);
    case "escape": {
      if (s && isWorking(state) && s.runningTurnId)
        return out(
          [
            { type: "esc", at: ctx.now },
            { type: "turn_stopped", sessionId: s.id, turnId: s.runningTurnId, at: ctx.now },
          ],
          [{ type: "cancel_turn", turnId: s.runningTurnId }],
        );
      const twice = ctx.now - state.lastEsc < ESC_TWICE_MS;
      return out(
        twice ? [{ type: "esc", at: ctx.now }, { type: "pick_enter" }] : [{ type: "esc", at: ctx.now }],
      );
    }
    case "submit":
      return submit(state, ctx);
    case "newline":
      return out([{ type: "edit", edit: { op: "newline" } }]);
    case "history.prev":
      return !state.composer.text || state.histAt >= 0
        ? out([{ type: "history", dir: "prev" }])
        : out([{ type: "edit", edit: { op: "up" } }]);
    case "history.next":
      return state.histAt >= 0
        ? out([{ type: "history", dir: "next" }])
        : out([{ type: "edit", edit: { op: "down" } }]);
    case "cursor.up":
      return out([{ type: "edit", edit: { op: "up" } }]);
    case "cursor.down":
      return out([{ type: "edit", edit: { op: "down" } }]);
    case "cursor.left":
      return out([{ type: "edit", edit: { op: "left" } }]);
    case "cursor.right":
      return out([{ type: "edit", edit: { op: "right" } }]);
    case "cursor.home":
      return out([{ type: "edit", edit: { op: "home" } }]);
    case "cursor.end":
      return out([{ type: "edit", edit: { op: "end" } }]);
    case "cursor.wordLeft":
      return out([{ type: "edit", edit: { op: "wordLeft" } }]);
    case "cursor.wordRight":
      return out([{ type: "edit", edit: { op: "wordRight" } }]);
    case "delete.back":
      if (state.palette.open)
        return out([{ type: "palette_query", q: [...state.palette.query].slice(0, -1).join("") }]);
      if (state.model.open)
        return out([{ type: "model_query", q: [...state.model.q].slice(0, -1).join("") }]);
      if (state.settings.edit !== null && state.view === "settings")
        return out([{ type: "settings_edit", text: [...state.settings.edit].slice(0, -1).join("") }]);
      return out([{ type: "edit", edit: { op: "backspace" } }]);
    case "delete.forward":
      return out([{ type: "edit", edit: { op: "delete" } }]);
    case "delete.word":
      return out([{ type: "edit", edit: { op: "deleteWord" } }]);
    case "delete.toStart":
      return out([{ type: "edit", edit: { op: "toStart" } }]);
    case "delete.toEnd":
      return out([{ type: "edit", edit: { op: "toEnd" } }]);
    case "scroll.pageUp":
      return out([{ type: "scroll", d: 1 }]);
    case "scroll.pageDown":
      return out([{ type: "scroll", d: -1 }]);
    case "scroll.latest":
      return out([{ type: "scroll_latest" }]);
    case "completion.next":
      return out([{ type: "ac_move", d: 1, n: completion(state).length }]);
    case "completion.prev":
      return out([{ type: "ac_move", d: -1, n: completion(state).length }]);
    case "completion.accept": {
      const items = completion(state);
      const item = items[Math.min(state.ac?.i ?? 0, items.length - 1)];
      return item ? out([{ type: "ac_accept", text: item.text }]) : none;
    }
    case "completion.close":
      return out([{ type: "ac_close" }]);
    case "pick.prev":
      return out([{ type: "pick_move", d: -1 }]);
    case "pick.next":
      return out([{ type: "pick_move", d: 1 }]);
    case "pick.outputs":
      return out([{ type: "outputs_toggle" }]);
    case "pick.copy": {
      const p = pickedTurn(state);
      if (!p || p.block.kind !== "turn") return none;
      return out([{ type: "copied", key: p.block.id }], [{ type: "copy", text: p.block.text }]);
    }
    case "pick.thinking":
      return out([{ type: "thinking_toggle" }]);
    case "pick.exit":
      return out([{ type: "pick_exit" }]);
    case "overlay.close":
      return state.model.open ? out([{ type: "model_close" }]) : out([{ type: "palette_close" }]);
    case "overlay.next":
      return state.model.open
        ? out([{ type: "model_move", d: 1, n: flatModels(state).length }])
        : out([{ type: "palette_move", d: 1, n: paletteItems(state).length }]);
    case "overlay.prev":
      return state.model.open
        ? out([{ type: "model_move", d: -1, n: flatModels(state).length }])
        : out([{ type: "palette_move", d: -1, n: paletteItems(state).length }]);
    case "overlay.run":
      return overlayRun(state);
    case "approve.once":
      return approve(state, "once");
    case "approve.always":
      return approve(state, "always");
    case "approve.deny":
      return approve(state, "reject");
    case "review.close":
      return out([{ type: "review_close" }]);
    case "review.commit":
    case "review.commitPush": {
      const files = state.review.git?.files?.length ?? 0;
      if (files === 0 || state.review.committed) return none;
      return out([], [{ type: "commit", push: command === "review.commitPush" }]);
    }
    case "review.fileNext":
    case "review.filePrev": {
      const n = (state.review.git?.files?.length ?? 0) + state.review.untracked.length;
      if (n === 0) return none;
      const d = command === "review.fileNext" ? 1 : -1;
      return out([{ type: "review_file", i: Math.max(0, Math.min(n - 1, state.review.file + d)) }]);
    }
    case "settings.down":
      return out([{ type: "settings_move", d: 1 }]);
    case "settings.up":
      return out([{ type: "settings_move", d: -1 }]);
    case "settings.in":
      return out([{ type: "settings_in" }]);
    case "settings.out":
      return out([{ type: "settings_out" }]);
    case "settings.change": {
      const { sec, row } = state.settings;
      if (row === null) return out([{ type: "settings_in" }]);
      const r = SETTINGS[sec]?.rows[row];
      if (!r) return none;
      if (r.kind === "model") return out([{ type: "model_open" }]);
      if (r.kind === "text") return out([{ type: "settings_edit", text: String(settingValue(state, r)) }]);
      if (r.kind === "info") return none;
      const value = nextValue(r, settingValue(state, r));
      return out(
        [{ type: "settings_value", path: r.key, value }],
        [{ type: "config_write", key: r.key, value }],
      );
    }
    case "settings.editCommit": {
      const r = SETTINGS[state.settings.sec]?.rows[state.settings.row ?? -1];
      const text = state.settings.edit;
      if (!r || text === null) return none;
      const parsed = parseText(r.key, text);
      if (parsed instanceof Error)
        return out([
          { type: "settings_edit", text: null },
          { type: "flash", text: parsed.message, tone: "error" },
        ]);
      return out(
        [
          { type: "settings_edit", text: null },
          { type: "settings_value", path: r.key, value: parsed },
        ],
        [{ type: "config_write", key: r.key, value: parsed }],
      );
    }
    case "settings.editCancel":
      return out([{ type: "settings_edit", text: null }]);
    case "overlay.left":
    case "overlay.right": {
      if (!state.model.open) return none;
      const i = EFFORTS.indexOf(state.effort);
      const d = command === "overlay.right" ? 1 : EFFORTS.length - 1;
      return out([{ type: "effort_set", effort: EFFORTS[(i + d) % EFFORTS.length] as Effort }]);
    }
    case "connection.retry":
      return out([], [{ type: "reconnect" }]);
    case "paste.image":
      return out([], [{ type: "paste_image" }]);
  }
}

/** One key press: its events and effects. Releases and unknown keys do nothing. */
export function dispatchKey(state: AppState, key: KeyEvent, ctx: KeyContext): Out {
  if (key.kind === "release") return none;
  const contexts = activeContexts(state);
  // A completion list owns escape even when it is empty, so esc closes it without stopping the turn.
  if (
    state.ac &&
    contexts.includes("composer") &&
    !contexts.includes("completion") &&
    key.key === "escape" &&
    !key.ctrl &&
    !key.alt
  )
    return out([{ type: "ac_close" }]);
  const local = resolveKey(
    contexts.filter((c) => c !== "global"),
    key,
  );
  if (local !== undefined) return run(state, local, ctx);
  const global = contexts.includes("global") ? resolveKey(["global"], key) : undefined;
  if (global !== undefined)
    return state.palette.open && !PALETTE_GLOBALS.has(global) ? none : run(state, global, ctx);
  if (key.text === undefined) return none;
  // Typed text goes to whatever takes input now.
  if (contexts[0] === "settingsEdit" && state.settings.edit !== null)
    return out([{ type: "settings_edit", text: state.settings.edit + key.text }]);
  if (state.model.open) return out([{ type: "model_query", q: state.model.q + key.text }]);
  if (state.palette.open) return out([{ type: "palette_query", q: state.palette.query + key.text }]);
  if (contexts[0] === "composer" || contexts[0] === "completion")
    return out([{ type: "edit", edit: { op: "insert", text: key.text } }]);
  return none;
}

/** A bracketed paste: text lands in the composer, or in the query of the open dialog. */
export function dispatchPaste(state: AppState, text: string): Out {
  const clean = text.replace(/\r\n?/g, "\n");
  if (state.model.open) return out([{ type: "model_query", q: state.model.q + clean.replace(/\n/g, " ") }]);
  if (state.palette.open)
    return out([{ type: "palette_query", q: state.palette.query + clean.replace(/\n/g, " ") }]);
  const contexts = activeContexts(state);
  if (contexts[0] !== "composer" && contexts[0] !== "completion") return none;
  return out([{ type: "edit", edit: { op: "insert", text: clean } }]);
}
