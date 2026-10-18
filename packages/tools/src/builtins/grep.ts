import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { requirePathScope } from "@agency/guard";
import { t } from "@agency/i18n";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import { loadGitignore } from "../gitignore.ts";
import { clip, lineCount, str, summarize } from "../render.ts";
import { DECLARATION } from "./read.ts";

const MAX_MATCHES = 200;
// Live: 112 of 714 greps hit the cap and held half of all grep text, and the next reads went to files past it.
const CAPPED_SHOWN = 100;
/** A longer line keeps its start: one match in a minified file would fill the whole result. */
const MAX_LINE_CHARS = 1_000;

// Live: after a grep that hit one or two files, 82% of the next slice reads held a match line; median 50 lines.
const AROUND_FILES = 2;
const AROUND_MATCHES = 6;
const AROUND_SPAN = 60;
const AROUND_LINES = 120;

const isDeclaration = (line: string | undefined): boolean =>
  line !== undefined && DECLARATION.some((pattern) => pattern.test(line));

/** For a few matches, the numbered lines from the declaration that holds each to the next one, as a slice shows them. */
function codeAround(matches: Array<{ path: string; line: number }>, open: (path: string) => string): string {
  const files = [...new Set(matches.map((match) => match.path))];
  if (files.length > AROUND_FILES || matches.length > AROUND_MATCHES) return "";
  let budget = AROUND_LINES;
  const out: string[] = [];
  for (const file of files) {
    let lines: string[];
    try {
      lines = open(file)
        .replace(/\r?\n$/, "")
        .split(/\r?\n/);
    } catch {
      continue;
    }
    // A minified file shows nothing more than its cut match line.
    if (lines.some((line) => line.length > MAX_LINE_CHARS)) continue;
    const spans: Array<[number, number]> = [];
    for (const { line } of matches.filter((match) => match.path === file)) {
      const at = line - 1;
      let start = at;
      while (start > 0 && start > at - AROUND_SPAN / 3 && !isDeclaration(lines[start])) start--;
      let end = at + 1;
      while (end < lines.length && end - start < AROUND_SPAN && !isDeclaration(lines[end])) end++;
      const last = spans.at(-1);
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else spans.push([start, end]);
    }
    const shown: string[] = [];
    for (const [start, end] of spans) {
      const take = Math.min(end - start, budget);
      budget -= take;
      for (let index = start; index < start + take; index++) shown.push(`${index + 1}\t${lines[index]}`);
    }
    if (shown.length > 0) out.push(file, ...shown);
  }
  return out.length === 0
    ? ""
    : `\n\n[The code around these matches, as a read of these lines gives it:]\n${out.join("\n")}`;
}

/** rg and grep -rn both print matches as `path:line:content`; context lines use `-` separators. */
const MATCH_LINE = /^(.+):(\d+):/;

/** `path:12:text` lines as `rg --heading` prints them: each path once, then its `12:text` lines. */
function grouped(lines: string[]): string[] {
  const out: string[] = [];
  let file: string | undefined;
  for (const line of lines) {
    const match = /^(.+?):\d+:/.exec(line);
    if (!match?.[1]) {
      out.push(line);
      continue;
    }
    if (match[1] !== file) {
      file = match[1];
      out.push(file);
    }
    out.push(line.slice(match[1].length + 1));
  }
  return out;
}

function trySpawn(args: string[], cwd: string) {
  try {
    return Bun.spawn(args, { cwd, windowsHide: true, stdout: "pipe", stderr: "pipe" });
  } catch {
    return undefined;
  }
}

let grepRegexFlag: string | undefined;

/** rg's regex is near PCRE: GNU grep has -P, BSD grep (macOS) only -E. Plain grep reads `a|b` as text, so finds nothing. */
function grepRegex(): string {
  if (grepRegexFlag === undefined) {
    try {
      const probe = Bun.spawnSync(["grep", "-qP", "a|\\d"], {
        windowsHide: true,
        stdin: new TextEncoder().encode("1\n"),
        stdout: "ignore",
        stderr: "ignore",
      });
      grepRegexFlag = probe.exitCode === 0 ? "-P" : "-E";
    } catch {
      grepRegexFlag = "-E";
    }
  }
  return grepRegexFlag;
}

interface CapOptions {
  maxMatches: number;
  filesOnly: boolean;
}

/**
 * Reads a search process's stdout enforcing a GLOBAL match cap: match lines
 * (every line in files-only mode) are counted across all files, and the
 * process is killed once the cap is exceeded — the per-file `-m` cap this
 * replaces let a broad search return unbounded output. Returns the text cut
 * at a line boundary plus whether the cap fired.
 */
async function readWithGlobalCap(
  stream: ReadableStream<Uint8Array>,
  options: CapOptions,
): Promise<{ text: string; capped: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let lineStart = 0;
  let matchCount = 0;
  let capped = false;

  const countLine = (line: string): boolean => {
    if (!options.filesOnly && !MATCH_LINE.test(line)) return false;
    matchCount += 1;
    return matchCount > options.maxMatches;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      let index = text.indexOf("\n", lineStart);
      while (index !== -1) {
        if (countLine(text.slice(lineStart, index))) {
          capped = true;
          break;
        }
        lineStart = index + 1;
        index = text.indexOf("\n", lineStart);
      }
      if (capped) break;
    }

    if (!capped) {
      const tail = text.slice(lineStart);
      if (tail.length > 0 && countLine(tail)) capped = true;
    }
  } catch {
    // stream torn down (abort kill) — keep whatever settled
  } finally {
    if (capped) {
      text = text.slice(0, lineStart);
      try {
        await reader.cancel();
      } catch {
        // pipe already closed by the kill
      }
    }
  }

  return { text, capped };
}

/** rg type names whose files do not end in the name itself. */
const TYPE_EXTENSIONS: Record<string, string> = {
  ts: "{ts,tsx,mts,cts}",
  js: "{js,jsx,mjs,cjs}",
  rust: "rs",
  python: "py",
  markdown: "{md,markdown}",
};

/**
 * The search with no rg or grep: rg's output and rules (`.gitignore`, no hidden files, no binary files), and a
 * JavaScript regex, which reads rg's patterns but `(?i)` at the start, taken here as the flag.
 */
async function searchInProcess(
  root: string,
  /** The search root as the result names it: relative to the workspace. */
  target: string,
  input: {
    pattern: string;
    glob?: string;
    type?: string;
    caseInsensitive?: boolean;
    context?: number;
    filesOnly: boolean;
  },
  signal: AbortSignal,
): Promise<{ text: string; capped: boolean } | { error: string }> {
  const inline = input.pattern.startsWith("(?i)");
  let regex: RegExp;
  try {
    regex = new RegExp(
      inline ? input.pattern.slice(4) : input.pattern,
      input.caseInsensitive || inline ? "i" : "",
    );
  } catch (error) {
    return { error: `invalid regex: ${(error as Error).message}` };
  }
  const filter = input.type
    ? `**/*.${TYPE_EXTENSIONS[input.type] ?? input.type}`
    : input.glob === undefined
      ? "**/*"
      : input.glob.includes("/")
        ? input.glob
        : `**/${input.glob}`;
  // A file as the root is searched alone, as rg does.
  const single = statSync(root, { throwIfNoEntry: false })?.isFile() === true;
  const isIgnored = single ? undefined : loadGitignore(root);
  const paths = single ? [""] : new Bun.Glob(filter).scan({ cwd: root, onlyFiles: true });
  const out: string[] = [];
  let matches = 0;
  for await (const rawPath of paths) {
    if (signal.aborted) break;
    const path = rawPath.replace(/\\/g, "/");
    if (/(^|\/)node_modules\//.test(path) || isIgnored?.(path)) continue;
    let bytes: Uint8Array;
    try {
      bytes = await Bun.file(single ? root : join(root, path)).bytes();
    } catch {
      continue;
    }
    if (bytes.subarray(0, 8000).includes(0)) continue;
    const lines = new TextDecoder().decode(bytes).split("\n");
    const hits = lines.flatMap((line, index) => (regex.test(line.replace(/\r$/, "")) ? [index] : []));
    if (hits.length === 0) continue;
    const file = single ? target : target === "." ? path : `${target}/${path}`;
    if (input.filesOnly) {
      out.push(file);
      if (++matches > MAX_MATCHES) return { text: out.slice(0, -1).join("\n"), capped: true };
      continue;
    }
    const around = input.context ?? 0;
    const shown = new Set(
      hits.flatMap((hit) => Array.from({ length: 2 * around + 1 }, (_, i) => hit - around + i)),
    );
    let last = -2;
    for (const index of [...shown].filter((i) => i >= 0 && i < lines.length).sort((a, b) => a - b)) {
      if (around > 0 && last >= 0 && index > last + 1) out.push("--");
      const hit = hits.includes(index);
      if (hit && ++matches > MAX_MATCHES) return { text: out.join("\n"), capped: true };
      out.push(
        `${file}${hit ? ":" : "-"}${index + 1}${hit ? ":" : "-"}${(lines[index] ?? "").replace(/\r$/, "")}`,
      );
      last = index;
    }
  }
  return { text: out.join("\n"), capped: false };
}

export function createGrepTool(deps: ToolDeps): ToolSpec {
  const spec: ToolSpec<{
    pattern: string;
    path?: string;
    glob?: string;
    caseInsensitive?: boolean;
    context?: number;
    type?: string;
    filesOnly?: boolean;
  }> = {
    name: "grep",
    description:
      "Searches file contents for a regex pattern (ripgrep syntax; `a|b` matches either), returning " +
      "matching lines with line numbers, each file's path once above its lines, under a global 200-match cap. Skips .gitignore'd, hidden and " +
      "binary files. Optional: caseInsensitive, context (lines shown around each match), filesOnly " +
      "(list file paths only), type (e.g. 'ts', 'rust') restricts by file type.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Directory to search; defaults to the project root." },
        glob: { type: "string", description: "Restrict to files matching this glob, e.g. '*.ts'." },
        caseInsensitive: { type: "boolean" },
        context: { type: "integer", description: "Lines of context around each match." },
        type: { type: "string", description: "File type filter, e.g. 'ts'." },
        filesOnly: { type: "boolean", description: "List matching file paths instead of lines." },
      },
      required: ["pattern"],
    },
    riskTier: "safe",
    readOnly: () => true,
    renderCall: (input) => `grep ${summarize(str(input.pattern))}${input.path ? ` ${str(input.path)}` : ""}`,
    renderResult: (result) => {
      const pattern = str(result.input?.pattern);
      const label = pattern ? `grep ${pattern}` : "grep";
      if (result.isError) return `${label} failed: ${summarize(result.content)}`;
      const trimmed = result.content.trim();
      if (trimmed === "" || trimmed === "no matches") return `${label}: no matches`;
      const matches = result.content.match(/^\d+:/gm)?.length ?? lineCount(result.content);
      return `${label}: ${matches} ${matches === 1 ? "match" : "matches"} (${clip(result.content)})`;
    },

    async handler(input, ctx) {
      const searchRoot = deps.sandbox.resolvePath(input.path ?? ".");
      requirePathScope(deps.identity, deps.capabilities, searchRoot);

      const context =
        typeof input.context === "number" && Number.isInteger(input.context) && input.context > 0
          ? input.context
          : undefined;
      const filesOnly = input.filesOnly === true;
      // Paths relative to the workspace, which `read` takes: an absolute one on each line was most of the result.
      const workspace = deps.sandbox.resolvePath(".");
      const target = relative(workspace, searchRoot).replace(/\\/g, "/") || ".";
      const rgArgs = [
        "rg",
        ...(filesOnly ? ["--files-with-matches"] : ["--line-number", "--no-heading", "--with-filename"]),
        "--color=never",
        ...(input.caseInsensitive ? ["-i"] : []),
        ...(context !== undefined && !filesOnly ? ["-C", String(context)] : []),
        ...(input.type ? ["--type", input.type] : []),
        ...(input.glob ? ["--glob", input.glob] : []),
        "--",
        input.pattern,
        target,
      ];

      let proc = trySpawn(rgArgs, workspace);

      // grep -rn matches rg's `path:line:content` output and exit-1-on-no-matches semantics. It has no type filter.
      // Git's grep on Windows is an MSYS program: its start expands `*` and drops `\` in a pattern (`\+.*x` fails).
      if (!proc && !input.type && process.platform !== "win32") {
        // As rg does: no binary files, no .git or node_modules. --include takes a file name, not rg's `**/*.ts`.
        proc = trySpawn(
          [
            "grep",
            filesOnly ? "-rl" : "-rnH",
            grepRegex(),
            "-I",
            "--exclude-dir=.git",
            "--exclude-dir=node_modules",
            "--color=never",
            ...(input.caseInsensitive ? ["-i"] : []),
            ...(context !== undefined && !filesOnly ? ["-C", String(context)] : []),
            ...(input.glob ? ["--include", input.glob.split("/").pop() as string] : []),
            "--",
            input.pattern,
            target,
          ],
          workspace,
        );
      }

      let found: { text: string; capped: boolean };
      if (!proc) {
        // Windows has neither program on its PATH: Git's grep is only on the PATH of Git Bash.
        const searched = await searchInProcess(
          searchRoot,
          target,
          { ...input, context, filesOnly },
          ctx.signal,
        );
        if ("error" in searched) return { content: searched.error, isError: true };
        found = searched;
      } else {
        const running = proc;
        const onAbort = () => running.kill();
        ctx.signal.addEventListener("abort", onAbort);
        try {
          found = await readWithGlobalCap(running.stdout, { maxMatches: MAX_MATCHES, filesOnly });
          if (found.capped) {
            try {
              running.kill();
            } catch {
              // already exited
            }
          }
          await running.exited;
          // Both rg and grep exit 1 for "no matches", a normal, non-error result here.
          // A capped run was killed on purpose, so its exit code is not an error.
          if (!found.capped && running.exitCode !== 0 && running.exitCode !== 1) {
            const stderr = await new Response(running.stderr).text();
            return { content: stderr || `search exited with code ${running.exitCode}`, isError: true };
          }
        } finally {
          ctx.signal.removeEventListener("abort", onAbort);
        }
      }

      let lines = found.text
        .trim()
        .split("\n")
        // `.` as the root prints `./a.ts`.
        .map((line) => line.replace(/^\.[\\/]/, ""))
        .map((line) =>
          line.length > MAX_LINE_CHARS
            ? `${line.slice(0, MAX_LINE_CHARS)}… [${line.length - MAX_LINE_CHARS} more characters on this line]`
            : line,
        );
      // A capped search shows the first matches and then the path of each other file that matches, as one list.
      let others = "";
      if (found.capped && !filesOnly && context === undefined) {
        let count = 0;
        lines = lines.filter((line) => !MATCH_LINE.test(line) || ++count <= CAPPED_SHOWN);
        const listed = await spec.handler({ ...input, filesOnly: true }, ctx);
        const shown = new Set(lines.map((line) => /^(.+?):\d+:/.exec(line)?.[1]));
        const rest = listed.isError ? [] : listed.content.split("\n").filter((path) => !shown.has(path));
        others =
          rest.length === 0
            ? `\n${t("tool.grep.truncated", { count: CAPPED_SHOWN })}`
            : `\n${t("tool.grep.truncated_more", { count: CAPPED_SHOWN })}\n${rest.join("\n")}`;
      }
      // Context lines keep the path on each line: `path-12-text` has no unambiguous end of the path.
      const trimmed = (filesOnly || context !== undefined ? lines : grouped(lines)).join("\n");
      // A line of context has no clear end of its path, so a search with context gives a script the text.
      const value =
        context !== undefined
          ? undefined
          : trimmed === ""
            ? []
            : filesOnly
              ? lines
              : lines.flatMap((line) => {
                  const match = /^(.+?):(\d+):/.exec(line);
                  return match
                    ? [{ path: match[1], line: Number(match[2]), text: line.slice(match[0].length) }]
                    : [];
                });
      if (trimmed === "") return { content: t("tool.grep.no_matches"), ...(value ? { value } : {}) };
      const notice =
        others !== ""
          ? others
          : found.capped
            ? `\n${filesOnly ? t("tool.grep.truncated_files", { count: MAX_MATCHES }) : t("tool.grep.truncated", { count: MAX_MATCHES })}`
            : "";
      const around =
        filesOnly || context !== undefined || found.capped || !Array.isArray(value)
          ? ""
          : codeAround(value as Array<{ path: string; line: number }>, (path) =>
              readFileSync(deps.sandbox.resolvePath(path), "utf8"),
            );
      return { content: trimmed + notice + around, ...(value ? { value } : {}) };
    },
  };
  return spec;
}
