/**
 * Bytes from the terminal to one KeyEvent shape. Legacy CSI/SS3 first; Kitty CSI-u and xterm modifyOtherKeys
 * are decoded too, so the same keymap works whether or not the terminal was asked for them.
 */
export interface KeyEvent {
  type: "key";
  /** Lowercase name: "a", "enter", "tab", "escape", "backspace", "up", "pageup", "f5", "," ... */
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  super: boolean;
  /** Only Kitty reports releases; the decoder drops them unless asked. */
  kind: "press" | "repeat" | "release";
  /** The text this key types (printable, no ctrl/alt/super); undefined for a command key. */
  text?: string;
  raw: string;
}

export interface PasteEvent {
  type: "paste";
  text: string;
}

export interface FocusEvent {
  type: "focus";
  focused: boolean;
}

/** One notch of the mouse wheel: 1 up, -1 down. */
export interface WheelEvent {
  type: "wheel";
  d: 1 | -1;
}

export type InputEvent = KeyEvent | PasteEvent | FocusEvent | WheelEvent;

const ESC = "\x1b";
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

/** `mods` is the wire value: 1 + (shift 1, alt 2, ctrl 4, super 8). */
function key(raw: string, k: string, mods = 1, kind: KeyEvent["kind"] = "press", text?: string): KeyEvent {
  const m = Math.max(0, mods - 1);
  const ctrl = (m & 4) !== 0;
  const alt = (m & 2) !== 0;
  const sup = (m & 8) !== 0;
  const typed = text ?? ([...k].length === 1 && !ctrl && !alt && !sup ? k : undefined);
  const ev: KeyEvent = { type: "key", key: k, ctrl, alt, shift: (m & 1) !== 0, super: sup, kind, raw };
  if (typed !== undefined) ev.text = typed;
  return ev;
}

const CSI_KEYS: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  E: "clear",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};
const TILDE_KEYS: Record<number, string> = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12",
};
const CODE_KEYS: Record<number, string> = {
  9: "tab",
  13: "enter",
  27: "escape",
  32: "space",
  127: "backspace",
};

/** `fromCodePoint` throws on anything else, and the bytes come from outside. */
const isCodePoint = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0x10ffff;

/** Kitty `CSI u` and modifyOtherKeys name a key by its code point. */
function codeKey(code: number): string {
  return CODE_KEYS[code] ?? String.fromCodePoint(code).toLowerCase();
}

/** The C0 control bytes, as the keys a terminal sends for them. */
function c0(ch: string, raw: string): KeyEvent | undefined {
  const c = ch.charCodeAt(0);
  if (c === 0x0d) return key(raw, "enter");
  if (c === 0x09) return key(raw, "tab");
  if (c === 0x7f) return key(raw, "backspace");
  if (c === 0x08) return key(raw, "backspace", 5);
  if (c === 0x00) return key(raw, "space", 5);
  // LF is what ctrl+j sends, and legacy terminals send it for ctrl+enter too: one event, two readings.
  if (c >= 0x01 && c <= 0x1a) return key(raw, String.fromCharCode(c + 96), 5);
  if (c >= 0x1c && c <= 0x1f) return key(raw, String.fromCharCode(c + 64).toLowerCase(), 5);
  return undefined;
}

/** What a sequence decodes to: events and bytes consumed, or "more" when it is cut. */
type Step = { events: InputEvent[]; used: number } | "more";

function parseCsi(data: string, at: number, keepRelease: boolean): Step {
  let i = at + 2;
  while (i < data.length && data.charCodeAt(i) >= 0x30 && data.charCodeAt(i) <= 0x3f) i++;
  const params = data.slice(at + 2, i);
  const interStart = i;
  while (i < data.length && data.charCodeAt(i) >= 0x20 && data.charCodeAt(i) <= 0x2f) i++;
  if (i >= data.length) return "more";
  const final = data[i] as string;
  const raw = data.slice(at, i + 1);
  const used = i + 1 - at;
  const drop: Step = { events: [], used };
  const intermediates = data.slice(interStart, i);
  // SGR mouse report `CSI < b;x;y M`: only the wheel (b 64/65 plus modifier bits 4, 8, 16) means anything here.
  const mouse = /^<(\d+);\d+;\d+$/.exec(params);
  if (mouse && (final === "M" || final === "m") && intermediates === "") {
    const b = Number(mouse[1]) & ~28;
    return b === 64 || b === 65 ? { events: [{ type: "wheel", d: b === 64 ? 1 : -1 }], used } : drop;
  }
  // Replies to our own queries (DA1, DECRPM, kitty flags) arrive as input: never keys.
  if (/^[?>=<]/.test(params) || intermediates !== "") return drop;
  if (final === "I" || final === "O") return { events: [{ type: "focus", focused: final === "I" }], used };
  const nums = params.split(";").map((p) => p.split(":").map((x) => (x === "" ? Number.NaN : Number(x))));
  const first = nums[0]?.[0];
  const modField = nums[1];
  const mods = modField?.[0] !== undefined && !Number.isNaN(modField[0]) ? modField[0] : 1;
  const evNum = modField?.[1];
  const kind: KeyEvent["kind"] = evNum === 2 ? "repeat" : evNum === 3 ? "release" : "press";
  const emit = (ev: KeyEvent): Step =>
    ev.kind === "release" && !keepRelease ? drop : { events: [ev], used };

  if (final === "u") {
    if (first === undefined || !isCodePoint(first)) return drop;
    const textCodes = nums[2];
    if (textCodes?.length && !textCodes.every(isCodePoint)) return drop;
    const text = textCodes?.length ? String.fromCodePoint(...textCodes) : undefined;
    return emit(key(raw, codeKey(first), mods, kind, text));
  }
  if (final === "~") {
    const other = nums[2]?.[0];
    if (first === 27 && other !== undefined)
      return isCodePoint(other) ? emit(key(raw, codeKey(other), mods, kind)) : drop;
    const name = first === undefined ? undefined : TILDE_KEYS[first];
    return name ? emit(key(raw, name, mods, kind)) : drop;
  }
  if (final === "Z") return emit(key(raw, "tab", ((mods - 1) | 1) + 1, kind));
  // A cursor-position reply (`CSI row;col R`) looks like F3 with modifiers; a real F3 report carries a modifier >= 2.
  if (final === "R" && !(first === 1 && mods >= 2)) return drop;
  const name = CSI_KEYS[final];
  return name ? emit(key(raw, name, mods, kind)) : drop;
}

function parseSs3(data: string, at: number): Step {
  if (at + 2 >= data.length) return "more";
  const final = data[at + 2] as string;
  const name = CSI_KEYS[final];
  return { events: name ? [key(data.slice(at, at + 3), name)] : [], used: 3 };
}

/** Skips an OSC/DCS/APC/PM string (a terminal reply) up to BEL or ST. */
function skipString(data: string, at: number): Step {
  for (let i = at + 2; i < data.length; i++) {
    if (data[i] === "\x07") return { events: [], used: i + 1 - at };
    if (data[i] === ESC && data[i + 1] === "\\") return { events: [], used: i + 2 - at };
  }
  return "more";
}

function partialSuffix(text: string, terminator: string): number {
  for (let n = Math.min(terminator.length - 1, text.length); n > 0; n--) {
    if (terminator.startsWith(text.slice(text.length - n))) return n;
  }
  return 0;
}

export interface DecoderOptions {
  keepRelease?: boolean;
}

/**
 * Stateful decoder: bytes may split anywhere, including inside a paste. A lone ESC stays pending until
 * `flush()` (the caller's timer) because it may begin a sequence.
 */
export class InputDecoder {
  private buf = "";
  private paste: string | null = null;

  constructor(private readonly options: DecoderOptions = {}) {}

  push(chunk: string): InputEvent[] {
    this.buf += chunk;
    return this.drain(false);
  }

  /** Call after a short quiet period: a pending ESC is the escape key, a cut sequence is dropped. */
  flush(): InputEvent[] {
    return this.drain(true);
  }

  private drain(flush: boolean): InputEvent[] {
    const out: InputEvent[] = [];
    const data = this.buf;
    let at = 0;
    while (at < data.length) {
      if (this.paste !== null) {
        const end = data.indexOf(PASTE_END, at);
        if (end === -1) {
          // Keep a possible partial terminator in the buffer; the rest is paste text.
          const keep = flush ? 0 : partialSuffix(data.slice(at), PASTE_END);
          this.paste += data.slice(at, data.length - keep);
          at = data.length - keep;
          break;
        }
        out.push({ type: "paste", text: this.paste + data.slice(at, end) });
        this.paste = null;
        at = end + PASTE_END.length;
        continue;
      }
      const ch = data[at] as string;
      if (ch !== ESC) {
        const cp = data.codePointAt(at) as number;
        const text = String.fromCodePoint(cp);
        const ctl = c0(text, text);
        if (ctl) out.push(ctl);
        else if (cp === 0x20) out.push(key(text, "space", 1, "press", " "));
        else if (cp > 0x20 && cp !== 0x7f) out.push(key(text, text, 1, "press", text));
        at += text.length;
        continue;
      }
      if (data.startsWith(PASTE_START, at)) {
        this.paste = "";
        at += PASTE_START.length;
        continue;
      }
      if (at + 1 >= data.length) {
        if (!flush) break;
        out.push(key(ESC, "escape"));
        at += 1;
        continue;
      }
      // Legacy alt+arrow is ESC then the whole sequence (`ESC ESC [ A`): decode the rest and mark it alt.
      const alt = data[at + 1] === ESC && at + 2 < data.length;
      if (data[at + 1] === ESC && at + 2 >= data.length && !flush) break;
      const from = alt ? at + 1 : at;
      const next = data[from + 1] as string;
      let step: Step | undefined;
      if (next === "[") step = parseCsi(data, from, this.options.keepRelease ?? false);
      else if (next === "O") step = parseSs3(data, from);
      else if ("]P_^X".includes(next)) step = skipString(data, from);
      if (step === "more") {
        if (!flush) break;
        at = data.length; // a sequence that never finished
        break;
      }
      if (step) {
        const raw = data.slice(at, from + step.used);
        out.push(...step.events.map((ev) => (alt && ev.type === "key" ? { ...ev, alt: true, raw } : ev)));
        at = from + step.used;
        continue;
      }
      // ESC then one char: alt+char, alt+enter, alt+backspace.
      const inner = String.fromCodePoint(data.codePointAt(at + 1) as number);
      const raw = data.slice(at, at + 1 + inner.length);
      const base = c0(inner, raw);
      out.push(
        base
          ? { ...base, alt: true, raw }
          : key(raw, inner.toLowerCase(), inner === inner.toLowerCase() ? 3 : 4),
      );
      at += raw.length;
    }
    this.buf = flush ? "" : data.slice(at);
    return out;
  }
}

/** Canonical id of a key for the keymap: "ctrl+shift+p", "shift+tab", "enter", "a". */
export function keyId(e: KeyEvent): string {
  const mods = [e.ctrl && "ctrl", e.alt && "alt", e.shift && "shift", e.super && "super"].filter(Boolean);
  return [...mods, e.key].join("+");
}
