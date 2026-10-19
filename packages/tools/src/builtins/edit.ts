import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { requirePathScope } from "@agency/guard";
import { t } from "@agency/i18n";
import { AgencyError, ErrorCode } from "@agency/schema";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import { applyEditsVerified, type EditHunk } from "../edit-engine.ts";
import type { FormatterConfig } from "../formatter.ts";
import { runFormatter } from "../formatter.ts";
import { applyChunks, parsePatch } from "../patch.ts";
import type { ReadState } from "../read-state.ts";
import { clip, projectPath, str, summarize } from "../render.ts";
import type { SnapshotStore } from "../snapshot.ts";
import { syntaxNote } from "../syntax.ts";

export interface EditToolOptions {
  /** LSP diagnostics seam: error-severity diagnostics ride along on results. */
  diagnostics?: (
    path: string,
  ) => readonly { severity: number; message: string; line: number; character: number }[];
  /** Session read journal; marks edited files as read. */
  readState?: ReadState;
}

type EditInput = {
  path: string;
  oldText?: string;
  newText?: string;
  hunks?: EditHunk[];
  replaceAll?: boolean;
  /** A Codex `apply_patch` patch of this one file: the form that GPT-5 models get (core's tool dialect). */
  patch?: string;
};

function hasHunks(input: EditInput): boolean {
  return Array.isArray(input.hunks) && input.hunks.length > 0;
}

function hasPair(input: EditInput): boolean {
  return typeof input.oldText === "string" && typeof input.newText === "string";
}

function hunksFor(input: EditInput): EditHunk[] {
  if (hasHunks(input)) {
    return (input.hunks ?? []).map((hunk) => ({
      oldText: typeof hunk?.oldText === "string" ? hunk.oldText : "",
      newText: typeof hunk?.newText === "string" ? hunk.newText : "",
      ...(typeof hunk?.replaceAll === "boolean" ? { replaceAll: hunk.replaceAll } : {}),
    }));
  }
  return [
    {
      oldText: typeof input.oldText === "string" ? input.oldText : "",
      newText: typeof input.newText === "string" ? input.newText : "",
      ...(input.replaceAll ? { replaceAll: true } : {}),
    },
  ];
}

const AROUND = 3;
const MAX_SHOWN = 40;

/**
 * Each changed block of the file as it is now, with 3 lines around it and the numbers of a `read` slice: the model can
 * check the change and place the next one with no new read. A block that the formatter changed, a `replaceAll`, a
 * deletion or a block over 40 lines is not shown.
 */
function changedLines(after: string, hunks: readonly EditHunk[]): string {
  const lines = after.split("\n");
  const blocks: string[] = [];
  let from = 0;
  for (const hunk of hunks) {
    if (hunk.replaceAll || hunk.newText === "") continue;
    let at = after.indexOf(hunk.newText, from);
    if (at === -1) at = after.indexOf(hunk.newText);
    if (at === -1) continue;
    from = at + hunk.newText.length;
    const first = after.slice(0, at).split("\n").length - 1;
    const start = Math.max(0, first - AROUND);
    const end = Math.min(lines.length - 1, first + hunk.newText.split("\n").length - 1 + AROUND);
    if (end - start + 1 > MAX_SHOWN) continue;
    blocks.push(
      lines
        .slice(start, end + 1)
        .map((line, i) => `${start + i + 1}\t${line}`)
        .join("\n"),
    );
  }
  return blocks.join("\n...\n");
}

export function createEditTool(
  deps: ToolDeps,
  snapshots: SnapshotStore,
  formatter: FormatterConfig,
  options?: EditToolOptions,
): ToolSpec {
  const spec: ToolSpec<EditInput> = {
    name: "edit",
    description:
      "Replaces exact blocks of text in a file with new text. Pass oldText+newText for one hunk, or " +
      "hunks: [{oldText, newText, replaceAll?}] to apply several in one call (all-or-nothing: a hunk " +
      "that fails to match rejects the whole call and writes nothing). Each oldText must match the " +
      "file's current content uniquely (include enough surrounding context); whitespace-only drift is " +
      "tolerated. Error diagnostics from language servers ride along on the result.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
        replaceAll: { type: "boolean" },
        hunks: {
          type: "array",
          description: "Multiple search/replace hunks applied in order in one call.",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string" },
              newText: { type: "string" },
              replaceAll: { type: "boolean" },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path"],
    },
    riskTier: "moderate",
    renderCall: (input) => `edit ${str(input.path)}`,
    renderResult: (result) =>
      result.isError ? `edit failed: ${summarize(result.content)}` : clip(result.content),

    async handler(input, ctx) {
      const resolved = await deps.sandbox.resolvePathGated(input.path, {
        tool: "edit",
        ask: ctx.requestApproval,
      });
      requirePathScope(deps.identity, deps.capabilities, resolved);

      if (typeof input.patch === "string") {
        const ops = parsePatch(input.patch);
        if (typeof ops === "string") return { content: `apply_patch rejected: ${ops}`, isError: true };
        const [op] = ops;
        // One file a call: the permission rules see the path of each change.
        if (ops.length > 1 || op?.path !== input.path)
          return {
            content: `apply_patch rejected: a patch here changes one file. Send one apply_patch call for each of ${ops.map((o) => o.path).join(", ")}, in one reply.`,
            isError: true,
          };
        if (op.kind === "update" && op.moveTo !== undefined)
          return {
            content:
              "apply_patch rejected: *** Move to is not taken here. Change the file, then move it with the shell.",
            isError: true,
          };
        const before = existsSync(resolved) ? readFileSync(resolved, "utf8") : undefined;
        if (op.kind !== "add" && before === undefined)
          return { content: t("tool.edit.missing_file", { path: input.path }), isError: true };
        if (op.kind === "delete") {
          snapshots.capture(resolved, before as string, ctx.turnId);
          unlinkSync(resolved);
          return { content: `deleted ${input.path}` };
        }
        const after = op.kind === "add" ? op.content : applyChunks(before as string, op.chunks);
        if (after instanceof Error)
          return { content: `apply_patch rejected: ${after.message}`, isError: true };
        if (after === before)
          return { content: t("tool.edit.no_change", { path: input.path }), isError: true };
        if (before === undefined) {
          mkdirSync(dirname(resolved), { recursive: true });
          snapshots.captureCreated(resolved, ctx.turnId);
        } else snapshots.capture(resolved, before, ctx.turnId);
        writeFileSync(resolved, after, "utf8");
        options?.readState?.mark(resolved);
        await runFormatter(formatter, resolved);
        snapshots.recordAfter(resolved);
        let content = t("tool.edit.applied", {
          path: projectPath(deps.sandbox.resolvePath("."), resolved, input.path),
        });
        const broken = syntaxNote(input.path, before, after);
        if (broken !== undefined) content += `\n${broken}`;
        return { content };
      }

      if (hasHunks(input) === hasPair(input)) {
        return { content: t("tool.edit.bad_input"), isError: true };
      }

      let current: string;
      try {
        current = readFileSync(resolved, "utf8");
      } catch {
        return {
          content: t("tool.edit.missing_file", { path: input.path }),
          isError: true,
        };
      }

      const hunks = hunksFor(input);
      for (const [index, hunk] of hunks.entries()) {
        if (hunk.oldText.length === 0) {
          return { content: t("tool.edit.empty_hunk", { index: index + 1 }), isError: true };
        }
      }

      try {
        const outcome = applyEditsVerified(current, hunks, {
          path: resolved,
          diagnostics: options?.diagnostics,
        });
        // Live: an edit that changed nothing said "edited", and the model went on as if it had.
        if (outcome.content === current) {
          return { content: t("tool.edit.no_change", { path: input.path }), isError: true };
        }
        snapshots.capture(resolved, current, ctx.turnId);
        writeFileSync(resolved, outcome.content, "utf8");
        // Live: a write after three edits of a file warned that the file was never read.
        options?.readState?.mark(resolved);
        await runFormatter(formatter, resolved);
        snapshots.recordAfter(resolved);
        const shownPath = projectPath(deps.sandbox.resolvePath("."), resolved, input.path);
        let content = t("tool.edit.applied", { path: shownPath });
        if (hunks.length > 1) content += `\n${t("tool.edit.hunks_applied", { count: hunks.length })}`;
        const shown = changedLines(readFileSync(resolved, "utf8"), hunks);
        if (shown !== "") content += `\n${shown}`;
        const broken = syntaxNote(input.path, current, outcome.content);
        if (broken !== undefined) content += `\n${broken}`;
        if (outcome.warnings.length > 0) {
          content += `\n${t("lsp.diagnostics.warning", {
            count: outcome.warnings.length,
            path: shownPath,
            summary: outcome.warnings.join("; "),
          })}`;
        }
        return { content };
      } catch (error) {
        if (error instanceof AgencyError && error.code === ErrorCode.TOOL_ERROR) {
          return { content: error.message, isError: true };
        }
        throw error;
      }
    },
  };
  return spec;
}
