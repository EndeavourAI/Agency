/** One file of a Codex `apply_patch` patch (the V4A format that OpenAI trains its GPT-5 models on). */
export type PatchOp =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; chunks: PatchChunk[] };

export interface PatchChunk {
  /** The `@@ line` that comes before the change: the change is after the first such line from the last chunk. */
  context?: string;
  oldLines: string[];
  newLines: string[];
  atEnd: boolean;
}

const FILE_HEADER = /^\*\*\* (Add|Delete|Update) File: (.+)$/;

/** The files of a patch, or a fault that names the line. */
export function parsePatch(text: string): PatchOp[] | string {
  const lines = text.trim().split(/\r?\n/);
  if (lines[0]?.trim() !== "*** Begin Patch") return 'the patch must start with "*** Begin Patch"';
  if (lines.at(-1)?.trim() !== "*** End Patch") return 'the patch must end with "*** End Patch"';
  const ops: PatchOp[] = [];
  let i = 1;
  while (i < lines.length - 1) {
    const header = FILE_HEADER.exec(lines[i] ?? "");
    if (!header)
      return `line ${i + 1}: expected "*** Add File:", "*** Delete File:" or "*** Update File:", got "${lines[i]}"`;
    const path = (header[2] ?? "").trim();
    i++;
    if (header[1] === "Delete") {
      ops.push({ kind: "delete", path });
      continue;
    }
    if (header[1] === "Add") {
      const body: string[] = [];
      while (i < lines.length - 1 && lines[i]?.startsWith("+")) body.push((lines[i++] as string).slice(1));
      ops.push({ kind: "add", path, content: body.length > 0 ? `${body.join("\n")}\n` : "" });
      continue;
    }
    let moveTo: string | undefined;
    if (lines[i]?.startsWith("*** Move to: ")) moveTo = (lines[i++] as string).slice(13).trim();
    const chunks: PatchChunk[] = [];
    let chunk: PatchChunk | undefined;
    while (i < lines.length - 1 && !FILE_HEADER.test(lines[i] ?? "")) {
      const line = lines[i++] as string;
      if (line.startsWith("@@")) {
        chunk = { oldLines: [], newLines: [], atEnd: false };
        const context = line.slice(2).trim();
        if (context !== "") chunk.context = context;
        chunks.push(chunk);
        continue;
      }
      if (line === "*** End of File") {
        if (chunk) chunk.atEnd = true;
        continue;
      }
      if (!chunk) {
        // Codex takes a first change with no `@@` line.
        chunk = { oldLines: [], newLines: [], atEnd: false };
        chunks.push(chunk);
      }
      // A blank line in a model's patch is an unchanged blank line.
      const mark = line[0] ?? " ";
      const rest = line.slice(1);
      if (mark === " ") {
        chunk.oldLines.push(rest);
        chunk.newLines.push(rest);
      } else if (mark === "-") chunk.oldLines.push(rest);
      else if (mark === "+") chunk.newLines.push(rest);
      else return `line ${i}: a changed line starts with " ", "-" or "+", got "${line}"`;
    }
    if (chunks.length === 0) return `"*** Update File: ${path}" has no change`;
    ops.push({ kind: "update", path, ...(moveTo ? { moveTo } : {}), chunks });
  }
  if (ops.length === 0) return "the patch changes no file";
  return ops;
}

/** Where `wanted` is in `lines` from `from`: exact first, then with trailing and then all outer spaces ignored. */
function seek(lines: string[], wanted: string[], from: number, atEnd: boolean): number {
  if (wanted.length === 0) return lines.length;
  for (const norm of [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim()]) {
    const starts = atEnd ? [lines.length - wanted.length] : [];
    for (let at = from; at <= lines.length - wanted.length; at++) starts.push(at);
    for (const at of starts) {
      if (at < 0) continue;
      if (wanted.every((line, k) => norm(lines[at + k] ?? "") === norm(line))) return at;
    }
  }
  return -1;
}

/** The file after the chunks of an update, or a fault that names the chunk the file does not have. */
export function applyChunks(content: string, chunks: PatchChunk[]): string | Error {
  const endsWithNewline = content.endsWith("\n");
  const lines = (endsWithNewline ? content.slice(0, -1) : content).split("\n");
  if (content === "") lines.length = 0;
  let cursor = 0;
  for (const [n, chunk] of chunks.entries()) {
    if (chunk.context !== undefined) {
      const at = seek(lines, [chunk.context], cursor, false);
      if (at === -1) return new Error(`chunk ${n + 1}: the file has no line "${chunk.context}"`);
      cursor = at + 1;
    }
    let old = chunk.oldLines;
    let replacement = chunk.newLines;
    let at = seek(lines, old, cursor, chunk.atEnd);
    // A trailing blank line in the chunk can stand for the end of the file.
    if (at === -1 && old.at(-1) === "") {
      old = old.slice(0, -1);
      replacement = replacement.at(-1) === "" ? replacement.slice(0, -1) : replacement;
      at = seek(lines, old, cursor, chunk.atEnd);
    }
    if (at === -1)
      return new Error(`chunk ${n + 1}: the file does not have these lines:\n${chunk.oldLines.join("\n")}`);
    lines.splice(at, old.length, ...replacement);
    cursor = at + replacement.length;
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}${endsWithNewline || content === "" ? "\n" : ""}`;
}
