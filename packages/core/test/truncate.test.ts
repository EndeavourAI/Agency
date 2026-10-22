import { describe, expect, test } from "bun:test";
import {
  TRUNCATE_MAX_BYTES,
  TRUNCATE_MAX_LINES,
  truncateOutput,
  truncateToolResults,
} from "../src/truncate.ts";

describe("truncateOutput", () => {
  test("returns content unchanged when within both limits", () => {
    expect(truncateOutput("short output")).toEqual({ content: "short output", truncated: false });
  });

  test("returns content unchanged at exactly the limits", () => {
    const lines = Array.from({ length: TRUNCATE_MAX_LINES }, (_, i) => `line ${i}`).join("\n");
    expect(truncateOutput(lines).truncated).toBe(false);
    expect(truncateOutput("x".repeat(TRUNCATE_MAX_BYTES)).truncated).toBe(false);
  });

  test("keeps the first three quarters and the last quarter of maxLines, with the notice between", () => {
    const content = Array.from({ length: 3_000 }, (_, i) => `line ${i + 1}`).join("\n");
    const { content: out, truncated } = truncateOutput(content);

    expect(truncated).toBe(true);
    const lines = out.split("\n");
    expect(lines).toHaveLength(TRUNCATE_MAX_LINES + 1);
    expect(lines[0]).toBe("line 1");
    expect(lines[1499]).toBe("line 1500");
    expect(lines[1500]).toBe("[Output truncated: 1000 lines omitted here]");
    expect(lines.at(-1)).toBe("line 3000");
  });

  test("caps bytes, keeps the end, and splits no character", () => {
    const content = "あ".repeat(16_667); // 3-byte chars: 50,001 bytes, one over the cap
    const { content: out, truncated } = truncateOutput(content);

    expect(truncated).toBe(true);
    // 37,500 bytes of head, and the end of 12,500 bytes walked forward off the split char.
    const [head, notice, tail] = out.split("\n");
    expect(head).toBe("あ".repeat(12_500));
    expect(notice).toBe("[Output truncated: 3 bytes omitted here]");
    expect(tail).toBe("あ".repeat(4_166));
    expect(out.includes("�")).toBe(false);
  });

  test("honors custom limits", () => {
    expect(truncateOutput("a\nb\nc\nd\ne", 1_000, 3).content).toBe(
      "a\nb\nc\n[Output truncated: 2 lines omitted here]",
    );
    expect(truncateOutput("abcdef", 3, 100).content).toBe("abc\n[Output truncated: 3 bytes omitted here]");
    expect(truncateOutput("abcdefgh", 4, 100).content).toBe(
      "abc\n[Output truncated: 4 bytes omitted here]\nh",
    );
  });

  test("does not split a surrogate pair (4-byte UTF-8 char) at the byte cap", () => {
    // 😀 (U+1F600) is 4 bytes: "a😀b" is 6 bytes. A cap of 3 lands inside 😀 and walks back to "a".
    const { content: out, truncated } = truncateOutput("a😀b", 3, 100);
    expect(truncated).toBe(true);
    expect(out.includes("�")).toBe(false);
    expect(out).toBe("a\n[Output truncated: 5 bytes omitted here]");
  });

  test("keeps a surrogate pair intact when it fits within the byte cap", () => {
    const { content: out, truncated } = truncateOutput("a😀b", 6, 100);
    expect(truncated).toBe(false);
    expect(out).toBe("a😀b");
  });

  test("handles multiple surrogate pairs with mixed ASCII at both cuts", () => {
    // "x😀y🎉z" = 11 bytes. A cap of 10: 8 bytes of head land inside 🎉 and walk back, 2 bytes of end land inside
    // it too and walk forward.
    const { content: out, truncated } = truncateOutput("x😀y🎉z", 10, 100);
    expect(truncated).toBe(true);
    expect(out).toBe("x😀y\n[Output truncated: 4 bytes omitted here]\nz");
  });

  test("walks back from a split surrogate pair leaving only complete characters", () => {
    const { content: out, truncated } = truncateOutput("a😀bc", 3, 100);
    expect(truncated).toBe(true);
    expect(out).toContain("[Output truncated: ");
    expect(out.startsWith("a")).toBe(true);
    expect(out.includes("😀")).toBe(false);
    expect(out.includes("�")).toBe(false);
  });
});

describe("truncateToolResults", () => {
  test("passes small results through untouched, images included", () => {
    const image = { type: "image", mimeType: "image/png", data: "aGk=" };
    const results = [{ content: "tiny", isError: false, images: [image] }];
    expect(truncateToolResults(results)).toEqual(results);
  });

  test("truncates oversized successful results with the standard notice", () => {
    const [result] = truncateToolResults([{ content: "y".repeat(TRUNCATE_MAX_BYTES + 1), isError: false }]);
    expect(result!.content).toContain("[Output truncated: 1 bytes omitted here]");
    expect(result!.isError).toBe(false);
  });

  test("truncates oversized error results with the error notice instead", () => {
    const [result] = truncateToolResults([{ content: "e".repeat(TRUNCATE_MAX_BYTES + 1), isError: true }]);
    expect(result!.content).toContain("[Error output truncated: 1 bytes omitted here]");
    expect(result!.content).not.toContain("[Output truncated");
  });

  test("truncates oversized error results by line count too, and keeps the last line", () => {
    const content = Array.from({ length: 3_000 }, (_, i) => `err ${i}`).join("\n");
    const [result] = truncateToolResults([{ content, isError: true }]);
    expect(result!.content).toContain("[Error output truncated: 1000 lines omitted here]");
    expect(result!.content.endsWith("err 2999")).toBe(true);
  });
});
