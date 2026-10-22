import { emptyMd, finishMd, pushMd } from "../render-model/markdown.ts";
import type { Block, Step, Turn } from "./types.ts";
import type { WireContent, WireEntry, WireTurnEnd } from "./wire.ts";

export interface Hydrated {
  blocks: Block[];
  model: string | null;
  title: string | null;
}

const ms = (iso: string | undefined): number => (iso ? Date.parse(iso) || 0 : 0);

const SHELL = /<shell-command>([\s\S]*?)<\/shell-command>\s*<shell-output>([\s\S]*?)<\/shell-output>/;

function textOf(content: readonly WireContent[]): string {
  return content
    .filter((c): c is Extract<WireContent, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/**
 * Rebuilds the transcript from the entries of a session file (`session_show`.entries). A turn with no end entry
 * in a session that has them was cut off, unless a turn runs there now (`live`).
 */
export function hydrate(entries: readonly WireEntry[], live = false): Hydrated {
  const blocks: Block[] = [];
  const ended = new Set<string>();
  let cur: Turn | null = null;
  let model: string | null = null;
  let title: string | null = null;

  const open = (id: string, prompt: string, at: number): Turn => {
    const t: Turn = {
      kind: "turn",
      id,
      prompt,
      images: [],
      steps: [],
      answer: emptyMd,
      text: "",
      thinking: "",
      thoughtMs: 0,
      thoughtOpen: false,
      status: "waiting",
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      ttftMs: 0,
      streamMs: 0,
      startedAt: at,
      approval: null,
      answered: false,
    };
    blocks.push(t);
    return t;
  };

  // Turns are rebuilt in place, so the blocks array holds the latest value of each.
  const replace = (t: Turn): Turn => {
    const i = blocks.findIndex((b) => b.kind === "turn" && b.id === t.id);
    if (i >= 0) blocks[i] = t;
    return t;
  };

  for (const e of entries) {
    const at = ms(e.createdAt);
    if (e.type === "turn_end" && typeof e.forTurn === "string") {
      const end = e as unknown as WireTurnEnd & {
        forTurn: string;
        error?: { code: string; message: string };
      };
      const t = blocks.find((b): b is Turn => b.kind === "turn" && b.id === end.forTurn);
      if (t) {
        const status: Turn["status"] =
          end.outcome === "failed"
            ? "error"
            : end.outcome === "denied"
              ? "denied"
              : end.outcome === "stopped"
                ? "stopped"
                : "done";
        replace({
          ...t,
          status,
          end: { outcome: end.outcome, checks: end.checks, ...(end.head ? { head: end.head } : {}) },
          ...(end.error ? { error: end.error } : {}),
          ...(end.outcome === "denied" && end.deniedBy ? { stoppedBy: `you denied ${end.deniedBy}` } : {}),
        });
        ended.add(end.forTurn);
      }
    } else if (e.type === "session_title" && typeof e.title === "string") title = e.title;
    else if (e.type === "model_change" && typeof e.model === "string") model = e.model;
    else if (e.type === "compaction_summary") {
      blocks.push({ kind: "event", id: e.id, text: "compacted · earlier turns summarized" });
    } else if (e.type === "usage" && cur) {
      const u = e as unknown as {
        model?: string;
        costUsd?: number;
        usage?: Turn["usage"];
        timing?: { ttftMs: number; streamMs: number };
      };
      cur = replace({
        ...cur,
        costUsd: u.costUsd ?? 0,
        usage: u.usage ?? cur.usage,
        ttftMs: u.timing?.ttftMs ?? 0,
        streamMs: u.timing?.streamMs ?? 0,
        endedAt: at || cur.endedAt,
      });
      if (u.model) model = u.model;
    } else if (e.type === "message" && e.message) {
      const m = e.message;
      if (e.origin === "shell") {
        const hit = SHELL.exec(textOf(m.content));
        if (hit)
          blocks.push({
            kind: "shell",
            id: e.id,
            cmd: (hit[1] ?? "").trim(),
            out: (hit[2] ?? "").replace(/\n+$/, "").split("\n"),
            status: "done",
          });
      } else if (e.origin === "harness") {
        // Hook feedback is not the person's prompt.
      } else if (m.role === "user") {
        const results = m.content.filter(
          (c): c is Extract<WireContent, { type: "tool_result" }> => c.type === "tool_result",
        );
        if (results.length > 0 && cur) {
          const byId = new Map(results.map((r) => [r.toolCallId, r]));
          cur = replace({
            ...cur,
            steps: cur.steps.map((s) => {
              const r = byId.get(s.id);
              if (!r) return s;
              const denied = r.isError === true && /^permission denied/i.test(r.content);
              return {
                ...s,
                status: denied ? "denied" : r.isError ? "error" : "ok",
                content: r.content,
              } satisfies Step;
            }),
          });
        } else if (e.origin === "inbox") {
          blocks.push({ kind: "event", id: e.id, text: `› ${textOf(m.content)} (sent while the turn ran)` });
        } else {
          cur = open(e.turnId ?? e.id, textOf(m.content), at);
          cur.images = m.content
            .filter((c): c is Extract<WireContent, { type: "image" }> => c.type === "image")
            .map((c, i) => ({
              name: `image ${i + 1}`,
              size: Math.round((c.data.length * 3) / 4),
              mimeType: c.mimeType,
              data: "",
            }));
        }
      } else if (m.role === "assistant") {
        const t: Turn = cur ?? open(e.id, "", at);
        let answer = t.answer;
        let text = t.text;
        let thinking = t.thinking;
        const steps = [...t.steps];
        for (const c of m.content) {
          if (c.type === "text") {
            // Streamed text of separate requests runs together; a saved block ends its line the same way.
            const piece = c.text.endsWith("\n") ? c.text : `${c.text}\n`;
            answer = pushMd(answer, piece);
            text += piece;
          } else if (c.type === "thinking") thinking += c.text;
          else if (c.type === "tool_call")
            steps.push({ id: c.id, tool: c.name, input: c.input, status: "ok", open: false });
        }
        cur = replace({
          ...t,
          answer,
          text,
          thinking,
          steps,
          answered: true,
          status: "done",
          endedAt: at || t.endedAt,
        });
      }
    }
  }
  const lastId = blocks.findLast((b) => b.kind === "turn")?.id;
  const cutOff = !live && ended.size > 0;
  return {
    blocks: blocks.map((b) =>
      b.kind === "turn"
        ? {
            ...b,
            answer: finishMd(b.answer),
            ...(cutOff && b.id === lastId && !ended.has(b.id) && b.status === "done"
              ? { status: "stopped" as const, stoppedBy: "the daemon stopped before it ended" }
              : {}),
          }
        : b,
    ),
    model,
    title,
  };
}
