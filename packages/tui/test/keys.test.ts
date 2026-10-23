import { describe, expect, test } from "bun:test";
import { KEYMAP, resolveKey } from "../src/input/keymap.ts";
import { InputDecoder, type InputEvent, type KeyEvent, keyId } from "../src/input/keys.ts";

function decode(bytes: string): InputEvent[] {
  const d = new InputDecoder();
  return [...d.push(bytes), ...d.flush()];
}
const ids = (bytes: string): string[] => decode(bytes).map((e) => (e.type === "key" ? keyId(e) : e.type));

describe("legacy decoding", () => {
  test("the keys of the brief decode to one id each", () => {
    expect(ids("\x1b[Z")).toEqual(["shift+tab"]);
    expect(ids("\t")).toEqual(["tab"]);
    expect(ids("\r")).toEqual(["enter"]);
    expect(ids("\x1b\r")).toEqual(["alt+enter"]);
    expect(ids("\x1b[5~")).toEqual(["pageup"]);
    expect(ids("\x1b[6~")).toEqual(["pagedown"]);
    expect(ids("\x1b[1;5F")).toEqual(["ctrl+end"]);
    expect(ids("\x1b[F")).toEqual(["end"]);
    expect(ids("\x1bOF")).toEqual(["end"]);
    expect(ids("\x10")).toEqual(["ctrl+p"]);
    expect(ids("\x1b")).toEqual(["escape"]);
    expect(ids("\x7f")).toEqual(["backspace"]);
  });

  test("LF is ctrl+j: legacy terminals send it for ctrl+enter too", () => {
    expect(ids("\n")).toEqual(["ctrl+j"]);
  });

  test("arrows with modifiers and function keys", () => {
    expect(ids("\x1b[A\x1b[B\x1b[C\x1b[D")).toEqual(["up", "down", "right", "left"]);
    expect(ids("\x1b[1;5C")).toEqual(["ctrl+right"]);
    expect(ids("\x1b[1;2A")).toEqual(["shift+up"]);
    expect(ids("\x1b[15~")).toEqual(["f5"]);
    expect(ids("\x1bOP")).toEqual(["f1"]);
    expect(ids("\x1b[3~")).toEqual(["delete"]);
  });

  test("alt+letter and printable text", () => {
    expect(ids("\x1bb")).toEqual(["alt+b"]);
    expect((decode("é")[0] as KeyEvent).text).toBe("é");
    expect((decode(" ")[0] as KeyEvent).key).toBe("space");
    expect((decode(" ")[0] as KeyEvent).text).toBe(" ");
    expect(ids("日本")).toEqual(["日", "本"]);
  });

  test("a lone ESC waits for flush; ESC then a sequence is not an escape key", () => {
    const d = new InputDecoder();
    expect(d.push("\x1b")).toEqual([]);
    expect(d.push("[A").map((e) => (e as KeyEvent).key)).toEqual(["up"]);
    expect(d.push("\x1b")).toEqual([]);
    expect(d.flush().map((e) => (e as KeyEvent).key)).toEqual(["escape"]);
  });

  test("legacy alt+arrow (ESC then the sequence) is one alt key, not text", () => {
    expect(ids("\x1b\x1b[A")).toEqual(["alt+up"]);
    expect(ids("\x1b\x1b[1;5C")).toEqual(["ctrl+alt+right"]);
    expect(ids("\x1b\x1bOD")).toEqual(["alt+left"]);
    expect(ids("\x1b\x1b[A\x1b[B")).toEqual(["alt+up", "down"]);
    const d = new InputDecoder();
    expect(d.push("\x1b\x1b")).toEqual([]);
    expect(d.push("[B").map((e) => keyId(e as KeyEvent))).toEqual(["alt+down"]);
  });

  test("a sequence split across chunks decodes once", () => {
    const d = new InputDecoder();
    expect(d.push("\x1b[1;")).toEqual([]);
    expect(d.push("5F").map((e) => keyId(e as KeyEvent))).toEqual(["ctrl+end"]);
  });

  test("an SGR wheel report is a wheel notch, with or without modifiers; a click is nothing", () => {
    expect(decode("\x1b[<64;10;5M\x1b[<65;1;1M\x1b[<80;3;3M")).toEqual([
      { type: "wheel", d: 1 },
      { type: "wheel", d: -1 },
      { type: "wheel", d: 1 },
    ]);
    expect(decode("\x1b[<0;10;5M\x1b[<0;10;5m")).toEqual([]);
  });
});

describe("kitty and modifyOtherKeys", () => {
  test("CSI u carries ctrl+enter, ctrl+, and shift+tab", () => {
    expect(ids("\x1b[13;5u")).toEqual(["ctrl+enter"]);
    expect(ids("\x1b[44;5u")).toEqual(["ctrl+,"]);
    expect(ids("\x1b[9;2u")).toEqual(["shift+tab"]);
    expect(ids("\x1b[13;3u")).toEqual(["alt+enter"]);
    expect(ids("\x1b[13;2u")).toEqual(["shift+enter"]);
    expect(ids("\x1b[27u")).toEqual(["escape"]);
  });

  test("key releases are dropped, repeats are kept", () => {
    expect(ids("\x1b[97;1:3u")).toEqual([]);
    expect((decode("\x1b[97;1:2u")[0] as KeyEvent).kind).toBe("repeat");
    const d = new InputDecoder({ keepRelease: true });
    expect((d.push("\x1b[97;1:3u")[0] as KeyEvent).kind).toBe("release");
  });

  test("a code point outside Unicode is dropped instead of throwing", () => {
    expect(ids("\x1b[1114112;1u")).toEqual([]);
    expect(ids("\x1b[97;1;1114112u")).toEqual([]);
    expect(ids("\x1b[27;5;99999999~")).toEqual([]);
    expect(ids("\x1b[97u")).toEqual(["a"]);
  });

  test("modifyOtherKeys", () => {
    expect(ids("\x1b[27;5;13~")).toEqual(["ctrl+enter"]);
    expect(ids("\x1b[27;5;44~")).toEqual(["ctrl+,"]);
  });

  test("associated text rides on the key", () => {
    expect((decode("\x1b[97;1;97u")[0] as KeyEvent).text).toBe("a");
  });
});

describe("paste and terminal replies", () => {
  test("bracketed paste is one event, even split and with newlines", () => {
    const d = new InputDecoder();
    expect(d.push("\x1b[200~line one\nli")).toEqual([]);
    expect(d.push("ne two\x1b[20")).toEqual([]);
    expect(d.push("1~")).toEqual([{ type: "paste", text: "line one\nline two" }]);
    expect(decode("a\x1b[200~x\x1b[201~b").map((e) => e.type)).toEqual(["key", "paste", "key"]);
  });

  test("replies to our own queries never become keys", () => {
    const replies =
      "\x1b[1;1R\x1b[?1016;0$y\x1b[?2027;0$y\x1b[?61;6;7c\x1b]10;rgb:ffff/ffff/ffff\x07\x1b_Gi=31337;OK\x1b\\\x1b[?0u";
    expect(decode(replies)).toEqual([]);
    expect(ids(`${replies}a`)).toEqual(["a"]);
  });

  test("a real F3 with modifiers still decodes while a cursor report is dropped", () => {
    expect(ids("\x1b[1;5R")).toEqual(["ctrl+f3"]);
    expect(ids("\x1b[24;80R")).toEqual([]);
  });

  test("focus reports and mouse are not keys", () => {
    expect(decode("\x1b[I\x1b[O").map((e) => e.type)).toEqual(["focus", "focus"]);
    expect(decode("\x1b[<0;10;5M")).toEqual([]);
  });
});

describe("keymap", () => {
  const key = (bytes: string): KeyEvent => decode(bytes)[0] as KeyEvent;

  test("every binding of the brief resolves in its context", () => {
    expect(resolveKey(["composer", "global"], key("\t"))).toBe("mode.next");
    expect(resolveKey(["composer", "global"], key("\x1b[Z"))).toBe("mode.prev");
    expect(resolveKey(["composer", "global"], key("\x10"))).toBe("palette.toggle");
    expect(resolveKey(["composer", "global"], key("\x12"))).toBe("review.toggle");
    expect(resolveKey(["composer", "global"], key("\x04"))).toBe("details.toggle");
    expect(resolveKey(["composer", "global"], key("\x0e"))).toBe("session.new");
    expect(resolveKey(["composer", "global"], key("\x1b[44;5u"))).toBe("settings.open");
    expect(resolveKey(["composer", "global"], key("\x1b"))).toBe("escape");
    expect(resolveKey(["composer", "global"], key("\x1b[5~"))).toBe("scroll.pageUp");
    expect(resolveKey(["composer", "global"], key("\x1b[6~"))).toBe("scroll.pageDown");
    expect(resolveKey(["composer", "global"], key("\x1b[1;5F"))).toBe("scroll.latest");
    expect(resolveKey(["composer", "global"], key("\x1b[A"))).toBe("history.prev");
    expect(resolveKey(["pick", "global"], key("c"))).toBe("pick.copy");
    expect(resolveKey(["pick", "global"], key("t"))).toBe("pick.thinking");
    expect(resolveKey(["pick", "global"], key("\r"))).toBe("pick.outputs");
    expect(resolveKey(["approval", "global"], key("y"))).toBe("approve.once");
    expect(resolveKey(["approval", "global"], key("a"))).toBe("approve.always");
    expect(resolveKey(["approval", "global"], key("n"))).toBe("approve.deny");
    expect(resolveKey(["approval", "global"], key("\x1b"))).toBe("approve.deny");
    expect(resolveKey(["review", "global"], key("\r"))).toBe("review.commit");
    expect(resolveKey(["review", "global"], key("\x1b[13;5u"))).toBe("review.commitPush");
    expect(resolveKey(["review", "global"], key("\n"))).toBe("review.commitPush");
    expect(resolveKey(["settings", "global"], key(" "))).toBe("settings.change");
    expect(resolveKey(["settings", "global"], key("\x1b[C"))).toBe("settings.in");
  });

  test("new lines: ctrl+j, alt+enter, shift+enter (kitty)", () => {
    expect(resolveKey(["composer"], key("\n"))).toBe("newline");
    expect(resolveKey(["composer"], key("\x1b\r"))).toBe("newline");
    expect(resolveKey(["composer"], key("\x1b[13;2u"))).toBe("newline");
  });

  test("a context binds no key twice", () => {
    for (const table of Object.values(KEYMAP)) {
      expect(new Set(Object.keys(table)).size).toBe(Object.keys(table).length);
    }
  });
});

describe("byte streams recorded from terminals", () => {
  // One line per terminal and key: what it sends with its keyboard mode on, and what a legacy terminal sends instead.
  const kitty: Array<[string, string, string]> = [
    ["kitty, flags 1", "\x1b[44;5u", "ctrl+,"],
    ["WezTerm, flags 1", "\x1b[13;5u", "ctrl+enter"],
    ["Ghostty, flags 1", "\x1b[27u", "escape"],
    ["foot, flags 1", "\x1b[98;3u", "alt+b"],
    ["kitty, flags 1", "\x1b[99;5u", "ctrl+c"],
    ["kitty, flags 1", "\x1b[9;2u", "shift+tab"],
    ["kitty, flags 1", "\x1b[127;3u", "alt+backspace"],
  ];
  test("with the Kitty flags on, the keys that legacy cannot tell apart arrive as CSI u", () => {
    for (const [from, bytes, id] of kitty) expect([from, ids(bytes)]).toEqual([from, [id]]);
  });

  test("legacy Windows Terminal: ctrl+, is a comma, ctrl+enter is LF, esc waits alone", () => {
    expect(ids(",")).toEqual([","]);
    expect(ids("\n")).toEqual(["ctrl+j"]);
    expect(ids("\x1b")).toEqual(["escape"]);
  });

  test("the answer to the probe never becomes a key, whatever its flags", () => {
    for (const reply of ["\x1b[?0u", "\x1b[?1u", "\x1b[?31u", "\x1b[?62;4c"])
      expect(ids(`${reply}a`)).toEqual(["a"]);
  });
});
