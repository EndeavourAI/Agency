import { type KeyEvent, keyId } from "./keys.ts";

/** Which part of the screen owns the keys; `global` is always last in the lookup order. */
export type Context =
  | "completion"
  | "composer"
  | "pick"
  | "overlay"
  | "approval"
  | "review"
  | "settings"
  | "settingsEdit"
  | "offline"
  | "global";

/** What a key means; the controller turns a command and the current state into events and daemon calls. */
export type Command =
  | "palette.toggle"
  | "settings.open"
  | "review.toggle"
  | "details.toggle"
  | "session.new"
  | "interrupt"
  | "mode.next"
  | "mode.prev"
  | "escape"
  | "submit"
  | "newline"
  | "history.prev"
  | "history.next"
  | "cursor.up"
  | "cursor.down"
  | "cursor.left"
  | "cursor.right"
  | "cursor.home"
  | "cursor.end"
  | "cursor.wordLeft"
  | "cursor.wordRight"
  | "paste.image"
  | "delete.back"
  | "delete.forward"
  | "delete.word"
  | "delete.toStart"
  | "delete.toEnd"
  | "scroll.pageUp"
  | "scroll.pageDown"
  | "scroll.latest"
  | "completion.next"
  | "completion.prev"
  | "completion.accept"
  | "completion.close"
  | "pick.prev"
  | "pick.next"
  | "pick.outputs"
  | "pick.copy"
  | "pick.thinking"
  | "pick.exit"
  | "overlay.close"
  | "overlay.next"
  | "overlay.prev"
  | "overlay.run"
  | "approve.once"
  | "approve.always"
  | "approve.deny"
  | "review.close"
  | "review.commit"
  | "review.commitPush"
  | "review.fileNext"
  | "review.filePrev"
  | "settings.down"
  | "settings.up"
  | "settings.in"
  | "settings.out"
  | "settings.change"
  | "settings.editCommit"
  | "settings.editCancel"
  | "overlay.left"
  | "overlay.right"
  | "connection.retry";

type Table = Readonly<Record<string, Command>>;

/**
 * Every binding of the canvas and the brief, by context. Keys are `keyId` strings. Legacy terminals send LF for
 * ctrl+enter, which decodes as ctrl+j, so review binds both to commit and push; the composer reads ctrl+j as a new line.
 */
export const KEYMAP: Readonly<Record<Context, Table>> = {
  global: {
    "ctrl+p": "palette.toggle",
    "ctrl+,": "settings.open",
    "ctrl+r": "review.toggle",
    "ctrl+d": "details.toggle",
    "ctrl+n": "session.new",
    "ctrl+c": "interrupt",
  },
  composer: {
    tab: "mode.next",
    "shift+tab": "mode.prev",
    enter: "submit",
    "ctrl+j": "newline",
    "alt+enter": "newline",
    "shift+enter": "newline",
    up: "history.prev",
    down: "history.next",
    left: "cursor.left",
    right: "cursor.right",
    home: "cursor.home",
    end: "cursor.end",
    "ctrl+a": "cursor.home",
    "ctrl+e": "cursor.end",
    "alt+b": "cursor.wordLeft",
    "alt+f": "cursor.wordRight",
    "ctrl+left": "cursor.wordLeft",
    "ctrl+right": "cursor.wordRight",
    backspace: "delete.back",
    delete: "delete.forward",
    "ctrl+w": "delete.word",
    "alt+backspace": "delete.word",
    "ctrl+u": "delete.toStart",
    "ctrl+k": "delete.toEnd",
    pageup: "scroll.pageUp",
    pagedown: "scroll.pageDown",
    "ctrl+end": "scroll.latest",
    "ctrl+v": "paste.image",
    "alt+v": "paste.image",
    escape: "escape",
  },
  completion: {
    up: "completion.prev",
    down: "completion.next",
    tab: "completion.accept",
    enter: "completion.accept",
    escape: "completion.close",
  },
  pick: {
    up: "pick.prev",
    down: "pick.next",
    enter: "pick.outputs",
    o: "pick.outputs",
    c: "pick.copy",
    t: "pick.thinking",
    escape: "pick.exit",
    pageup: "scroll.pageUp",
    pagedown: "scroll.pageDown",
    "ctrl+end": "scroll.latest",
  },
  overlay: {
    escape: "overlay.close",
    down: "overlay.next",
    up: "overlay.prev",
    enter: "overlay.run",
    backspace: "delete.back",
    left: "overlay.left",
    right: "overlay.right",
  },
  approval: {
    y: "approve.once",
    a: "approve.always",
    n: "approve.deny",
    escape: "approve.deny",
  },
  review: {
    escape: "review.close",
    enter: "review.commit",
    "ctrl+enter": "review.commitPush",
    "ctrl+j": "review.commitPush",
    down: "review.fileNext",
    up: "review.filePrev",
  },
  settings: {
    down: "settings.down",
    up: "settings.up",
    right: "settings.in",
    left: "settings.out",
    enter: "settings.change",
    space: "settings.change",
    escape: "settings.out",
  },
  settingsEdit: { enter: "settings.editCommit", escape: "settings.editCancel", backspace: "delete.back" },
  offline: { r: "connection.retry" },
};

/** First context that binds the key wins; callers list the focused context first and `global` last. */
export function resolveKey(contexts: readonly Context[], e: KeyEvent): Command | undefined {
  const id = keyId(e);
  for (const c of contexts) {
    const hit = KEYMAP[c][id];
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** The label a hint row shows for a binding, e.g. "ctrl+p". */
export function bindingFor(context: Context, command: Command): string | undefined {
  return Object.entries(KEYMAP[context]).find(([, c]) => c === command)?.[0];
}
