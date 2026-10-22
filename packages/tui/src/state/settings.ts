import type { SlashEntry } from "../input/completion.ts";

/** What one change writes: the dotted config key and its new value. */
export type RowWrite = (value: unknown) => { key: string; value: unknown };

interface RowBase {
  label: string;
  key: string;
  note?: string;
  /** A row built from the config (a rule, a server, a hook): its own value, and how a change is written back. */
  value?: string | boolean;
  write?: RowWrite;
}

/**
 * Settings sections of the canvas, each row one dotted config key for `config_write`. A `dynamic` section also
 * lists rows built from the user config (permission rules, MCP servers, hooks) and from the daemon (provider keys).
 */
export type SettingRow =
  | (RowBase & { kind: "choice"; opts: readonly string[] })
  | (RowBase & { kind: "toggle" })
  | (RowBase & { kind: "text" })
  | (RowBase & { kind: "model" })
  | (RowBase & { kind: "info" });

export interface SettingSection {
  name: string;
  rows: readonly SettingRow[];
  /** Rows that the daemon supplies at runtime (providers, permissions, mcp, hooks). */
  dynamic?: "providers" | "permissions" | "mcp" | "hooks";
}

export const SETTINGS: readonly SettingSection[] = [
  {
    name: "General",
    rows: [
      { label: "Theme", kind: "choice", key: "theme", opts: ["agency", "night", "light"] },
      { label: "Log level", kind: "choice", key: "logLevel", opts: ["info", "debug", "warn", "error"] },
      { label: "Usage metrics", kind: "toggle", key: "telemetryEnabled", note: "Nothing is sent while off." },
      { label: "Crash reports", kind: "toggle", key: "crashReportsEnabled" },
    ],
  },
  {
    name: "Models",
    dynamic: "providers",
    rows: [
      { label: "Default model", kind: "model", key: "model" },
      {
        label: "Small model",
        kind: "text",
        key: "small_model",
        note: "Titles, summaries and other background work.",
      },
      { label: "Effort", kind: "choice", key: "effort", opts: ["low", "medium", "high", "xhigh"] },
    ],
  },
  {
    name: "Permissions",
    dynamic: "permissions",
    rows: [
      {
        label: "Workspace trust",
        kind: "toggle",
        key: "trust.required",
        note: "Project config loads only in trusted folders.",
      },
    ],
  },
  {
    name: "Environments",
    rows: [
      { label: "Sandbox", kind: "choice", key: "sandbox.backend", opts: ["software", "docker", "os"] },
      { label: "Network access", kind: "toggle", key: "sandbox.allowNetwork" },
    ],
  },
  {
    name: "Context",
    rows: [
      { label: "Memory", kind: "toggle", key: "memory" },
      { label: "Compact at (tokens)", kind: "text", key: "compactionLimit" },
      { label: "Prompt suggestions", kind: "toggle", key: "promptSuggestions" },
    ],
  },
  {
    name: "Tools and MCP",
    dynamic: "mcp",
    rows: [{ label: "Code mode", kind: "toggle", key: "codeMode" }],
  },
  {
    name: "Hooks",
    dynamic: "hooks",
    rows: [
      {
        label: "Status line",
        kind: "text",
        key: "statusLine.command",
        note: "Its output shows in the hint row.",
      },
    ],
  },
  {
    name: "Agents and budgets",
    rows: [
      { label: "Daily cap (USD)", kind: "text", key: "budgets.dailyUsd" },
      { label: "Monthly cap (USD)", kind: "text", key: "budgets.monthlyUsd" },
    ],
  },
];

/** Reads a dotted path out of nested config JSON. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Sets a dotted path in a copy of the config; `undefined` removes it. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split(".");
  if (head === undefined) return obj;
  if (rest.length === 0) {
    const { [head]: _gone, ...others } = obj;
    return value === undefined ? others : { ...others, [head]: value };
  }
  const child = obj[head];
  const base = typeof child === "object" && child !== null ? (child as Record<string, unknown>) : {};
  return { ...obj, [head]: setPath(base, rest.join("."), value) };
}

/** The value a row shows: its own, else the config value, else the first option or the off state. */
export function rowValue(row: SettingRow, config: Record<string, unknown>): string | boolean {
  if (row.value !== undefined) return row.value;
  const v = getPath(config, row.key);
  if (row.kind === "toggle") return v === true;
  if (v === undefined || v === null) return row.kind === "choice" ? (row.opts[0] ?? "") : "";
  return String(v);
}

const DECISIONS = ["ask", "allow", "deny"] as const;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const title = (tool: string): string => tool.charAt(0).toUpperCase() + tool.slice(1).replace(/_/g, " ");

/** One row for each permission rule of the user config: a bare decision, or a pattern of a tool. */
function permissionRows(config: Record<string, unknown>): SettingRow[] {
  const rows: SettingRow[] = [];
  const perms = getPath(config, "permissions");
  if (!isRecord(perms)) return rows;
  for (const [tool, rule] of Object.entries(perms)) {
    // A dotted key cannot name a tool with a dot in it.
    if (tool.includes(".")) continue;
    const key = `permissions.${tool}`;
    if (typeof rule === "string" && (DECISIONS as readonly string[]).includes(rule)) {
      rows.push({
        label: title(tool),
        kind: "choice",
        key,
        opts: DECISIONS,
        value: rule,
        write: (value) => ({ key, value }),
      });
    } else if (isRecord(rule)) {
      for (const [pattern, decision] of Object.entries(rule)) {
        if (typeof decision !== "string" || !(DECISIONS as readonly string[]).includes(decision)) continue;
        // The whole map goes back: a pattern such as ".agency/**" has dots that a key cannot hold.
        rows.push({
          label: `${title(tool)} ${pattern}`,
          kind: "choice",
          key,
          opts: DECISIONS,
          value: decision,
          write: (value) => ({ key, value: { ...rule, [pattern]: value } }),
        });
      }
    }
  }
  return rows;
}

/** One toggle for each MCP server of the user config; off writes `enabled: false`, on drops it. */
function mcpRows(config: Record<string, unknown>): SettingRow[] {
  const servers = getPath(config, "mcpServers");
  if (!isRecord(servers)) return [];
  return Object.entries(servers).map(([name, raw]) => {
    const server = isRecord(raw) ? raw : {};
    return {
      label: name,
      kind: "toggle" as const,
      key: "mcpServers",
      note: `${typeof server.url === "string" ? "http" : "stdio"} · applies when the daemon restarts`,
      value: server.enabled !== false,
      write: (on: unknown) => {
        const { enabled: _was, ...rest } = server;
        return {
          key: "mcpServers",
          value: { ...servers, [name]: on === true ? rest : { ...rest, enabled: false } },
        };
      },
    };
  });
}

/** What a hook of the user config does, in a line. */
function hookText(hook: Record<string, unknown>): string {
  if (typeof hook.command === "string") return hook.command;
  if (typeof hook.url === "string") return `POST ${hook.url}`;
  if (typeof hook.server === "string") return `${hook.server} ${String(hook.tool ?? "")}`.trim();
  return String(hook.type ?? "hook");
}

/** The hooks of the user config, read-only: change them in the file. */
function hookRows(config: Record<string, unknown>): SettingRow[] {
  const hooks = getPath(config, "hooks");
  if (!isRecord(hooks)) return [];
  const rows: SettingRow[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      const matcher = typeof group.matcher === "string" && group.matcher !== "*" ? group.matcher : "";
      for (const hook of group.hooks)
        if (isRecord(hook))
          rows.push({
            label: matcher ? `${event} ${matcher}` : event,
            kind: "info",
            key: `hooks.${event}`,
            value: hookText(hook),
          });
    }
  }
  return rows;
}

/** The rows of a section: the fixed ones, then those that the user config adds. */
export function rowsOf(config: Record<string, unknown>, sec: number): readonly SettingRow[] {
  const s = SETTINGS[sec];
  if (!s) return [];
  const extra =
    s.dynamic === "permissions"
      ? permissionRows(config)
      : s.dynamic === "mcp"
        ? mcpRows(config)
        : s.dynamic === "hooks"
          ? hookRows(config)
          : [];
  return extra.length ? [...s.rows, ...extra] : s.rows;
}

const NUMBERS = new Set(["budgets.dailyUsd", "budgets.monthlyUsd", "compactionLimit"]);

/**
 * What a typed value writes, or why it cannot be: the caps are amounts (the daily one no higher than the monthly one),
 * the compaction limit a whole number of tokens, the small model `provider/model`, the status line one line of command.
 * Empty removes the key.
 */
export function parseText(
  key: string,
  text: string,
  config: Record<string, unknown> = {},
): string | number | null | Error {
  const t = text.trim();
  if (t === "") return null;
  if (key === "small_model") return /^[^/\s]+\/\S+$/.test(t) ? t : new Error(`${t} is not provider/model`);
  if (key === "statusLine.command")
    return [...t].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
      ? new Error("the command must be one line")
      : t;
  if (!NUMBERS.has(key)) return t;
  const n = Number(t.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) return new Error(`${t} is not an amount`);
  if (key === "compactionLimit")
    return Number.isInteger(n) && n > 0 ? n : new Error(`${t} is not a whole number of tokens`);
  const other = getPath(config, key === "budgets.dailyUsd" ? "budgets.monthlyUsd" : "budgets.dailyUsd");
  if (typeof other === "number") {
    if (key === "budgets.dailyUsd" && n > other)
      return new Error(`the daily cap is above the monthly cap ($${other})`);
    if (key === "budgets.monthlyUsd" && n < other)
      return new Error(`the monthly cap is below the daily cap ($${other})`);
  }
  return n;
}

/** The value one press of space or enter writes: toggles flip, choices step to the next option. */
export function nextValue(row: SettingRow, v: string | boolean): unknown {
  if (row.kind === "toggle") return !v;
  if (row.kind === "choice") return row.opts[(row.opts.indexOf(String(v)) + 1) % row.opts.length];
  return undefined;
}

/** Commands of the palette (ctrl+p), after the canvas COMMANDS. */
export interface PaletteCommand {
  name: string;
  hint: string;
  key: string;
  act: NonNullable<SlashEntry["act"]>;
}

export const COMMANDS: readonly PaletteCommand[] = [
  { name: "/model", hint: "Choose a model and effort", key: "", act: "model" },
  { name: "/review", hint: "Review and commit changes", key: "ctrl+r", act: "review" },
  { name: "/focus", hint: "Hide the details panel", key: "", act: "focus" },
  { name: "/new", hint: "Start a new session", key: "ctrl+n", act: "home" },
  { name: "/details", hint: "Show or hide session details", key: "ctrl+d", act: "details" },
  { name: "/mode", hint: "Switch between build, plan and auto", key: "tab", act: "mode" },
  { name: "/turns", hint: "Pick a turn to copy it or open its reasoning", key: "↑", act: "turns" },
  { name: "/settings", hint: "Open settings", key: "ctrl+,", act: "settings" },
];
