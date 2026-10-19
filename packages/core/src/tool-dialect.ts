import type { ContentBlock } from "@agency/schema";

type ToolCall = Extract<ContentBlock, { type: "tool_call" }>;
type Schema = Record<string, unknown>;

/** Tool names of other harnesses (Claude Code, Codex, Gemini CLI, OpenCode, Kimi CLI) that models trained on them send. */
const NAME_ALIASES: Record<string, string> = {
  read_file: "read",
  readfile: "read",
  write_file: "write",
  writefile: "write",
  create_file: "write",
  replace: "edit",
  multiedit: "edit",
  str_replace: "edit",
  strreplacefile: "edit",
  search_replace: "edit",
  shell: "bash",
  run_shell_command: "bash",
  exec_command: "bash",
  grep_search: "grep",
  search_file_content: "grep",
  todowrite: "todo",
};

/** Per tool: argument names of other harnesses → the name here. A name here that the call has wins. */
const ARG_ALIASES: Record<string, Record<string, string>> = {
  read: { file_path: "path", filePath: "path", absolute_path: "path", start_line: "offset" },
  write: { file_path: "path", filePath: "path", file_text: "content" },
  edit: {
    file_path: "path",
    filePath: "path",
    old_string: "oldText",
    oldString: "oldText",
    old_str: "oldText",
    new_string: "newText",
    newString: "newText",
    new_str: "newText",
    replace_all: "replaceAll",
    allow_multiple: "replaceAll",
    edits: "hunks",
    edit: "hunks",
  },
  bash: {
    cmd: "command",
    run_in_background: "background",
    is_background: "background",
    timeout_ms: "timeout",
  },
  grep: {
    "-i": "caseInsensitive",
    "-C": "context",
    dir_path: "path",
    include_pattern: "glob",
    include: "glob",
  },
  glob: { dir_path: "path" },
  todo: { todos: "items" },
};

const HUNK_ALIASES: Record<string, string> = {
  old_string: "oldText",
  oldString: "oldText",
  old_str: "oldText",
  old: "oldText",
  new_string: "newText",
  newString: "newText",
  new_str: "newText",
  new: "newText",
  replace_all: "replaceAll",
};

function renamed(input: Record<string, unknown>, aliases: Record<string, string>): Record<string, unknown> {
  let out = input;
  for (const [alias, name] of Object.entries(aliases)) {
    if (!(alias in out)) continue;
    const { [alias]: value, ...rest } = out;
    out = name in rest ? rest : { ...rest, [name]: value };
  }
  return out;
}

/** A value of the type that the schema declares, from a string or a lone item that a model sent in its place. */
function coerce(schema: Schema | undefined, value: unknown): unknown {
  const type = schema?.type;
  if (typeof value === "string") {
    if (type === "array" || type === "object") {
      try {
        // Live (pi): Opus 4.6 and GLM-5.1 send an array of edits as a JSON string.
        return coerce(schema, JSON.parse(value));
      } catch {
        return value;
      }
    }
    if ((type === "number" || type === "integer") && value.trim() !== "" && Number.isFinite(Number(value)))
      return Number(value);
    if (type === "boolean" && (value === "true" || value === "false")) return value === "true";
    return value;
  }
  if (type === "array") {
    const items = schema?.items as Schema | undefined;
    const list = Array.isArray(value)
      ? value
      : value !== null && typeof value === "object"
        ? [value]
        : undefined;
    return list ? list.map((item) => coerce(items, item)) : value;
  }
  if (type === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = (schema?.properties ?? {}) as Record<string, Schema>;
    const required = new Set((schema?.required ?? []) as string[]);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      // An optional argument sent as null means "not given".
      if (item === null && !required.has(key)) continue;
      out[key] = key in properties ? coerce(properties[key], item) : item;
    }
    return out;
  }
  return value;
}

/** A shell command that came as an argv (Codex `shell`): `["bash", "-lc", "x"]` is `x`. */
function commandLine(argv: unknown[]): string {
  const parts = argv.map(String);
  if (parts.length === 3 && /^(ba|z)?sh$/.test(parts[0] ?? "") && /^-l?c$/.test(parts[1] ?? ""))
    return parts[2] ?? "";
  return parts
    .map((part) => (/^[\w./=:-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`))
    .join(" ");
}

function canonicalInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  let out = renamed(input, ARG_ALIASES[tool] ?? {});
  if (tool === "edit") {
    let hunks = out.hunks;
    if (typeof hunks === "string") {
      try {
        hunks = JSON.parse(hunks);
      } catch {}
    }
    if (hunks !== null && typeof hunks === "object" && !Array.isArray(hunks)) hunks = [hunks];
    if (Array.isArray(hunks))
      out = {
        ...out,
        hunks: hunks.map((hunk) =>
          hunk !== null && typeof hunk === "object"
            ? renamed(hunk as Record<string, unknown>, HUNK_ALIASES)
            : hunk,
        ),
      };
  }
  if (tool === "bash" && Array.isArray(out.command)) out = { ...out, command: commandLine(out.command) };
  if (tool === "grep" && out.output_mode !== undefined) {
    const { output_mode: mode, ...rest } = out;
    out = mode === "files_with_matches" && !("filesOnly" in rest) ? { ...rest, filesOnly: true } : rest;
  }
  if (tool === "todo" && Array.isArray(out.items))
    out = {
      ...out,
      items: out.items.map((item, i) =>
        item !== null && typeof item === "object" && !("id" in item) ? { id: String(i + 1), ...item } : item,
      ),
    };
  return out;
}

/**
 * The call in the names and types of the tools here: a model trained on another harness sends that harness's tool
 * and argument names, and some send an array or a number as a string. Unknown names and keys pass as sent.
 */
export function canonicalCall(
  call: ToolCall,
  tools: readonly { name: string; inputSchema: Schema }[],
): ToolCall {
  const offered = (name: string) =>
    tools.find((t) => t.name === name) ?? tools.find((t) => t.name.toLowerCase() === name.toLowerCase());
  const exact = offered(call.name);
  const alias = NAME_ALIASES[call.name.toLowerCase()];
  const spec = exact ?? (alias ? offered(alias) : undefined);
  if (!spec) return call;
  const input = coerce(spec.inputSchema, canonicalInput(spec.name, call.input)) as Record<string, unknown>;
  return { ...call, name: spec.name, input };
}
