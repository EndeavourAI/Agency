import { describe, expect, test } from "bun:test";
import * as C from "../src/input/composer.ts";
import {
  acOf,
  CLIENT_SLASH,
  caret,
  completionFor,
  completionItems,
  continueLine,
  down,
  emptyComposer,
  insert,
  insertCompletion,
  newline,
  setText,
  up,
} from "../src/input/index.ts";

const typed = (text: string, c = emptyComposer) => insert(c, text);

describe("composer buffer", () => {
  test("insert, caret and backspace work on graphemes", () => {
    let c = typed("a👍b");
    expect(c.cursor).toBe("a👍b".length);
    c = C.backspace(C.left(c));
    expect(c.text).toBe("ab");
    expect(c.cursor).toBe(1);
    c = C.backspace(typed("é"));
    expect(c.text).toBe("");
  });

  test("a new line is a real line break and the caret follows", () => {
    const c = typed("two", newline(typed("one")));
    expect(c.text).toBe("one\ntwo");
    expect(C.lines(c)).toEqual(["one", "two"]);
    expect(caret(c)).toEqual({ row: 1, col: 3 });
  });

  test("backslash then enter continues the line instead of sending", () => {
    const c = typed("first\\");
    const cont = continueLine(c);
    expect(cont?.text).toBe("first\n");
    expect(cont?.cursor).toBe(6);
    expect(continueLine(typed("plain"))).toBeNull();
    expect(continueLine(typed("\\"))?.text).toBe("\n");
  });

  test("a path or shell text ending in a backslash is not a continuation", () => {
    expect(continueLine(typed("open C:\\"))).toBeNull();
    expect(continueLine(typed("a\\\\"))).toBeNull();
    expect(continueLine(typed("!dir \\"))).toBeNull();
  });

  test("only a typed ! enters shell mode; a pasted one stays text", () => {
    expect(typed("!ls").shell).toBe(true);
    const p = insert(emptyComposer, "!ls", true);
    expect(p).toMatchObject({ text: "!ls", shell: false });
  });

  test("up and down keep the cell column across rows and report when they cannot move", () => {
    let c = setText(emptyComposer, "abcdef\nxy\nlonger line", 0);
    c = { ...c, cursor: 5 };
    const d1 = down(c);
    expect(d1.moved).toBe(true);
    expect(caret(d1.c)).toEqual({ row: 1, col: 2 });
    const d2 = down(d1.c);
    expect(caret(d2.c)).toEqual({ row: 2, col: 2 });
    expect(down(d2.c).moved).toBe(false);
    const u = up(d2.c);
    expect(caret(u.c).row).toBe(1);
    expect(up(setText(emptyComposer, "single")).moved).toBe(false);
  });

  test("home, end, words and kill commands", () => {
    let c = typed("one two three");
    expect(C.deleteWord(c).text).toBe("one two ");
    c = C.wordLeft(c);
    expect(c.cursor).toBe(8);
    expect(C.deleteToEnd(c).text).toBe("one two ");
    expect(C.deleteToStart(c).text).toBe("three");
    expect(C.home(typed("ab\ncd")).cursor).toBe(3);
    expect(C.end(setText(emptyComposer, "ab\ncd", 0)).cursor).toBe(2);
    expect(C.del(setText(emptyComposer, "ab", 0)).text).toBe("b");
  });

  test("a ! in an empty prompt enters shell mode and is not typed", () => {
    const c = typed("!");
    expect(c.shell).toBe(true);
    expect(c.text).toBe("");
    expect(typed("git status", c).text).toBe("git status");
    expect(typed("!x", typed("a")).shell).toBe(false);
    const pasted = typed("!ls -la");
    expect(pasted).toMatchObject({ shell: true, text: "ls -la" });
  });

  test("carriage returns from a paste become newlines", () => {
    expect(typed("a\r\nb\rc").text).toBe("a\nb\nc");
  });
});

describe("completion triggers (acOf)", () => {
  test("@ at a word start lists files, / at the start lists commands", () => {
    expect(acOf("fix @rep")).toEqual({ kind: "@", q: "rep", i: 0 });
    expect(acOf("@")).toEqual({ kind: "@", q: "", i: 0 });
    expect(acOf("/re")).toEqual({ kind: "/", q: "re", i: 0 });
    expect(acOf("/")).toEqual({ kind: "/", q: "", i: 0 });
  });

  test("no trigger inside a word, after a space in a command, or in plain text", () => {
    expect(acOf("mail me@x.com")).toBeNull();
    expect(acOf("/model gpt")).toBeNull();
    expect(acOf("hello")).toBeNull();
    expect(acOf("see @a b")).toBeNull();
  });

  test("shell mode never completes", () => {
    expect(completionFor({ text: "@x", cursor: 2, shell: true })).toBeNull();
    expect(completionFor({ text: "@x", cursor: 2, shell: false })?.kind).toBe("@");
  });

  test("only the text before the caret counts", () => {
    expect(completionFor({ text: "@abc def", cursor: 4, shell: false })).toMatchObject({
      kind: "@",
      q: "abc",
    });
  });
});

describe("completion items", () => {
  const files = [
    "packages/eval/harbor/run.sh",
    "packages/eval/harbor/report.py",
    "packages/core/src/prune.ts",
    "docs/report-notes.md",
  ];

  test("@rep lists matching files, a file name before a directory match", () => {
    const items = completionItems(acOf("fix @rep"), { files, slash: [] });
    expect(items[0]).toMatchObject({
      text: "@packages/eval/harbor/report.py",
      label: "report.py",
      desc: "packages/eval/harbor",
    });
    expect(items.map((i) => i.label)).toEqual(["report.py", "report-notes.md"]);
  });

  test("at most eight, none when nothing matches", () => {
    const many = Array.from({ length: 30 }, (_, i) => `src/file${i}.ts`);
    expect(completionItems(acOf("@file"), { files: many, slash: [] })).toHaveLength(8);
    expect(completionItems(acOf("@zzz"), { files, slash: [] })).toEqual([]);
  });

  test("/re lists commands, prefix matches first", () => {
    const slash = [
      { name: "core", desc: "contains re", meta: "skill" },
      ...CLIENT_SLASH,
      { name: "retry", desc: "prefix", meta: "command" },
    ];
    const items = completionItems(acOf("/re"), { files: [], slash });
    expect(items.map((i) => i.label)).toEqual(["/review", "/retry", "/core"]);
  });

  test("tab inserts the pick: a file replaces the token, a command replaces the draft", () => {
    const at = insertCompletion(
      typed("fix @rep"),
      acOf("fix @rep") as never,
      "@packages/eval/harbor/report.py",
    );
    expect(at.text).toBe("fix @packages/eval/harbor/report.py ");
    expect(at.cursor).toBe(at.text.length);
    const sl = insertCompletion(typed("/re"), acOf("/re") as never, "/review");
    expect(sl.text).toBe("/review ");
  });

  test("a completion in the middle keeps the text after the caret", () => {
    const c = { text: "see @rep and more", cursor: 8, shell: false };
    const out = insertCompletion(c, acOf("see @rep") as never, "@a/report.py");
    expect(out.text).toBe("see @a/report.py  and more");
    expect(out.cursor).toBe("see @a/report.py ".length);
  });
});
