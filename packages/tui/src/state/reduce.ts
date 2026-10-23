import { completionFor, insertCompletion } from "../input/completion.ts";
import * as C from "../input/composer.ts";
import { emptyMd, finishMd, pushMd } from "../render-model/markdown.ts";
import type { ComposerOp, DaemonEvent, Event, UiEvent } from "./events.ts";
import { formatTokens } from "./format.ts";
import { hydrate } from "./hydrate.ts";
import { rowsOf, SETTINGS, setPath } from "./settings.ts";
import {
  type AppState,
  type Block,
  EFFORTS,
  type Effort,
  MODES,
  type PlanUi,
  type SessionState,
  type Step,
  type Turn,
  type UiMode,
} from "./types.ts";
import type { WireEvent } from "./wire.ts";

export const initialPlanUi = (requestId: string): PlanUi => ({
  requestId,
  at: 0,
  scroll: 0,
  note: "",
  max: null,
});

export function initialState(
  init: Partial<Pick<AppState, "cols" | "rows" | "workspace" | "theme">> = {},
): AppState {
  return {
    conn: "connecting",
    view: "home",
    back: "home",
    theme: init.theme ?? "agency",
    mode: "build",
    effort: "high",
    cols: init.cols ?? 80,
    rows: init.rows ?? 24,
    details: true,
    workspace: init.workspace ?? "",
    sessions: [],
    weekCostUsd: null,
    liveSessions: [],
    sessionId: null,
    bySession: {},
    composer: C.emptyComposer,
    histAt: -1,
    history: [],
    ac: null,
    files: [],
    slash: [],
    images: [],
    palette: { open: false, query: "", at: 0 },
    model: { open: false, q: "", at: 0, recent: [] },
    models: [],
    connectedProviders: [],
    keySource: {},
    defaultModel: null,
    review: {
      open: false,
      file: 0,
      git: null,
      diff: "",
      untracked: [],
      committed: null,
      commitMessage: "",
      commitNote: "",
      scroll: 0,
    },
    planUi: initialPlanUi(""),
    settings: { sec: 0, row: null, edit: null, config: {} },
    copied: null,
    lastEsc: 0,
    lastInterrupt: 0,
    flash: null,
    nextId: 1,
  };
}

export function newSession(id: string): SessionState {
  return {
    id,
    title: "new session",
    model: null,
    blocks: [],
    loading: false,
    runningTurnId: null,
    compaction: null,
    queue: [],
    status: null,
    statusLine: null,
    todos: [],
    scroll: 0,
    scrollMax: null,
    pickAt: null,
    runCostUsd: 0,
    tipId: null,
  };
}

export const FINISHED = ["done", "error", "stopped", "denied"] as const;
export const isFinished = (t: Turn): boolean => (FINISHED as readonly string[]).includes(t.status);

/** Indexes of the turns a person can pick: those that ended. */
export function pickable(blocks: readonly Block[]): number[] {
  const out: number[] = [];
  blocks.forEach((b, i) => {
    if (b.kind === "turn" && isFinished(b)) out.push(i);
  });
  return out;
}

const modeOfPermission = (p: string): UiMode =>
  p === "plan" ? "plan" : p === "auto" || p === "allow-all" ? "auto" : "build";

function session(state: AppState, id: string): SessionState {
  return state.bySession[id] ?? newSession(id);
}

/** The summary being written, after one compaction event: a start resets it, an end clears it. */
function tracked(
  was: SessionState["compaction"],
  e: { phase: "start" | "progress" | "end"; tokens?: number },
  at: number,
): SessionState["compaction"] {
  if (e.phase === "end") return null;
  if (e.phase === "start") return { at, tokens: 0 };
  return { at: was?.at ?? at, tokens: e.tokens ?? was?.tokens ?? 0 };
}

function withSession(state: AppState, id: string, fn: (s: SessionState) => SessionState): AppState {
  return { ...state, bySession: { ...state.bySession, [id]: fn(session(state, id)) } };
}

function withTurn(s: SessionState, turnId: string, fn: (t: Turn) => Turn): SessionState {
  let hit = false;
  const blocks = s.blocks.map((b) => {
    if (b.kind === "turn" && b.id === turnId) {
      hit = true;
      return fn(b);
    }
    return b;
  });
  return hit ? { ...s, blocks } : s;
}

/** A running turn takes the text and steps the file holds beyond it, keeping its own status, asks and the steps it already has. */
function catchUp(t: Turn, f: Turn): Turn {
  if (f.text.length <= t.text.length && f.steps.length <= t.steps.length) return t;
  return {
    ...t,
    answer: f.text.length > t.text.length ? f.answer : t.answer,
    text: f.text.length > t.text.length ? f.text : t.text,
    thinking: f.thinking.length > t.thinking.length ? f.thinking : t.thinking,
    steps:
      f.steps.length > t.steps.length ? f.steps.map((s) => t.steps.find((x) => x.id === s.id) ?? s) : t.steps,
  };
}

export function emptyTurn(id: string, prompt: string, at: number): Turn {
  return {
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
    status: "running",
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    ttftMs: 0,
    streamMs: 0,
    startedAt: at,
    approval: null,
    answered: false,
  };
}

function settle(t: Turn, status: Turn["status"], at: number): Turn {
  return {
    ...t,
    status,
    endedAt: at,
    answer: finishMd(t.answer),
    approval: null,
    steps: t.steps.map((st) =>
      st.status === "running" ? { ...st, status: status === "done" ? "ok" : "error" } : st,
    ),
  };
}

function reduceWire(t: Turn, s: SessionState, e: WireEvent): { t: Turn; s: SessionState; mode?: UiMode } {
  switch (e.type) {
    case "text_delta":
      return { t: { ...t, answer: pushMd(t.answer, e.text), text: t.text + e.text, answered: true }, s };
    case "thinking_delta":
      return { t: { ...t, thinking: t.thinking + e.text }, s };
    case "thinking_end":
      return { t: { ...t, thoughtMs: t.thoughtMs + e.ms }, s };
    case "approval_resolved":
      // Answered elsewhere, timed out or cancelled: the ask is gone whoever settled it.
      return t.approval?.requestId === e.requestId ? { t: { ...t, approval: null }, s } : { t, s };
    case "tool_start": {
      const step: Step = {
        id: e.id,
        tool: e.name,
        status: "running",
        open: false,
        ...(e.input ? { input: e.input } : {}),
      };
      return { t: { ...t, steps: [...t.steps, step], answered: true }, s };
    }
    case "tool_progress":
      return {
        t: { ...t, steps: t.steps.map((st) => (st.id === e.id ? { ...st, progress: e.message } : st)) },
        s,
      };
    case "tool_result": {
      const denied = e.isError && /^permission denied/i.test(e.content);
      const status = denied ? "denied" : e.isError ? "error" : "ok";
      return {
        t: {
          ...t,
          steps: t.steps.map((st) =>
            st.id === e.id ? { ...st, status, content: e.content, ...(e.meta ? { meta: e.meta } : {}) } : st,
          ),
        },
        s,
      };
    }
    case "turn_complete":
      return {
        t: {
          ...t,
          stopReason: e.stopReason,
          usage: {
            inputTokens: t.usage.inputTokens + (e.usage?.inputTokens ?? 0),
            outputTokens: t.usage.outputTokens + (e.usage?.outputTokens ?? 0),
            cachedInputTokens: (t.usage.cachedInputTokens ?? 0) + (e.usage?.cachedInputTokens ?? 0),
          },
          ttftMs: t.ttftMs === 0 ? (e.timing?.ttftMs ?? 0) : t.ttftMs,
          streamMs: t.streamMs + (e.timing?.streamMs ?? 0),
        },
        s,
      };
    case "budget_exceeded":
      return {
        t: { ...t, error: { code: "budget", message: `budget exceeded after ${e.spentTokens} tokens` } },
        s,
      };
    case "iteration_limit":
      return { t: { ...t, note: `stopped after ${e.iterations} steps` }, s };
    case "error":
      return { t: { ...t, error: { code: e.code, message: e.message } }, s };
    case "retry":
      return { t: { ...t, note: `retrying · attempt ${e.attempt}` }, s };
    case "fallback":
      return { t: { ...t, note: `fell back to ${e.to}` }, s };
    case "cost_meter":
      return { t: { ...t, costUsd: e.turnCostUsd }, s: { ...s, runCostUsd: e.runTotalUsd } };
    case "approval_requested": {
      const r = e.request ?? { tool: "tool", title: "" };
      return {
        t: {
          ...t,
          approval: {
            requestId: e.requestId,
            tool: r.tool,
            title: r.title,
            riskTier: e.riskTier,
            argsSummary: e.argsSummary,
            ...(r.command !== undefined ? { command: r.command } : {}),
            ...(r.path !== undefined ? { path: r.path } : {}),
          },
        },
        s,
      };
    }
    case "compaction":
      return { t, s };
    case "mode_changed":
      return { t, s, mode: modeOfPermission(e.mode) };
    case "prompt_suggestion":
      return { t: { ...t, suggestion: e.text }, s };
    default:
      return { t, s };
  }
}

function reduceDaemon(state: AppState, e: DaemonEvent): AppState {
  switch (e.type) {
    case "conn":
      return { ...state, conn: e.status };
    case "sessions_loaded":
      return { ...state, sessions: e.rows };
    case "live_turns":
      return { ...state, liveSessions: e.sessionIds };
    case "session_live":
      return {
        ...state,
        liveSessions: e.live
          ? [...new Set([...state.liveSessions, e.sessionId])]
          : state.liveSessions.filter((id) => id !== e.sessionId),
      };
    case "session_loading":
      return withSession(state, e.sessionId, (s) => ({ ...s, loading: true }));
    case "session_loaded": {
      const h = hydrate(e.entries, state.liveSessions.includes(e.sessionId));
      return withSession(state, e.sessionId, (s) => {
        // A turn that streams here now is newer than the file: keep it, and drop the file's copy of it.
        const fromFile = (t: Turn): Turn => {
          const f = h.blocks.find((x): x is Turn => x.kind === "turn" && x.id === t.id);
          return f && e.resumed?.includes(t.id) ? catchUp(t, f) : t;
        };
        const live = s.blocks
          .filter((b): b is Turn => b.kind === "turn" && b.status === "running")
          .map(fromFile);
        const ids = new Set(live.map((t) => t.id));
        return {
          ...s,
          loading: false,
          tipId: e.tipId,
          blocks: [...h.blocks.filter((x) => !(x.kind === "turn" && ids.has(x.id))), ...live],
          title: h.title ?? s.title,
        };
      });
    }
    case "week_cost_loaded":
      return { ...state, weekCostUsd: e.costUsd };
    case "status_loaded":
      return withSession(state, e.sessionId, (s) => ({
        ...s,
        status: e.status,
        statusLine: e.line,
      }));
    case "todos_loaded":
      return withSession(state, e.sessionId, (s) => ({ ...s, todos: e.todos }));
    case "files_loaded":
      return { ...state, files: e.files };
    case "slash_loaded":
      return { ...state, slash: e.slash };
    case "history_loaded":
      return { ...state, history: e.prompts };
    case "models_loaded":
      return {
        ...state,
        models: e.models,
        connectedProviders: e.connected,
        keySource: e.keySource ?? {},
        defaultModel: e.defaultModel ?? state.defaultModel,
      };
    case "git_loaded":
      return {
        ...state,
        review: {
          ...state.review,
          git: e.git,
          // The suggestion fills the commit box until a commit; after one, the box keeps what was committed.
          commitMessage: state.review.committed ? state.review.commitMessage : (e.git.suggestedMessage ?? ""),
          diff: e.diff?.diff ?? state.review.diff,
          untracked: e.diff?.untracked ?? state.review.untracked,
        },
      };
    case "config_loaded":
      return { ...state, theme: e.theme ?? state.theme, settings: { ...state.settings, config: e.config } };
    case "turn_started": {
      const turn = { ...emptyTurn(e.turnId, e.prompt, e.at), images: e.images };
      const next = withSession(state, e.sessionId, (s) => ({
        ...s,
        blocks: [...s.blocks, turn],
        runningTurnId: e.turnId,
        scroll: 0,
        pickAt: null,
        runCostUsd: 0,
      }));
      return { ...next, history: [e.prompt, ...next.history.filter((h) => h !== e.prompt)] };
    }
    case "compaction_seen":
      return withSession(state, e.sessionId, (s) => ({ ...s, compaction: tracked(s.compaction, e, e.at) }));
    case "turn_event": {
      let mode: UiMode | undefined;
      const next = withSession(state, e.sessionId, (s) => {
        const target = s.blocks.find((b): b is Turn => b.kind === "turn" && b.id === e.turnId);
        if (!target) return s;
        const r = reduceWire(target, s, e.event);
        mode = r.mode;
        const turned = withTurn(r.s, e.turnId, () => r.t);
        if (e.event.type !== "compaction") return turned;
        const updated = { ...turned, compaction: tracked(turned.compaction, e.event, e.at) };
        if (e.event.phase !== "end") return updated;
        // The summary happens before the model request of this turn, so its marker sits above the turn.
        const at = updated.blocks.findIndex((b) => b.kind === "turn" && b.id === e.turnId);
        const w = e.event;
        const sized =
          w.type === "compaction" && w.tokensBefore !== undefined && w.tokensAfter !== undefined
            ? ` · ${formatTokens(w.tokensBefore)} → ${formatTokens(w.tokensAfter)} tokens`
            : "";
        const n = w.type === "compaction" ? (w.replaced ?? 0) : 0;
        const marker: Block = {
          kind: "event",
          id: `compact-${e.turnId}`,
          text: `compacted · ${n > 0 ? `${n} earlier turn${n === 1 ? "" : "s"}` : "earlier turns"} summarized${sized}`,
        };
        return { ...updated, blocks: [...updated.blocks.slice(0, at), marker, ...updated.blocks.slice(at)] };
      });
      const ended = e.event.type === "turn_end" ? e.event : null;
      const out = ended
        ? reduceDaemon(next, {
            type: "turn_finished",
            sessionId: e.sessionId,
            turnId: e.turnId,
            at: e.at,
            outcome: {
              stopReason: ended.stopReason,
              ...(ended.cancelled ? { cancelled: true } : {}),
              ...(ended.error ? { error: ended.error } : {}),
              ...(ended.end ? { end: ended.end } : {}),
            },
          })
        : next;
      return mode && e.sessionId === state.sessionId ? { ...out, mode } : out;
    }
    case "turn_finished":
      return withSession(state, e.sessionId, (s) => {
        const done = withTurn(s, e.turnId, (t0) => {
          const t = e.outcome.end && !t0.end ? { ...t0, end: e.outcome.end } : t0;
          // The daemon says it twice, on the turn stream and as the answer of session_send: the first one counts.
          if (t.status === "done" || t.status === "error") return t;
          if (t.status === "denied" || t.status === "stopped") return settle(t, t.status, e.at);
          if (e.outcome.error) return settle({ ...t, error: e.outcome.error }, "error", e.at);
          if (t.error) return settle(t, "error", e.at);
          if (e.outcome.cancelled) return settle(t, "stopped", e.at);
          return settle({ ...t, stopReason: e.outcome.stopReason ?? t.stopReason }, "done", e.at);
        });
        return {
          ...done,
          runningTurnId: done.runningTurnId === e.turnId ? null : done.runningTurnId,
          compaction: null,
        };
      });
    case "turn_stopped":
      return withSession(state, e.sessionId, (s) =>
        withTurn(s, e.turnId, (t) =>
          t.status === "running"
            ? { ...t, status: "stopped", approval: null, stoppedBy: "you pressed esc" }
            : t,
        ),
      );
    case "approval_answered":
      return withSession(state, e.sessionId, (s) =>
        withTurn(s, e.turnId, (t) => {
          const ask = t.approval;
          if (!ask || ask.requestId !== e.requestId) return t;
          if (e.keep) return { ...t, approval: null };
          if (e.decision !== "reject")
            return {
              ...t,
              approval: null,
              steps: t.steps.map((st) =>
                st.status === "running" && st.tool === ask.tool
                  ? { ...st, answer: e.decision as "once" | "always" }
                  : st,
              ),
            };
          const target = ask.command ?? ask.path ?? ask.title;
          return {
            ...t,
            approval: null,
            status: "denied",
            stoppedBy: `you denied ${ask.tool} ${target}`,
            steps: t.steps.map((st) =>
              st.status === "running" && st.tool === ask.tool ? { ...st, status: "denied" } : st,
            ),
          };
        }),
      );
    case "prompt_queued":
      return withSession(state, e.sessionId, (s) => ({ ...s, queue: [...s.queue, e.item] }));
    case "queue_shifted":
      return withSession(state, e.sessionId, (s) => ({ ...s, queue: s.queue.filter((q) => q.id !== e.id) }));
    case "shell_started":
      return withSession(state, e.sessionId, (s) => ({
        ...s,
        scroll: 0,
        blocks: [...s.blocks, { kind: "shell", id: e.id, cmd: e.cmd, out: [], status: "running" }],
      }));
    case "shell_finished":
      return withSession(state, e.sessionId, (s) => ({
        ...s,
        blocks: s.blocks.map((b) =>
          b.kind === "shell" && b.id === e.id
            ? {
                ...b,
                status: e.isError ? "error" : "done",
                out: e.output.replace(/\n+$/, "").split("\n"),
                ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
              }
            : b,
        ),
      }));
    case "session_opened": {
      const id = e.sessionId;
      const opened = state.bySession[id]
        ? state
        : withSession(state, id, (s) => ({ ...s, title: e.title ?? s.title }));
      return {
        ...opened,
        view: "session",
        sessionId: id,
        palette: { open: false, query: "", at: 0 },
        review: { ...opened.review, open: false },
        composer: C.emptyComposer,
        ac: null,
        histAt: -1,
        images: [],
      };
    }
    case "model_applied": {
      const recent = [e.ref, ...state.model.recent.filter((m) => m !== e.ref)].slice(0, 3);
      return {
        ...state,
        defaultModel: e.ref,
        model: { ...state.model, open: false, recent },
        ...(e.sessionId
          ? {
              bySession: {
                ...state.bySession,
                [e.sessionId]: { ...session(state, e.sessionId), model: e.ref },
              },
            }
          : {}),
      };
    }
    case "notice":
      return withSession(state, e.sessionId, (s) => ({
        ...s,
        blocks: [...s.blocks, { kind: "event", id: e.id, text: e.text }],
      }));
    case "committed":
      return {
        ...state,
        review: {
          ...state.review,
          committed: e.pushed ? "pushed" : "local",
          commitNote: e.pushed
            ? `committed and pushed to ${e.upstream ?? e.branch}`
            : `committed on ${e.branch}`,
        },
      };
    case "suggestion_used":
      return withSession(state, e.sessionId, (s) => ({
        ...s,
        blocks: s.blocks.map((b) =>
          b.kind === "turn" && b.suggestion ? { ...b, suggestion: undefined } : b,
        ),
      }));
  }
}

function applyEdit(state: AppState, op: ComposerOp): AppState {
  const c = state.composer;
  let next: C.Composer = c;
  let images = state.images;
  switch (op.op) {
    case "insert":
      next = C.insert(c, op.text, op.pasted);
      break;
    case "newline":
      next = C.newline(c);
      break;
    case "backspace":
      if (c.text === "" && images.length > 0) images = images.slice(0, -1);
      else if (c.text === "" && c.shell) next = { ...c, shell: false };
      else next = C.backspace(c);
      break;
    case "delete":
      next = C.del(c);
      break;
    case "left":
      next = C.left(c);
      break;
    case "right":
      next = C.right(c);
      break;
    case "home":
      next = C.home(c);
      break;
    case "end":
      next = C.end(c);
      break;
    case "wordLeft":
      next = C.wordLeft(c);
      break;
    case "wordRight":
      next = C.wordRight(c);
      break;
    case "deleteWord":
      next = C.deleteWord(c);
      break;
    case "toStart":
      next = C.deleteToStart(c);
      break;
    case "toEnd":
      next = C.deleteToEnd(c);
      break;
    case "up":
      next = C.up(c).c;
      break;
    case "down":
      next = C.down(c).c;
      break;
    case "set":
      next = { text: op.text, cursor: op.text.length, shell: op.shell ?? c.shell };
      break;
    case "clear":
      next = C.emptyComposer;
      images = [];
      break;
  }
  const typed = next.text !== c.text || next.shell !== c.shell;
  return {
    ...state,
    composer: next,
    images,
    histAt: typed ? -1 : state.histAt,
    ac: typed ? completionFor(next) : state.ac,
  };
}

function history(state: AppState, dir: "prev" | "next"): AppState {
  const sid = state.sessionId;
  if (dir === "prev") {
    const q = sid ? session(state, sid).queue : [];
    if (state.histAt === -1 && state.composer.text === "" && q.length > 0 && sid) {
      const last = q[q.length - 1] as (typeof q)[number];
      const next = withSession(state, sid, (s) => ({ ...s, queue: s.queue.slice(0, -1) }));
      return {
        ...next,
        composer: { text: last.text, cursor: last.text.length, shell: last.kind === "shell" },
        images: last.images,
        ac: null,
      };
    }
    if (state.histAt + 1 < state.history.length) {
      const at = state.histAt + 1;
      const text = state.history[at] as string;
      return { ...state, histAt: at, composer: { text, cursor: text.length, shell: false }, ac: null };
    }
    return state;
  }
  if (state.histAt < 0) return state;
  const at = state.histAt - 1;
  const text = at >= 0 ? (state.history[at] as string) : "";
  return { ...state, histAt: at, composer: { ...state.composer, text, cursor: text.length }, ac: null };
}

function reduceUi(state: AppState, e: UiEvent): AppState {
  const sid = state.sessionId;
  switch (e.type) {
    case "viewport":
      return { ...state, cols: e.cols, rows: e.rows };
    case "go":
      if (e.view === "settings")
        return {
          ...state,
          view: "settings",
          back: state.view === "settings" ? state.back : (state.view as "home" | "session"),
          settings: { ...state.settings, sec: 0, row: null, edit: null },
          palette: { open: false, query: "", at: 0 },
        };
      return { ...state, view: e.view, palette: { open: false, query: "", at: 0 } };
    case "new_session":
      return {
        ...state,
        view: "home",
        sessionId: null,
        palette: { open: false, query: "", at: 0 },
        review: { ...state.review, open: false },
      };
    case "mode_cycle": {
      const i = MODES.indexOf(state.mode);
      return { ...state, mode: MODES[(i + (e.back ? MODES.length - 1 : 1)) % MODES.length] as UiMode };
    }
    case "mode_set":
      return { ...state, mode: e.mode };
    case "plan_ui": {
      const base = state.planUi.requestId === e.requestId ? state.planUi : initialPlanUi(e.requestId);
      if (Object.entries(e.patch).every(([k, v]) => base[k as keyof PlanUi] === v) && base === state.planUi)
        return state;
      return { ...state, planUi: { ...base, ...e.patch } };
    }
    case "palette_toggle":
      return { ...state, palette: { open: !state.palette.open, query: "", at: 0 } };
    case "palette_close":
      return { ...state, palette: { open: false, query: "", at: 0 } };
    case "palette_query":
      return { ...state, palette: { ...state.palette, query: e.q, at: 0 } };
    case "palette_move":
      return { ...state, palette: { ...state.palette, at: e.n ? (state.palette.at + e.d + e.n) % e.n : 0 } };
    case "model_open":
      return {
        ...state,
        model: { ...state.model, open: true, q: "", at: 0 },
        palette: { open: false, query: "", at: 0 },
      };
    case "model_close":
      return { ...state, model: { ...state.model, open: false } };
    case "model_query":
      return { ...state, model: { ...state.model, q: e.q, at: 0 } };
    case "model_move":
      return { ...state, model: { ...state.model, at: e.n ? (state.model.at + e.d + e.n) % e.n : 0 } };
    case "effort_set":
      return { ...state, effort: e.effort };
    case "details_toggle":
      return { ...state, details: !state.details, palette: { open: false, query: "", at: 0 } };
    case "review_open":
      return {
        ...state,
        view: "session",
        palette: { open: false, query: "", at: 0 },
        review: { ...state.review, open: true, committed: null },
      };
    case "review_close":
      return { ...state, review: { ...state.review, open: false } };
    case "review_file":
      return { ...state, review: { ...state.review, file: e.i, scroll: 0 } };
    case "review_scroll":
      return { ...state, review: { ...state.review, scroll: e.to } };
    case "pick_enter": {
      if (!sid) return state;
      const s = session(state, sid);
      const idx = pickable(s.blocks);
      return idx.length
        ? withSession(state, sid, (x) => ({ ...x, pickAt: idx[idx.length - 1] as number }))
        : state;
    }
    case "pick_exit":
      return sid ? withSession(state, sid, (s) => ({ ...s, pickAt: null })) : state;
    case "pick_move": {
      if (!sid) return state;
      return withSession(state, sid, (s) => {
        const idx = pickable(s.blocks);
        const at = s.pickAt === null ? -1 : idx.indexOf(s.pickAt);
        if (e.d < 0) return { ...s, pickAt: idx[Math.max(0, at - 1)] ?? null };
        return { ...s, pickAt: at + 1 < idx.length ? (idx[at + 1] as number) : null };
      });
    }
    case "outputs_toggle": {
      if (!sid) return state;
      return withSession(state, sid, (s) => {
        const at = s.pickAt;
        const b = at === null ? undefined : s.blocks[at];
        if (!b || b.kind !== "turn") return s;
        const all = b.steps.length > 0 && b.steps.every((st) => st.open);
        return withTurn(s, b.id, (t) => ({ ...t, steps: t.steps.map((st) => ({ ...st, open: !all })) }));
      });
    }
    case "thinking_toggle": {
      if (!sid) return state;
      return withSession(state, sid, (s) => {
        const b = s.pickAt === null ? undefined : s.blocks[s.pickAt];
        return b && b.kind === "turn" ? withTurn(s, b.id, (t) => ({ ...t, thoughtOpen: !t.thoughtOpen })) : s;
      });
    }
    case "copied":
      return { ...state, copied: e.key };
    case "scroll": {
      if (!sid) return state;
      return withSession(state, sid, (s) => ({
        ...s,
        scroll: Math.max(0, Math.min(s.scrollMax ?? Number.POSITIVE_INFINITY, s.scroll + e.d)),
      }));
    }
    case "scroll_max": {
      const s = state.bySession[e.sessionId];
      if (!s || s.scrollMax === e.n) return state;
      return withSession(state, e.sessionId, (x) => ({
        ...x,
        scrollMax: e.n,
        scroll: Math.min(x.scroll, e.n ?? x.scroll),
      }));
    }
    case "scroll_latest":
      return sid ? withSession(state, sid, (s) => ({ ...s, scroll: 0 })) : state;
    case "edit":
      return applyEdit(state, e.edit);
    case "ac_move": {
      if (!state.ac || e.n === 0) return state;
      const at = Math.min(state.ac.i, e.n - 1);
      return { ...state, ac: { ...state.ac, i: (at + e.d + e.n) % e.n } };
    }
    case "ac_close":
      return { ...state, ac: null };
    case "ac_accept":
      return state.ac
        ? { ...state, composer: insertCompletion(state.composer, state.ac, e.text), ac: null }
        : state;
    case "history":
      return history(state, e.dir);
    case "image_added":
      return { ...state, images: [...state.images, e.chip] };
    case "settings_move": {
      const { sec, row } = state.settings;
      const n = row === null ? SETTINGS.length : rowsOf(state.settings.config, sec).length;
      if (n === 0) return state;
      const at = ((row === null ? sec : row) + e.d + n) % n;
      return {
        ...state,
        settings: row === null ? { ...state.settings, sec: at } : { ...state.settings, row: at },
      };
    }
    case "settings_in":
      return state.settings.row === null && rowsOf(state.settings.config, state.settings.sec).length > 0
        ? { ...state, settings: { ...state.settings, row: 0 } }
        : state;
    case "settings_out":
      return state.settings.row !== null
        ? { ...state, settings: { ...state.settings, row: null } }
        : { ...state, view: state.back };
    case "settings_value":
      return {
        ...state,
        ...(e.path === "theme" && (e.value === "agency" || e.value === "night" || e.value === "light")
          ? { theme: e.value }
          : {}),
        ...(e.path === "effort" && EFFORTS.includes(e.value as Effort) ? { effort: e.value as Effort } : {}),
        settings: { ...state.settings, config: setPath(state.settings.config, e.path, e.value) },
      };
    case "settings_edit":
      return { ...state, settings: { ...state.settings, edit: e.text } };
    case "flash":
      return { ...state, flash: { text: e.text, tone: e.tone } };
    case "flash_clear":
      return { ...state, flash: null };
    case "esc":
      return { ...state, lastEsc: e.at };
    case "interrupt":
      return { ...state, lastInterrupt: e.at };
    case "composer_sent":
      return { ...state, composer: C.emptyComposer, images: [], ac: null, histAt: -1 };
  }
}

const DAEMON_TYPES = new Set<string>([
  "conn",
  "sessions_loaded",
  "week_cost_loaded",
  "live_turns",
  "session_live",
  "compaction_seen",
  "session_loading",
  "session_loaded",
  "status_loaded",
  "todos_loaded",
  "files_loaded",
  "slash_loaded",
  "history_loaded",
  "models_loaded",
  "git_loaded",
  "config_loaded",
  "turn_started",
  "turn_event",
  "turn_finished",
  "turn_stopped",
  "approval_answered",
  "prompt_queued",
  "queue_shifted",
  "shell_started",
  "shell_finished",
  "session_opened",
  "model_applied",
  "notice",
  "committed",
  "suggestion_used",
]);

/** The one state transition: a pure function of the state and one event. */
export function reduce(state: AppState, event: Event): AppState {
  return DAEMON_TYPES.has(event.type)
    ? reduceDaemon(state, event as DaemonEvent)
    : reduceUi(state, event as UiEvent);
}
