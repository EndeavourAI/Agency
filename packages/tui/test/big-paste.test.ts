import { describe, expect, test } from "bun:test";
import * as C from "../src/input/composer.ts";
import { palette } from "../src/term/themes.ts";
import { composerBox } from "../src/view/composer.ts";
import { connected } from "./boards.ts";
import { KEY } from "./helpers.ts";

/** Best of three: one slow run under a loaded machine is not the cost of the code. */
const ms = (f: () => void): number =>
  Math.min(
    ...[0, 1, 2].map(() => {
      const t = performance.now();
      f();
      return performance.now() - t;
    }),
  );

describe("grapheme moves stay local", () => {
  const at = (text: string, cursor: number): C.Composer => C.setText(C.emptyComposer, text, cursor);

  test("clusters are never split near the caret", () => {
    const text = `${"a".repeat(500)}👨‍👩‍👧é🇺🇸b${"z".repeat(500)}`;
    const family = 500 + "👨‍👩‍👧".length;
    expect(C.left(at(text, family)).cursor).toBe(500);
    expect(C.right(at(text, 500)).cursor).toBe(family);
    const accent = family + "é".length;
    expect(C.backspace(at(text, accent)).text.length).toBe(text.length - "é".length);
    expect(C.right(at(text, accent)).cursor).toBe(accent + "🇺🇸".length);
    expect(C.del(at(text, 0)).text.length).toBe(text.length - 1);
    expect(C.left(at(text, text.length)).cursor).toBe(text.length - 1);
    expect(C.right(at(text, text.length)).cursor).toBe(text.length);
  });
});

// Old code segmented the whole text on every move and render: ~200 ms and ~400 ms with 1 MB.
describe("a 1 MB paste", () => {
  for (const [label, text] of [
    ["one long line", "x".repeat(1_000_000)],
    ["many lines", "line of text here\n".repeat(55_000)],
  ] as const) {
    test(`${label}: keys and the box stay fast`, () => {
      const d = connected();
      d.send(`\x1b[200~${text}\x1b[201~`);
      expect(d.state.composer.text.length).toBe(text.length);
      expect(ms(() => d.send("\x7f"))).toBeLessThan(60);
      expect(ms(() => d.send(KEY.left))).toBeLessThan(60);
      expect(
        ms(() =>
          composerBox(d.state, palette("agency", true), 100, {
            focused: true,
            placeholder: "",
            joined: false,
          }),
        ),
      ).toBeLessThan(60);
    }, 60_000);
  }

  test("a paste above 1 MB is cut and says so", () => {
    const d = connected();
    d.send(`\x1b[200~${"y".repeat(1_000_500)}\x1b[201~`);
    expect(d.state.composer.text.length).toBe(1_000_000);
    expect(d.state.flash?.text).toBe("paste cut at 1 MB");
  });

  test("the cut keeps a surrogate pair whole", () => {
    const d = connected();
    d.send(`\x1b[200~${"y".repeat(999_999)}😀tail\x1b[201~`);
    expect(d.state.composer.text.length).toBe(999_999);
  });
});
