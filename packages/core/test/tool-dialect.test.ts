import { expect, test } from "bun:test";
import { validateToolInput } from "../src/loop.ts";
import { canonicalCall, dialectFor, wireMessages, wireTools } from "../src/tool-dialect.ts";

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

test("the dialect follows the model id, and a configured one wins", () => {
  for (const model of ["gpt-5.1", "openai/gpt-5-codex", "gpt-5.1-codex-mini"])
    expect(dialectFor(model)).toBe("codex");
  for (const model of ["claude-haiku-5-5", "z-ai/glm-4.6", "openai/gpt-oss-120b", "gpt-4.1", "gemini-3-pro"])
    expect(dialectFor(model)).toBe("native");
  expect(dialectFor("claude-haiku-5-5", "claude-code")).toBe("claude-code");
  expect(dialectFor("gpt-5.1", "native")).toBe("native");
});

test("Claude Code's dialect renames the tools, their schemas and the history, and comes back as ours", () => {
  const description =
    "Pass oldText+newText, or hunks: [{oldText, newText, replaceAll?}]. Each path is relative.";
  const [edit] = wireTools([{ ...tools[0]!, description }], "claude-code");
  expect(edit!.name).toBe("Edit");
  expect(edit!.description).toBe(
    "Pass old_string+new_string, or edits: [{old_string, new_string, replace_all?}]. Each path is relative.",
  );
  expect(Object.keys((edit!.inputSchema as { properties: object }).properties)).toEqual([
    "file_path",
    "old_string",
    "new_string",
    "replace_all",
    "edits",
  ]);
  expect(edit!.inputSchema).toMatchObject({
    required: ["file_path"],
    properties: { edits: { items: { required: ["old_string", "new_string"] } } },
  });

  const history = [
    {
      role: "assistant" as const,
      content: [
        {
          type: "tool_call" as const,
          id: "c1",
          name: "edit",
          input: { path: "a.ts", hunks: [{ oldText: "x", newText: "y" }] },
        },
      ],
    },
    {
      role: "user" as const,
      content: [
        { type: "tool_result" as const, toolCallId: "c1", content: "send the oldText again", isError: true },
      ],
    },
  ];
  const [sent, result] = wireMessages(history, "claude-code");
  expect(sent!.content[0]).toEqual({
    type: "tool_call",
    id: "c1",
    name: "Edit",
    input: { file_path: "a.ts", edits: [{ old_string: "x", new_string: "y" }] },
  });
  expect(result!.content[0]).toMatchObject({ content: "send the old_string again" });
  expect(wireMessages(history, "native")).toBe(history);
  // What the model sends back in those names is ours again.
  const back = sent!.content[0] as Parameters<typeof canonicalCall>[0];
  expect(canonicalCall(back, tools)).toEqual(history[0]!.content[0]);
});

test("Codex's dialect offers apply_patch for edit and write, and a patch comes back as an edit of its file", () => {
  const offered = wireTools(
    [tools[0]!, { name: "write", description: "w", inputSchema: {} }, tools[2]!].map((tool) => ({
      description: "d",
      ...tool,
    })),
    "codex",
  );
  expect(offered.map((tool) => tool.name)).toEqual(["apply_patch", "bash"]);

  const text = "*** Begin Patch\n*** Update File: src/a.py\n@@\n-x\n+y\n*** End Patch";
  const edit = canonicalCall(
    { type: "tool_call", id: "c1", name: "apply_patch", input: { input: text } },
    tools,
  );
  expect(edit).toEqual({
    type: "tool_call",
    id: "c1",
    name: "edit",
    input: { patch: text, path: "src/a.py" },
  });
  const [sent] = wireMessages([{ role: "assistant" as const, content: [edit] }], "codex");
  expect(sent!.content[0]).toEqual({
    type: "tool_call",
    id: "c1",
    name: "apply_patch",
    input: { input: text },
  });
});

test("a patch that does not parse still reaches edit with its file, so the model gets the patch fault", () => {
  const text = "*** Begin Patch\n*** Update File: src/a.py\nnot a change line\n*** End Patch";
  const edit = canonicalCall(
    { type: "tool_call", id: "c1", name: "apply_patch", input: { input: text } },
    tools,
  );
  expect(edit.input).toEqual({ patch: text, path: "src/a.py" });
  expect(validateToolInput(tools[0]!.inputSchema, edit.input)).toBeUndefined();
});
