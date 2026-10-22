import type { SlashEntry } from "../input/completion.ts";

/**
 * Settings sections of the canvas, each row one dotted config key for `config_write`. A `dynamic` section also
 * lists machine data (provider keys, permission rules, MCP servers, hooks) from the daemon; the canvas samples it.
 */
export type SettingRow =
  | { label: string; kind: "choice"; key: string; opts: readonly string[]; note?: string }
  | { label: string; kind: "toggle"; key: string; note?: string }
  | { label: string; kind: "text"; key: string; note?: string }
  | { label: string; kind: "model"; key: string; note?: string }
  | { label: string; kind: "info"; key: string; note?: string };

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

/** The value a row shows: the config value, else the first option or the off state. */
export function rowValue(row: SettingRow, config: Record<string, unknown>): string | boolean {
  const v = getPath(config, row.key);
  if (row.kind === "toggle") return v === true;
  if (v === undefined || v === null) return row.kind === "choice" ? (row.opts[0] ?? "") : "";
  return String(v);
}

const NUMBERS = new Set(["budgets.dailyUsd", "budgets.monthlyUsd", "compactionLimit"]);

/** What a typed value writes: numbers for the caps and the compaction limit, null (removes the key) when empty. */
export function parseText(key: string, text: string): string | number | null | Error {
  const t = text.trim();
  if (t === "") return null;
  if (!NUMBERS.has(key)) return t;
  const n = Number(t.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : new Error(`${t} is not a number`);
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
