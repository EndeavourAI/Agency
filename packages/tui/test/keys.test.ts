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

  test("a sequence split across chunks decodes once", () => {
    const d = new InputDecoder();
    expect(d.push("\x1b[1;")).toEqual([]);
    expect(d.push("5F").map((e) => keyId(e as KeyEvent))).toEqual(["ctrl+end"]);
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
