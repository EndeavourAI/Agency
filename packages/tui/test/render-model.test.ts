import { describe, expect, test } from "bun:test";
import {
  emptyMd,
  finishMd,
  hunkLines,
  type MdBlock,
  parseUnifiedDiff,
  pushMd,
  renderMd,
  stepDiff,
  stepOutput,
  stringWidth,
  trimLines,
  truncate,
  visibleBlocks,
  wrap,
} from "../src/render-model/index.ts";

const text = (b: MdBlock | undefined) => (b?.kind === "text" ? b.parts.map((p) => p.t).join("") : "");

describe("markdown", () => {
  const ANSWER =
    "Retries replace the failed trial in place:\n```sh\nharbor run -r 2 --retry-include RuntimeError\n```\n- `AgentSetupTimeoutError` is a machine fault too\n- a task that fails twice still counts as a fail";

  test("paragraphs, fenced code, lists and inline code, as the canvas md", () => {
    const blocks = renderMd(ANSWER);
    expect(blocks.map((b) => b.kind)).toEqual(["text", "code", "text", "text"]);
    expect(blocks[1]).toMatchObject({
      kind: "code",
      lang: "sh",
      lines: ["harbor run -r 2 --retry-include RuntimeError"],
    });
    const li = blocks[2] as Extract<MdBlock, { kind: "text" }>;
    expect(li.li).toBe(true);
    expect(li.bullet).toBe("• ");
    expect(li.parts[0]).toEqual({ t: "AgentSetupTimeoutError", code: true });
    expect(li.parts[1]).toEqual({ t: " is a machine fault too", code: false });
  });

  test("a gap before every block except the first and a list item that follows a list item", () => {
    const blocks = renderMd(ANSWER);
    expect(blocks.map((b) => b.gap)).toEqual([false, true, true, false]);
  });

  test("blank lines separate nothing by themselves", () => {
    expect(renderMd("a\n\n\nb").map(text)).toEqual(["a", "b"]);
  });

  test("streaming: lines settle when their newline arrives, the tail stays open", () => {
    let s = pushMd(emptyMd, "first line\nsecond li");
    expect(s.settled.map(text)).toEqual(["first line"]);
    expect(visibleBlocks(s).map(text)).toEqual(["first line", "second li"]);
    s = pushMd(s, "ne\n");
    expect(s.settled.map(text)).toEqual(["first line", "second line"]);
    expect(visibleBlocks(s)).toHaveLength(2);
  });

  test("a settled block never changes while more text streams in", () => {
    const a = pushMd(emptyMd, "one\ntwo\nthr");
    const before = a.settled;
    const b = pushMd(a, "ee\nfour");
    expect(b.settled.slice(0, before.length)).toEqual(before);
    expect(b.settled[0]).toBe(before[0]);
  });

  test("an unclosed fence is one open code block until its closing fence arrives", () => {
    let s = pushMd(emptyMd, "intro\n```ts\nconst a = 1;\nconst b");
    expect(s.settled).toHaveLength(1);
    const open = visibleBlocks(s).at(-1);
    expect(open).toMatchObject({ kind: "code", lang: "ts", lines: ["const a = 1;", "const b"] });
    s = pushMd(s, " = 2;\n```\nafter\n");
    expect(s.settled.map((b) => b.kind)).toEqual(["text", "code", "text"]);
    expect(s.settled[1]).toMatchObject({ lines: ["const a = 1;", "const b = 2;"] });
  });

  test("the same text in any chunking renders the same blocks", () => {
    const whole = renderMd(ANSWER);
    for (const size of [1, 3, 7, 50]) {
      let s = emptyMd;
      for (let i = 0; i < ANSWER.length; i += size) s = pushMd(s, ANSWER.slice(i, i + size));
      expect(finishMd(s).settled).toEqual(whole);
    }
  });

  test("an unclosed fence at the end of the answer is kept, not dropped", () => {
    expect(renderMd("```\nlost?")).toHaveLength(1);
  });

  test("an earlier state does not see what a later push appends", () => {
    const a = pushMd(emptyMd, "```\nx\ny\n");
    const b = pushMd(a, "z\n```\nafter\n");
    expect(a.fence?.lines).toEqual(["x", "y"]);
    expect(a.settled).toHaveLength(0);
    expect(b.settled.map((x) => x.kind)).toEqual(["code", "text"]);
  });

  // Copying the settled blocks and fence lines for every line made one big delta quadratic: seconds at 50k lines.
  test("one delta of 50k lines costs its size, in text and in code", () => {
    const text = "a line of prose\n".repeat(50_000);
    const t0 = performance.now();
    expect(pushMd(emptyMd, text).settled).toHaveLength(50_000);
    expect(pushMd(emptyMd, `\`\`\`\n${text}`).fence?.lines).toHaveLength(50_000);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("step output", () => {
  test("five lines, then a count of the rest", () => {
    const rows = stepOutput("bash", { command: "x" }, ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n"));
    expect(rows.map((r) => r.text)).toEqual(["a", "b", "c", "d", "e", "… 3 more lines"]);
    expect(rows.at(-1)?.kind).toBe("more");
  });

  test("exactly five lines show whole; no output shows nothing", () => {
    expect(stepOutput("bash", {}, "1\n2\n3\n4\n5\n")).toHaveLength(5);
    expect(stepOutput("bash", {}, "")).toEqual([]);
    expect(trimLines([{ kind: "plain", text: "x" }])).toHaveLength(1);
  });

  test("an edit opens to its diff with + and − rows", () => {
    const rows = stepOutput(
      "edit",
      { path: "a.ts", oldText: "keep\nold line\nend", newText: "keep\nnew one\nnew two\nend" },
      "ok",
    );
    expect(rows.map((r) => `${r.kind}:${r.text}`)).toEqual([
      "ctx:  keep",
      "del:− old line",
      "add:+ new one",
      "add:+ new two",
      "ctx:  end",
    ]);
  });

  test("diff rows come from hunks, a write and nothing else", () => {
    expect(hunkLines("a\nb", "a\nc").map((l) => l.k)).toEqual([" ", "-", "+"]);
    expect(stepDiff("write", { path: "x", content: "1\n2" })?.map((l) => l.k)).toEqual(["+", "+"]);
    expect(
      stepDiff("edit", {
        path: "x",
        hunks: [
          { oldText: "a", newText: "b" },
          { oldText: "c", newText: "d" },
        ],
      }),
    ).toHaveLength(4);
    expect(stepDiff("read", { path: "x" })).toBeNull();
  });

  test("git unified diff parses with real line numbers", () => {
    const [file] = parseUnifiedDiff(
      [
        "diff --git a/run.sh b/run.sh",
        "index 111..222 100644",
        "--- a/run.sh",
        "+++ b/run.sh",
        "@@ -14,3 +14,4 @@",
        " keep",
        "-old",
        "+new",
        "+added",
        " tail",
      ].join("\n"),
    );
    expect(file?.path).toBe("run.sh");
    expect({ add: file?.add, del: file?.del }).toEqual({ add: 2, del: 1 });
    expect(file?.lines.map((l) => `${l.k}${l.oldNo ?? ""}/${l.newNo ?? ""}`)).toEqual([
      "h/",
      " 14/14",
      "-15/",
      "+/15",
      "+/16",
      " 16/17",
    ]);
  });
});

describe("widths", () => {
  test("wide glyphs take two cells, combining marks none", () => {
    expect(stringWidth("abc")).toBe(3);
    expect(stringWidth("日本")).toBe(4);
    expect(stringWidth("é")).toBe(1);
  });

  test("truncate cuts on cells and never splits a glyph", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello world", 6)).toBe("hello…");
    expect(truncate("日本語です", 5)).toBe("日本…");
    expect(truncate("x", 0)).toBe("");
  });

  test("wrap breaks at spaces and hard-wraps long words", () => {
    expect(wrap("one two three", 7)).toEqual(["one two", "three"]);
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
});
