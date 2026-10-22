import { describe, expect, test } from "bun:test";
import { fullRepaint, reducedMotion } from "../src/term/caps.ts";
import { HEX, isTruecolor, modeColor, nearest256, palette } from "../src/term/themes.ts";
import { clip, fill, segsWidth, spread, words, wrapWords } from "../src/view/rows.ts";

describe("themes", () => {
  test("the three canvas themes carry every colour name", () => {
    for (const name of ["agency", "night", "light"] as const) {
      expect(Object.keys(HEX[name]).sort()).toEqual(Object.keys(HEX.agency).sort());
      expect(palette(name, true).brand).toBe(HEX[name].brand);
    }
    expect(HEX.agency.brand).toBe("#e0b46c");
    expect(HEX.night.bg).toBe("#1a1b26");
    expect(HEX.light.youBg).toBe("#dde6f2");
  });

  test("nearest256 picks the cube for colour and the grey ramp for grey", () => {
    expect(nearest256("#ff0000")).toBe(196);
    expect(nearest256("#000000")).toBe(16);
    expect(nearest256("#ffffff")).toBe(231);
    expect(nearest256("#101113")).toBe(233);
    expect(nearest256("#e0b46c")).toBe(179);
  });

  test("without truecolor every colour becomes an indexed one", () => {
    const p = palette("agency", false);
    for (const v of Object.values(p)) expect(typeof v).toBe("object");
    expect(palette("agency", true).bg).toBe("#101113");
  });

  test("COLORTERM, TERM or Windows Terminal say truecolor", () => {
    expect(isTruecolor({ COLORTERM: "truecolor" })).toBe(true);
    expect(isTruecolor({ COLORTERM: "24bit" })).toBe(true);
    expect(isTruecolor({ TERM: "xterm-direct" })).toBe(true);
    expect(isTruecolor({ WT_SESSION: "x" })).toBe(true);
    expect(isTruecolor({ TERM: "xterm-256color" })).toBe(false);
    expect(isTruecolor({})).toBe(false);
  });

  test("build has no colour; plan and auto have theirs", () => {
    const c = palette("agency", true);
    expect(modeColor(c, "build")).toBe(c.text);
    expect(modeColor(c, "plan")).toBe(HEX.agency.plan);
    expect(modeColor(c, "auto")).toBe(HEX.agency.auto);
  });
});

describe("environment switches", () => {
  test("reduced motion from the variable, NO_MOTION or the setting", () => {
    expect(reducedMotion({ AGENCY_REDUCED_MOTION: "1" })).toBe(true);
    expect(reducedMotion({ NO_MOTION: "1" })).toBe(true);
    expect(reducedMotion({ AGENCY_REDUCED_MOTION: "0" })).toBe(false);
    expect(reducedMotion({}, { reducedMotion: true })).toBe(true);
    expect(reducedMotion({}, {})).toBe(false);
  });

  test("full repaint only when asked", () => {
    expect(fullRepaint({ AGENCY_FULL_REPAINT: "1" })).toBe(true);
    expect(fullRepaint({})).toBe(false);
  });
});

describe("rows", () => {
  test("clip ends in an ellipsis; fill and spread give exact widths", () => {
    expect(
      clip([{ t: "hello world" }], 8)
        .map((s) => s.t)
        .join(""),
    ).toBe("hello w…");
    expect(segsWidth(fill([{ t: "ab" }], 6, "#000000"))).toBe(6);
    const row = spread(20, [{ t: "left" }], [{ t: "right" }]);
    expect(row.map((s) => s.t).join("")).toBe("left           right");
    // The left side gives way to the right.
    expect(
      spread(10, [{ t: "a very long left" }], [{ t: "right" }])
        .map((s) => s.t)
        .join(""),
    ).toBe("a v… right");
  });

  test("fill paints its colour under every segment that has none", () => {
    const row = fill([{ t: "a" }, { t: "b", bg: "#111111" }], 4, "#222222");
    expect(row.map((s) => s.bg)).toEqual(["#222222", "#111111", "#222222"]);
  });

  test("words keep a run of characters together across styles; wrapWords breaks only between words", () => {
    const list = words([{ t: "see " }, { t: "code", bg: "#333333" }, { t: ", then go" }]);
    expect(list.map((w) => w.map((s) => s.t).join(""))).toEqual(["see", "code,", "then", "go"]);
    const rows = wrapWords(list, 9);
    expect(rows.map((r) => r.map((s) => s.t).join(""))).toEqual(["see code,", "then go"]);
  });
});

describe("theme contrast (WCAG, truecolor)", () => {
  const lum = (hex: string): number => {
    const [r = 0, g = 0, b = 0] = [1, 3, 5]
      .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string): number => {
    const [hi = 0, lo = 0] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const themes = ["agency", "night", "light"] as const;

  test("every text colour reads at 4.5:1 on the background, the panel and an element", () => {
    for (const name of themes) {
      const t = HEX[name];
      for (const fg of ["text", "soft", "muted", "brand", "you", "plan", "auto", "add", "del"] as const)
        for (const bg of ["bg", "panel", "element"] as const)
          expect([name, fg, bg, ratio(t[fg], t[bg]) >= 4.5]).toEqual([name, fg, bg, true]);
    }
  });

  test("text on the fills that the canvas draws it on reads at 4.5:1", () => {
    for (const name of themes) {
      const t = HEX[name];
      const pairs = [
        ["text", "youBg"],
        ["soft", "youBg"],
        ["you", "youBg"],
        ["text", "addBg"],
        ["add", "addBg"],
        ["text", "delBg"],
        ["del", "delBg"],
      ] as const;
      for (const [fg, bg] of pairs)
        expect([name, fg, bg, ratio(t[fg], t[bg]) >= 4.5]).toEqual([name, fg, bg, true]);
    }
  });

  test("the box edge (dim) stands out 3:1 from the background and the panel", () => {
    for (const name of themes) {
      const t = HEX[name];
      for (const bg of ["bg", "panel"] as const)
        expect([name, bg, ratio(t.dim, t[bg]) >= 3]).toEqual([name, bg, true]);
    }
  });
});

describe("what goes on to the renderer", () => {
  test("replies and focus reports do, keys do not", async () => {
    const { isReply } = await import("../src/term/terminal.ts");
    for (const s of [
      "\x1b[?0u",
      "\x1b[?62;4c",
      "\x1b[?2026;2$y",
      "\x1b[24;80R",
      "\x1b[I",
      "\x1b[O",
      "\x1bP>|kitty\x1b\\",
      "\x1b_Gi=1;OK\x1b\\",
      "\x1b]10;rgb:ff/ff/ff\x07",
    ])
      expect([s, isReply(s)]).toEqual([s, true]);
    for (const s of ["a", "\x1b", "\x1b[1;5F", "\x1b[44;5u", "\x1b[A", "\x1bP", "\x1b]", "\x1b[1;5R"])
      expect([s, isReply(s)]).toEqual([s, false]);
  });
});
