import { execFileSync } from "node:child_process";
import { readFileSync, type Stats, statSync } from "node:fs";
import { basename } from "node:path";
import { requirePathScope } from "@agency/guard";
import { t } from "@agency/i18n";
import { type ImageBlock, PDF_MIME } from "@agency/schema";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import type { ReadState } from "../read-state.ts";
import { lineCount, str, summarize } from "../render.ts";
import { renderNotebook } from "./notebook.ts";

const MAX_READ_BYTES = 1_000_000; // ~1MB; bigger files should be grepped or read in slices

/** Image formats every vision-capable provider we ship accepts (P7 image input), and PDF: the adapters send it. */
export const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": PDF_MIME,
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export function imageMimeFor(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return undefined;
  return IMAGE_MIME_BY_EXTENSION[path.slice(dot).toLowerCase()];
}

/** Up to five files of the git index (and untracked, not ignored) that have this name, relative to root. */
function sameName(root: string, name: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    return out
      .split("\0")
      .filter((file) => basename(file) === name)
      .slice(0, 5);
  } catch {
    return [];
  }
}

export interface ReadToolOptions {
  /** Session read journal; marks files so write can warn on unread overwrites. */
  readState?: ReadState;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

type ReadInput = { path: string; offset?: number; limit?: number } & Record<string, unknown>;

/** Live: models sent `{start, end}` and the names of other harnesses, which a read ignored and so gave the whole file. */
function rangeOf(input: ReadInput): { offset: number; limit: number | undefined } {
  const offset =
    positiveInt(input.offset) ?? positiveInt(input.start ?? input.start_line ?? input.startLine) ?? 1;
  const end = positiveInt(input.end ?? input.end_line ?? input.endLine);
  const limit =
    positiveInt(input.limit) ?? (end !== undefined && end >= offset ? end - offset + 1 : undefined);
  return { offset, limit };
}

/** The loop cuts a result at 2000 lines or 50 KB: a read stops first, at a whole line, and says where the rest starts. */
const HEAD_LINES = 2000;
const HEAD_BYTES = 45_000;

const OUTLINE_MAX = 200;
/** Declaration lines: JS/TS, Python, Rust, Go, methods two spaces in, Markdown headings. */
const DECLARATION = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+[\w$]/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+[\w$]/,
  /^(?:export\s+)?(?:declare\s+)?(?:interface|type|enum|namespace)\s+[\w$]/,
  /^(?:export\s+)?(?:const|let|var)\s+[\w$]/,
  /^ {2}(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*(?!(?:if|for|while|switch|catch|return)\b)[\w$#]+\s*(?:<[^>]*>)?\(.*\)[^;=]*\{\s*$/,
  /^\s*(?:async\s+)?def\s+\w|^\s*class\s+\w/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod)\b/,
  /^func\s|^type\s+\w/,
  /^#{1,6}\s/,
];

/** The line of each declaration, as the skeleton of a file that Agentless shows a model to find where to look. */
function outlineOf(content: string): string | undefined {
  const lines = content.split("\n");
  const kept: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (!DECLARATION.some((pattern) => pattern.test(line))) continue;
    if (kept.length === OUTLINE_MAX) return undefined;
    kept.push(`${index + 1}\t${line.length > 160 ? `${line.slice(0, 160)}…` : line}`);
  }
  if (kept.length < 3) return undefined;
  const size = Math.round(Buffer.byteLength(content, "utf8") / 1000);
  return `${kept.join("\n")}\n[The file has ${lines.length} lines (${size} KB), too many to send whole: these are the lines of its declarations. To see the code, read with offset and limit (limit 2000 for the whole file), or grep.]`;
}

/**
 * Each line after its number and a tab, as Claude Code reads: with none, models read again with `sed -n` to cite or
 * find one. A padded number and two spaces cost about 30% more tokens than the file, a tab about 11% (o200k).
 */
function numbered(
  content: string,
  offset: number,
  limit: number | undefined,
): { text: string; cut: boolean } {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const end = Math.min(lines.length, limit === undefined ? lines.length : offset - 1 + limit);
  const out: string[] = [];
  let used = 0;
  for (let index = offset - 1; index < end && out.length < HEAD_LINES; index++) {
    const rendered = `${index + 1}\t${lines[index]}`;
    used += Buffer.byteLength(rendered, "utf8") + 1;
    // One line over the limit (a minified file) is the loop's to cut.
    if (used > HEAD_BYTES && out.length > 0) break;
    out.push(rendered);
  }
  const last = offset - 1 + out.length;
  if (last >= end) return { text: out.join("\n"), cut: false };
  return {
    text: `${out.join("\n")}\n[The file has ${lines.length} lines: these are lines ${offset} to ${last}. Read with offset ${last + 1} for the rest, or grep for what you need.]`,
    cut: true,
  };
}

export function createReadTool(deps: ToolDeps, options?: ReadToolOptions): ToolSpec {
  const spec: ToolSpec<ReadInput> = {
    name: "read",
    description:
      "Reads the contents of a file at the given path. A whole file comes as it is; a part, or a file too large " +
      "to send whole, has each line after its number (not part of the file: leave it out of edit text). For a " +
      "part, pass offset (1-based line to start from) and limit (lines per read); files over 1MB must be read in parts.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, absolute or relative to the project root." },
        offset: { type: "integer", description: "1-based line to start reading from. Default 1." },
        limit: { type: "integer", description: "Maximum number of lines to return. Default: all." },
      },
      required: ["path"],
    },
    riskTier: "safe",
    readOnly: () => true,
    renderCall: (input) => `read ${str(input.path)}`,
    renderResult: (result) => {
      const path = str(result.input?.path);
      const label = path ? `read ${path}` : "read";
      if (result.isError) return `${label} failed: ${summarize(result.content)}`;
      return `${label}: ${lineCount(result.content)} lines`;
    },

    async handler(input, ctx) {
      const resolved = await deps.sandbox.resolvePathGated(input.path, {
        tool: "read",
        ask: ctx.requestApproval,
      });
      requirePathScope(deps.identity, deps.capabilities, resolved);
      options?.readState?.mark(resolved);

      let stat: Stats;
      try {
        stat = statSync(resolved);
      } catch (error) {
        // Live, 19 of 26 failed reads named a file that the project has in another folder.
        const near =
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? sameName(deps.sandbox.resolvePath("."), basename(resolved))
            : [];
        if (near.length === 0) throw error;
        return {
          content: `${(error as Error).message}\n${t("tool.read.same_name", { paths: near.join(", ") })}`,
          isError: true,
        };
      }
      const { offset, limit } = rangeOf(input);
      const slicing = offset !== 1 || limit !== undefined;

      if (stat.size > MAX_READ_BYTES && !slicing) {
        return {
          content: t("tool.read.too_large", { bytes: stat.size, limit: MAX_READ_BYTES }),
          isError: true,
        };
      }

      const mime = imageMimeFor(resolved);
      if (mime) {
        const image: ImageBlock = {
          type: "image",
          mimeType: mime,
          data: readFileSync(resolved).toString("base64"),
        };
        return {
          content: t("image.read.attached", { path: input.path, mime, bytes: stat.size }),
          images: [image],
        };
      }

      const content = readFileSync(resolved, "utf8");
      // A notebook reads as its cells and their outputs, as in Claude Code; a slice gives the raw JSON.
      if (!slicing && resolved.toLowerCase().endsWith(".ipynb")) {
        try {
          return { content: renderNotebook(content) };
        } catch {
          return { content };
        }
      }
      // Only a file that a whole read would cut: live, an outline of a 30 KB file had a model page through it in
      // seven reads of 100 lines, each a round trip that sent the whole history again.
      const { text, cut } = numbered(content, offset, limit);
      // Raw when it fits: in three paired live runs numbered whole reads raised research input 14% to 35%.
      if (!slicing && !cut) return { content };
      return { content: (!slicing && cut && outlineOf(content)) || text };
    },
  };
  return spec;
}
