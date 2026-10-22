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
