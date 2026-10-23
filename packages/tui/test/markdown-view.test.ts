import { describe, expect, test } from "bun:test";
import { renderMd } from "../src/render-model/index.ts";
import { stringWidth } from "../src/render-model/width.ts";
import { palette } from "../src/term/themes.ts";
import { blockRows } from "../src/view/markdown.ts";
import type { Row } from "../src/view/rows.ts";

const c = palette("agency", true);
const line = (r: Row) => r.map((s) => s.t).join("");
const draw = (src: string, w = 60): string[] =>
  renderMd(src)
    .flatMap((b, i) => blockRows(b, i === 0, w, w, c))
    .map(line);

describe("markdown rows", () => {
  const TABLE = "| Name | Qty | Note |\n|:--|:-:|--:|\n| apple | 1 | red |\n| kiwi | 22 | green |";

  test("a table is an aligned box with a header rule", () => {
    expect(draw(TABLE)).toEqual([
      "┌───────┬─────┬───────┐",
      "│ Name  │ Qty │  Note │",
      "├───────┼─────┼───────┤",
      "│ apple │  1  │   red │",
      "│ kiwi  │ 22  │ green │",
      "└───────┴─────┴───────┘",
    ]);
  });

  test("the grid holds with wide glyphs", () => {
    const rows = draw("| 名前 | 🍎 |\n|---|---|\n| 林檎 | a |");
    expect(new Set(rows.map(stringWidth)).size).toBe(1);
  });

  test("a table wider than the column shrinks and wraps its cells", () => {
    const src =
      "| Id | Description |\n|--|--|\n| 1 | a long description that cannot fit on one row |\n| 2 | https://example.com/a/very/long/unbroken/address |";
    const rows = draw(src, 24);
    expect(rows.every((r) => stringWidth(r) <= 24)).toBe(true);
    expect(new Set(rows.map(stringWidth)).size).toBe(1);
    expect(rows.length).toBeGreaterThan(6);
    const body = rows.join("");
    for (const word of ["description", "cannot", "row"]) expect(body).toContain(word);
    expect(rows.map((r) => r.replace(/[│ ]/g, "")).join("")).toContain("address");
  });

  test("a streaming table draws the rows seen so far", () => {
    const open = (src: string) => draw(src).length;
    expect(open("| a |\n|---|")).toBe(4);
    expect(open("| a |\n|---|\n| 1 |")).toBe(5);
  });

  test("headings drop the hashes and h1-h2 take the brand colour", () => {
    const [h1, h3] = renderMd("# Big\n### Small").map((b) => blockRows(b, true, 40, 40, c)[0]);
    expect(line(h1 as Row)).toBe("Big");
    expect(h1?.[0]).toMatchObject({ fg: c.brand, b: true });
    expect(h3?.[0]).toMatchObject({ fg: c.text, b: true });
  });

  test("inline styles reach the segments", () => {
    const [row] = renderMd("**b** *i* ~~s~~ [t](u)").map((b) => blockRows(b, true, 40, 40, c)[0]);
    expect(row?.filter((s) => s.t.trim()).map((s) => [s.t, !!s.b, !!s.i, !!s.s])).toEqual([
      ["b", true, false, false],
      ["i", false, true, false],
      ["s", false, false, true],
      ["t", false, false, false],
      ["(u)", false, false, false],
    ]);
  });

  test("lists hang their wrapped lines under the text; quotes get a bar; rules span the width", () => {
    expect(draw("1. alpha beta gamma\n  - nested item here", 14)).toEqual([
      "1. alpha beta",
      "   gamma",
      "  • nested",
      "    item here",
    ]);
    expect(draw("> quoted\n> > deeper")).toEqual(["│ quoted", "│ │ deeper"]);
    expect(draw("a\n---", 10)).toEqual(["a", "", "──────────"]);
    expect(draw("- [ ] todo\n- [x] done")).toEqual(["[ ] todo", "[x] done"]);
  });
});
