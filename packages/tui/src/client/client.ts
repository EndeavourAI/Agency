/**
 * Runs the controller's effects over one RPC connection, turns what the daemon sends into reducer events
 * and resyncs after a reconnect. It owns no UI state: the daemon keeps every session.
 */
import type { DaemonClient } from "@agency/rpc";
import { drainQueue, type Effect, type Out } from "../controller/index.ts";
import { CLIENT_SLASH, type SlashEntry } from "../input/completion.ts";
import { type AppState, type Event, type ImageChip, type ModelRow, PERMISSION_OF } from "../state/index.ts";
import type {
  WireEvent,
  WireGitDiff,
  WireGitStatus,
  WireSessionRow,
  WireStatus,
  WireTodo,
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
    }>;
  }>;
  default: Record<string, string>;
  connected: string[];
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
        })),
    );
}

export function createTuiClient(deps: TuiClientDeps): TuiClient {
  const { daemon, dispatch, getState, now, newId } = deps;
  /** Turns whose connection broke mid-call: decided on reconnect, not on the error. */
  const lost = new Map<string, { sessionId: string; off: () => void }>();

  const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    daemon.call(method, params) as Promise<T>;
  const flash = (text: string): void => dispatch([{ type: "flash", text, tone: "error" }]);

  async function loadSessions(): Promise<void> {
    const r = await call<{ sessions: WireSessionRow[] }>("session_list");
    // Newest first, as the palette lists them.
    const rows = [...r.sessions].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    dispatch([{ type: "sessions_loaded", rows }]);
  }

  async function loadLive(): Promise<string[]> {
    const r = await call<{ turns: Array<{ turnId: string; sessionId: string }> }>("turns_list");
    dispatch([{ type: "live_turns", sessionIds: [...new Set(r.turns.map((t) => t.sessionId))] }]);
    return r.turns.map((t) => t.turnId);
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
    dispatch([{ type: "models_loaded", models: modelRows(p), connected: p.connected, defaultModel: dm }]);
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
    const [status, todos] = await Promise.all([
      call<{ status: WireStatus; line?: string | null }>("status_get", { sessionId }).catch(() => undefined),
      call<{ todos: WireTodo[] }>("todo_read", { sessionId }).catch(() => undefined),
    ]);
    const events: Event[] = [];
    if (status)
      events.push({ type: "status_loaded", sessionId, status: status.status, line: status.line ?? null });
    if (todos) events.push({ type: "todos_loaded", sessionId, todos: todos.todos });
    dispatch(events);
  }

  async function openSession(sessionId: string): Promise<void> {
    dispatch([{ type: "session_loading", sessionId }]);
    try {
      const view = await call<{ entries: never[]; tipId: string }>("session_show", { sessionId });
      dispatch([{ type: "session_loaded", sessionId, entries: view.entries, tipId: view.tipId }]);
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
    await Promise.all([
      loadStatus(sessionId),
      loadSessions().catch(() => undefined),
      loadLive().catch(() => []),
    ]);
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
    const off = daemon.on(`turn.${e.turnId}`, (payload) => {
      dispatch([
        {
          type: "turn_event",
          sessionId: e.sessionId,
          turnId: e.turnId,
          event: payload as WireEvent,
          at: now(),
        },
      ]);
    });
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
          },
        },
      ]);
      await afterTurn(e.sessionId);
    } catch (err) {
      if (LOST.test(message(err))) {
        // The turn goes on in the daemon without us: keep the subscription for the reconnect.
        lost.set(e.turnId, { sessionId: e.sessionId, off });
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
        effort: state.effort,
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
                const r = await call<{ output: string; isError: boolean }>("shell_run", {
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
                call<WireGitStatus>("git_status"),
                call<WireGitDiff>("git_diff"),
              ]);
              dispatch([{ type: "git_loaded", git, diff }]);
              return;
            }
            case "load_settings":
              return await loadConfig();
            case "commit":
              // The daemon has no commit method yet (gap in the stage 1 report); say so instead of pretending.
              flash("commit is not available yet: the daemon has no git_commit method");
              return;
            case "copy":
              await deps.host.copy(e.text);
              return;
            case "paste_image": {
              const chip = await deps.host.readClipboardImage();
              if (chip) dispatch([{ type: "image_added", chip }]);
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

  /** Waits out a turn that kept running while we were away, then settles it from the session file. */
  async function watch(turnId: string, sessionId: string, off: () => void): Promise<void> {
    for (;;) {
      await new Promise((r) => setTimeout(r, 300));
      let live: string[];
      try {
        live = await loadLive();
      } catch {
        return; // gone again: the next reconnect resyncs
      }
      if (!live.includes(turnId)) break;
    }
    off();
    daemon.unsubscribe(`turn.${turnId}`);
    dispatch([{ type: "turn_finished", sessionId, turnId, at: now(), outcome: {} }]);
    await afterTurn(sessionId);
    if (getState().sessionId === sessionId) await openSession(sessionId);
  }

  async function resync(): Promise<void> {
    const live = await loadLive().catch(() => [] as string[]);
    for (const [turnId, rec] of [...lost]) {
      lost.delete(turnId);
      if (live.includes(turnId)) {
        void watch(turnId, rec.sessionId, rec.off);
        continue;
      }
      rec.off();
      daemon.unsubscribe(`turn.${turnId}`);
      dispatch([
        { type: "turn_finished", sessionId: rec.sessionId, turnId, at: now(), outcome: { cancelled: true } },
      ]);
    }
    const sid = getState().sessionId;
    // A turn that still runs keeps its block: the reload keeps running turns and adds what the file holds.
    await Promise.all([loadSessions().catch(() => undefined), sid ? openSession(sid) : Promise.resolve()]);
  }

  return {
    async bootstrap() {
      dispatch([{ type: "conn", status: "online" }]);
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
