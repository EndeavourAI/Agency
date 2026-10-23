/**
 * Runs the controller's effects over one RPC connection, turns what the daemon sends into reducer events
 * and resyncs after a reconnect. It owns no UI state: the daemon keeps every session.
 */
import type { DaemonClient } from "@agency/rpc";
import { drainQueue, type Effect, type Out } from "../controller/index.ts";
import { CLIENT_SLASH, type SlashEntry } from "../input/completion.ts";
import {
  type AppState,
  EFFORTS,
  type Event,
  effortOf,
  type ImageChip,
  type ModelRow,
  PERMISSION_OF,
} from "../state/index.ts";
import type {
  WireEvent,
  WireGitDiff,
  WireGitStatus,
  WireSessionRow,
  WireStatus,
  WireTodo,
  WireTurnEnd,
} from "../state/wire.ts";

export interface TuiClientDeps {
  daemon: DaemonClient;
  /** Feeds events to the store. */
  dispatch: (events: Event[]) => void;
  getState: () => AppState;
  now: () => number;
  newId: () => string;
  /** Terminal-side actions the client cannot do itself. */
  host: {
    copy: (text: string) => Promise<void>;
    readClipboardImage: () => Promise<ImageChip | null>;
    quit: () => void;
  };
}

export interface TuiClient {
  /** Loads everything the first screen needs. */
  bootstrap(): Promise<void>;
  /** Runs effects; events they produce go to the store. */
  run(effects: readonly Effect[]): Promise<void>;
  /** Wire this to `connectToDaemon`'s `onConnection` option. */
  onConnection(online: boolean): void;
  openSession(sessionId: string): Promise<void>;
}

interface ProvidersResult {
  all: Array<{
    id: string;
    name: string;
    models: Array<{
      id: string;
      name: string;
      contextWindow: number;
      pricing: { inputPerMTok: number; outputPerMTok: number };
      status?: string;
      effortLevels?: string[];
    }>;
  }>;
  default: Record<string, string>;
  connected: string[];
  keySource?: Record<string, string>;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const LOST = /connection to daemon closed|client is closed/;

/** `provider/model` as the picker holds it, back to the two fields the daemon takes. */
function splitRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf("/");
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

export function modelRows(p: ProvidersResult): ModelRow[] {
  return p.all
    .filter((prov) => p.connected.includes(prov.id))
    .flatMap((prov) =>
      prov.models
        .filter((m) => m.status !== "deprecated")
        .map<ModelRow>((m) => ({
          ref: `${prov.id}/${m.id}`,
          provider: prov.id,
          providerName: prov.name,
          id: m.id,
          name: m.name,
          contextWindow: m.contextWindow,
          inPerMTok: m.pricing.inputPerMTok,
          outPerMTok: m.pricing.outputPerMTok,
          tags: m.pricing.inputPerMTok === 0 && m.pricing.outputPerMTok === 0 ? "free" : "",
          efforts: m.effortLevels ? EFFORTS.filter((l) => m.effortLevels?.includes(l)) : EFFORTS,
        })),
    );
}

export function createTuiClient(deps: TuiClientDeps): TuiClient {
  const { daemon, dispatch, getState, now, newId } = deps;
  /** Turns whose connection broke mid-call: decided on reconnect, not on the error. */
  const lost = new Map<string, { sessionId: string; off: () => void; ended: Promise<void> }>();

  const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    daemon.call(method, params) as Promise<T>;
  const flash = (text: string): void => dispatch([{ type: "flash", text, tone: "error" }]);
  /** A listener runs outside any caller that could catch: one malformed event must flash, not take the TUI down. */
  const guarded =
    (handler: (payload: unknown) => void) =>
    (payload: unknown): void => {
      try {
        handler(payload);
      } catch (err) {
        flash(`bad event from the daemon: ${message(err)}`);
      }
    };

  async function loadSessions(): Promise<void> {
    const r = await call<{ sessions: WireSessionRow[] }>("session_list");
    // Newest first, as the palette lists them.
    const rows = [...r.sessions].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    dispatch([{ type: "sessions_loaded", rows }]);
    const since = new Date(now() - 7 * 86_400_000).toISOString();
    const spent = await call<{ since?: { costUsd: number } }>("cost_report", { since }).catch(
      () => undefined,
    );
    if (spent?.since) dispatch([{ type: "week_cost_loaded", costUsd: spent.since.costUsd }]);
  }

  interface LiveTurn {
    turnId: string;
    sessionId: string;
    approvals: Array<{
      requestId: string;
      tool: string;
      title: string;
      command?: string;
      path?: string;
      riskTier: string;
      argsSummary: string;
    }>;
  }

  /** The turns that run now. The `sessions` channel keeps this current afterwards, so only a start or a reconnect asks. */
  async function loadLive(): Promise<LiveTurn[]> {
    const r = await call<{ turns: LiveTurn[] }>("turns_list");
    dispatch([{ type: "live_turns", sessionIds: [...new Set(r.turns.map((t) => t.sessionId))] }]);
    return r.turns;
  }

  async function loadSlash(): Promise<void> {
    const [cmds, skills] = await Promise.all([
      call<{ commands: Array<{ name: string; description?: string }> }>("commands_list").catch(() => ({
        commands: [],
      })),
      call<{ skills: Array<{ name: string; description?: string }> }>("skills_list").catch(() => ({
        skills: [],
      })),
    ]);
    const seen = new Set(CLIENT_SLASH.map((c) => c.name));
    const extra: SlashEntry[] = [
      ...cmds.commands.map((c) => ({ name: c.name, desc: c.description ?? "", meta: "command" })),
      ...skills.skills.map((s) => ({ name: s.name, desc: s.description ?? "", meta: "skill" })),
    ].filter((c) => !seen.has(c.name) && seen.add(c.name));
    dispatch([{ type: "slash_loaded", slash: [...CLIENT_SLASH, ...extra] }]);
  }

  async function loadModels(): Promise<void> {
    const p = await call<ProvidersResult>("providers_list", { models: "connected" });
    const first = p.connected[0];
    const dm = first && p.default[first] ? `${first}/${p.default[first]}` : null;
    dispatch([
      {
        type: "models_loaded",
        models: modelRows(p),
        connected: p.connected,
        ...(p.keySource ? { keySource: p.keySource } : {}),
        defaultModel: dm,
      },
    ]);
  }

  async function loadConfig(): Promise<void> {
    const [user, client] = await Promise.all([
      call<{ config?: Record<string, unknown> }>("config_user").catch(() => ({ config: {} })),
      call<{ config: { theme?: string } }>("client_config").catch(() => ({
        config: {} as { theme?: string },
      })),
    ]);
    const theme = client.config.theme;
    dispatch([
      {
        type: "config_loaded",
        config: user.config ?? {},
        ...(theme === "agency" || theme === "night" || theme === "light" ? { theme } : {}),
      },
    ]);
  }

  async function loadStatus(sessionId: string): Promise<void> {
    const [status, todos, git] = await Promise.all([
      call<{ status: WireStatus; line?: string | null }>("status_get", { sessionId }).catch(() => undefined),
      call<{ todos: WireTodo[] }>("todo_read", { sessionId }).catch(() => undefined),
      // The changes of the details pane; the review screen loads the diff itself.
      call<WireGitStatus>("git_status").catch(() => undefined),
    ]);
    const events: Event[] = [];
    if (git) events.push({ type: "git_loaded", git });
    if (status)
      events.push({ type: "status_loaded", sessionId, status: status.status, line: status.line ?? null });
    if (todos) events.push({ type: "todos_loaded", sessionId, todos: todos.todos });
    dispatch(events);
  }

  async function openSession(sessionId: string, resumed?: string[]): Promise<void> {
    dispatch([{ type: "session_loading", sessionId }]);
    try {
      const view = await call<{ entries: never[]; tipId: string }>("session_show", { sessionId });
      dispatch([
        {
          type: "session_loaded",
          sessionId,
          entries: view.entries,
          tipId: view.tipId,
          ...(resumed ? { resumed } : {}),
        },
      ]);
    } catch (e) {
      // A session with no file yet (just created here) is empty, not broken.
      dispatch([{ type: "session_loaded", sessionId, entries: [], tipId: null }]);
      if (!/unknown session/.test(message(e))) flash(`could not load the session: ${message(e)}`);
    }
    await loadStatus(sessionId);
  }

  function runOut(out: Out): void {
    dispatch(out.events);
    void run(out.effects);
  }

  /** After a turn: refresh what it changed, then send the next queued prompt if the turn ended by itself. */
  async function afterTurn(sessionId: string): Promise<void> {
    await Promise.all([loadStatus(sessionId), loadSessions().catch(() => undefined)]);
    if (getState().sessionId === sessionId) runOut(drainQueue(getState(), { now: now(), newId }));
  }

  async function sendTurn(e: Extract<Effect, { type: "send_turn" }>): Promise<void> {
    const state = getState();
    const ref = e.model ?? state.defaultModel;
    if (!ref) {
      dispatch([
        {
          type: "turn_finished",
          sessionId: e.sessionId,
          turnId: e.turnId,
          at: now(),
          outcome: {
            error: { code: "no_model", message: "no provider is connected: run agency auth login" },
          },
        },
      ]);
      return;
    }
    // A bare model id (an old session file) borrows the provider of the default choice.
    const { provider, model } = ref.includes("/")
      ? splitRef(ref)
      : { provider: splitRef(state.defaultModel ?? "").provider, model: ref };
    const row = state.models.find((m) => m.ref === ref);
    daemon.subscribe(`turn.${e.turnId}`);
    let ended: () => void = () => {};
    const endedP = new Promise<void>((r) => {
      ended = r;
    });
    const off = daemon.on(
      `turn.${e.turnId}`,
      guarded((payload) => {
        if ((payload as WireEvent).type === "turn_end") ended();
        dispatch([
          {
            type: "turn_event",
            sessionId: e.sessionId,
            turnId: e.turnId,
            event: payload as WireEvent,
            at: now(),
          },
        ]);
      }),
    );
    let keepListening = false;
    try {
      if (e.create) await call("session_create", { sessionId: e.sessionId });
      const r = await daemon.call("session_send", {
        turnId: e.turnId,
        sessionId: e.sessionId,
        provider,
        model,
        userText: e.text,
        thinkingLevel: e.effort,
        permissionMode: PERMISSION_OF[e.mode],
        ...(row ? { contextWindow: row.contextWindow } : {}),
        ...(e.images.length
          ? { images: e.images.map((i) => ({ type: "image", mimeType: i.mimeType, data: i.data })) }
          : {}),
      });
      const result = r as {
        stopReason?: string;
        cancelled?: boolean;
        error?: { code: string; message: string };
        end?: WireTurnEnd;
      };
      dispatch([
        {
          type: "turn_finished",
          sessionId: e.sessionId,
          turnId: e.turnId,
          at: now(),
          outcome: {
            ...(result.stopReason ? { stopReason: result.stopReason } : {}),
            ...(result.cancelled ? { cancelled: true } : {}),
            ...(result.error ? { error: result.error } : {}),
            ...(result.end ? { end: result.end } : {}),
          },
        },
      ]);
      await afterTurn(e.sessionId);
    } catch (err) {
      if (LOST.test(message(err))) {
        // The turn goes on in the daemon without us: keep the subscription for the reconnect.
        lost.set(e.turnId, { sessionId: e.sessionId, off, ended: endedP });
        keepListening = true;
        return;
      }
      const code = (err as { code?: string }).code ?? "error";
      dispatch([
        {
          type: "turn_finished",
          sessionId: e.sessionId,
          turnId: e.turnId,
          at: now(),
          outcome: { error: { code, message: message(err) } },
        },
      ]);
      await afterTurn(e.sessionId);
    } finally {
      if (!keepListening) {
        off();
        daemon.unsubscribe(`turn.${e.turnId}`);
      }
    }
  }

  async function slash(e: Extract<Effect, { type: "slash_command" }>): Promise<void> {
    const m = /^\/(\S+)\s*(.*)$/s.exec(e.text);
    if (!m) return;
    const name = m[1] as string;
    const args = (m[2] ?? "").trim();
    const state = getState();
    // A command template or a skill is prompt text: the daemon expands it inside the turn.
    if (state.slash.some((s) => s.name === name && (s.meta === "command" || s.meta === "skill"))) {
      const turnId = newId();
      dispatch([
        { type: "turn_started", sessionId: e.sessionId, turnId, prompt: e.text, images: [], at: now() },
      ]);
      await sendTurn({
        type: "send_turn",
        sessionId: e.sessionId,
        turnId,
        text: e.text,
        images: [],
        mode: state.mode,
        effort: effortOf(state, state.bySession[e.sessionId]?.model ?? state.defaultModel),
        model: state.bySession[e.sessionId]?.model ?? state.defaultModel,
        create: false,
      });
      return;
    }
    try {
      const r = await call<{ text?: string; kind?: string }>("command_run", {
        name,
        args: `${e.sessionId}${args ? ` ${args}` : ""}`,
      });
      if (r.text) dispatch([{ type: "notice", sessionId: e.sessionId, id: newId(), text: r.text }]);
      await loadStatus(e.sessionId);
    } catch (err) {
      flash(message(err));
    }
  }

  async function run(effects: readonly Effect[]): Promise<void> {
    await Promise.all(
      effects.map(async (e) => {
        try {
          switch (e.type) {
            case "send_turn":
              return await sendTurn(e);
            case "slash_command":
              return await slash(e);
            case "cancel_turn":
              await call("cancel_turn", { turnId: e.turnId });
              return;
            case "respond":
              await call("approval_respond", {
                requestId: e.requestId,
                decision: e.decision,
                sessionId: e.sessionId,
              });
              return;
            case "shell_run": {
              try {
                const r = await call<{ output: string; isError: boolean; exitCode?: number }>("shell_run", {
                  sessionId: e.sessionId,
                  command: e.command,
                  turnId: e.id,
                });
                dispatch([
                  {
                    type: "shell_finished",
                    sessionId: e.sessionId,
                    id: e.id,
                    output: r.output,
                    isError: r.isError,
                    ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
                  },
                ]);
              } catch (err) {
                dispatch([
                  {
                    type: "shell_finished",
                    sessionId: e.sessionId,
                    id: e.id,
                    output: message(err),
                    isError: true,
                  },
                ]);
              }
              return;
            }
            case "config_write":
              await call("config_write", { key: e.key, value: e.value });
              return;
            case "open_session":
              return await openSession(e.sessionId);
            case "load_review": {
              const [git, diff] = await Promise.all([
                call<WireGitStatus>("git_status", e.sessionId ? { sessionId: e.sessionId } : {}),
                call<WireGitDiff>("git_diff"),
              ]);
              dispatch([{ type: "git_loaded", git, diff }]);
              return;
            }
            case "load_settings":
              return await loadConfig();
            case "commit": {
              const r = await call<{ branch: string; upstream?: string }>("git_commit", {
                sessionId: e.sessionId,
                message: e.message,
                ...(e.push ? { push: true } : {}),
              });
              dispatch([
                {
                  type: "committed",
                  pushed: e.push,
                  branch: r.branch,
                  ...(r.upstream ? { upstream: r.upstream } : {}),
                },
              ]);
              // What is left to review, and the git pane of the details.
              const [git, diff] = await Promise.all([
                call<WireGitStatus>("git_status", { sessionId: e.sessionId }),
                call<WireGitDiff>("git_diff"),
              ]);
              dispatch([{ type: "git_loaded", git, diff }]);
              return;
            }
            case "copy":
              await deps.host.copy(e.text);
              return;
            case "paste_image": {
              const chip = await deps.host.readClipboardImage();
              if (chip) dispatch([{ type: "image_added", chip }]);
              else dispatch([{ type: "flash", text: "no image on the clipboard", tone: "info" }]);
              return;
            }
            case "reconnect":
              await call("turns_list");
              dispatch([{ type: "conn", status: "online" }]);
              return;
            case "quit":
              deps.host.quit();
              return;
          }
        } catch (err) {
          flash(message(err));
        }
      }),
    );
  }

  /** Waits for the turn_end of a turn that kept running while we were away, then settles it from the session file. */
  async function watch(
    turnId: string,
    sessionId: string,
    off: () => void,
    ended: Promise<void>,
  ): Promise<void> {
    await ended;
    off();
    daemon.unsubscribe(`turn.${turnId}`);
    dispatch([{ type: "turn_finished", sessionId, turnId, at: now(), outcome: {} }]);
    await afterTurn(sessionId);
    if (getState().sessionId === sessionId) await openSession(sessionId);
  }

  async function resync(): Promise<void> {
    // A failed turns_list says nothing about the turns: they stay lost and the next reconnect decides.
    const live = await loadLive().catch(() => undefined);
    const rejoined = new Map<string, string[]>();
    for (const [turnId, rec] of live ? [...lost] : []) {
      lost.delete(turnId);
      if (live?.some((t) => t.turnId === turnId)) {
        rejoined.set(rec.sessionId, [...(rejoined.get(rec.sessionId) ?? []), turnId]);
        void watch(turnId, rec.sessionId, rec.off, rec.ended);
        continue;
      }
      rec.off();
      daemon.unsubscribe(`turn.${turnId}`);
      dispatch([
        { type: "turn_finished", sessionId: rec.sessionId, turnId, at: now(), outcome: { cancelled: true } },
      ]);
    }
    // An ask that the daemon still waits on and the screen lost (answered nowhere, shown nowhere) comes back.
    for (const t of live ?? [])
      for (const a of t.approvals) {
        const turn = getState().bySession[t.sessionId]?.blocks.find(
          (b) => b.kind === "turn" && b.id === t.turnId,
        );
        if (turn?.kind !== "turn" || turn.approval) continue;
        dispatch([
          {
            type: "turn_event",
            sessionId: t.sessionId,
            turnId: t.turnId,
            at: now(),
            event: {
              type: "approval_requested",
              requestId: a.requestId,
              sessionId: t.sessionId,
              turnId: t.turnId,
              riskTier: a.riskTier,
              source: "turns_list",
              argsSummary: a.argsSummary,
              request: {
                tool: a.tool,
                title: a.title,
                ...(a.command !== undefined ? { command: a.command } : {}),
                ...(a.path !== undefined ? { path: a.path } : {}),
              },
            },
          },
        ]);
      }
    const sid = getState().sessionId;
    // A turn that still runs keeps its block, and takes what the file holds beyond it: that fills what the outage dropped.
    await Promise.all([
      loadSessions().catch(() => undefined),
      ...[...new Set([...(sid ? [sid] : []), ...rejoined.keys()])].map((id) =>
        openSession(id, rejoined.get(id)),
      ),
    ]);
  }

  return {
    async bootstrap() {
      dispatch([{ type: "conn", status: "online" }]);
      daemon.on(
        "sessions",
        guarded((payload) => {
          const p = payload as {
            type: string;
            sessionId: string;
            phase?: "start" | "progress" | "end";
            tokens?: number;
          };
          if (p.type === "turn_start" || p.type === "turn_end")
            dispatch([{ type: "session_live", sessionId: p.sessionId, live: p.type === "turn_start" }]);
          if (p.type === "compaction" && p.phase)
            dispatch([
              {
                type: "compaction_seen",
                sessionId: p.sessionId,
                phase: p.phase,
                ...(p.tokens === undefined ? {} : { tokens: p.tokens }),
                at: now(),
              },
            ]);
        }),
      );
      daemon.subscribe("sessions");
      const history = call<{ prompts: Array<string | { text: string }> }>("history_list", { limit: 200 })
        .then((r) =>
          dispatch([
            { type: "history_loaded", prompts: r.prompts.map((p) => (typeof p === "string" ? p : p.text)) },
          ]),
        )
        .catch(() => undefined);
      const files = call<{ files: string[] }>("files_list")
        .then((r) => dispatch([{ type: "files_loaded", files: r.files }]))
        .catch(() => undefined);
      await Promise.all([
        loadSessions().catch((e) => flash(message(e))),
        loadLive().catch(() => undefined),
        loadSlash(),
        loadModels().catch(() => undefined),
        loadConfig(),
        history,
        files,
      ]);
    },
    run,
    onConnection(online) {
      dispatch([{ type: "conn", status: online ? "online" : "offline" }]);
      if (online) void resync();
    },
    openSession,
  };
}
