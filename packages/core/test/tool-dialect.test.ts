import { expect, test } from "bun:test";
import { canonicalCall } from "../src/tool-dialect.ts";

const hunk = {
  type: "object",
  properties: { oldText: { type: "string" }, newText: { type: "string" }, replaceAll: { type: "boolean" } },
  required: ["oldText", "newText"],
};
const tools = [
  {
    name: "edit",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
        replaceAll: { type: "boolean" },
        hunks: { type: "array", items: hunk },
      },
      required: ["path"],
    },
  },
  {
    name: "read",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
  {
    name: "bash",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        background: { type: "boolean" },
        timeout: { type: "number" },
      },
      required: ["command"],
    },
  },
  {
    name: "grep",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        caseInsensitive: { type: "boolean" },
        filesOnly: { type: "boolean" },
      },
      required: ["pattern"],
    },
  },
];
const call = (name: string, input: Record<string, unknown>) =>
  canonicalCall({ type: "tool_call", id: "c1", name, input }, tools);

test("a Claude Code Edit call becomes an edit call", () => {
  expect(call("Edit", { file_path: "a.ts", old_string: "x", new_string: "y", replace_all: true })).toEqual({
    type: "tool_call",
    id: "c1",
    name: "edit",
    input: { path: "a.ts", oldText: "x", newText: "y", replaceAll: true },
  });
});

test("edits sent as a JSON string, or as one object, become the hunks array", () => {
  expect(
    call("edit", { path: "a.ts", hunks: JSON.stringify([{ old_string: "x", new_string: "y" }]) }).input,
  ).toEqual({ path: "a.ts", hunks: [{ oldText: "x", newText: "y" }] });
  expect(call("MultiEdit", { filePath: "a.ts", edits: { oldText: "x", newText: "y" } }).input).toEqual({
    path: "a.ts",
    hunks: [{ oldText: "x", newText: "y" }],
  });
});

test("other harnesses' tool names and the shell argv of Codex", () => {
  expect(call("read_file", { absolute_path: "/a", start_line: "3", limit: null })).toMatchObject({
    name: "read",
    input: { path: "/a", offset: 3 },
  });
  expect(call("shell", { command: ["bash", "-lc", "ls -la"], timeout_ms: 5000 }).input).toEqual({
    command: "ls -la",
    timeout: 5000,
  });
  expect(call("shell", { command: ["git", "commit", "-m", "a b"] }).input.command).toBe(
    "git commit -m 'a b'",
  );
  expect(call("exec_command", { cmd: "ls", run_in_background: "true" }).input).toEqual({
    command: "ls",
    background: true,
  });
  expect(call("Grep", { pattern: "x", "-i": true, output_mode: "files_with_matches" }).input).toEqual({
    pattern: "x",
    caseInsensitive: true,
    filesOnly: true,
  });
});

test("a name of this harness wins over its alias, and an unknown tool passes as sent", () => {
  expect(call("edit", { path: "a", file_path: "b", oldText: "x", newText: "y" }).input.path).toBe("a");
  expect(call("frobnicate", { file_path: "a" })).toMatchObject({
    name: "frobnicate",
    input: { file_path: "a" },
  });
  // A mangled string stays as sent: validation then names the fault to the model.
  expect(call("edit", { path: "a", hunks: '[{"oldText">x' }).input.hunks).toBe('[{"oldText">x');
});
