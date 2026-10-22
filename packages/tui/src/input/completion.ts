import { type Composer, setText } from "./composer.ts";

/** The completion a draft asks for: `@` at a word start lists files, `/` at the start lists commands. */
export interface Completion {
  kind: "@" | "/";
  q: string;
  i: number;
}

/** Port of the canvas `acOf`; `v` is the text before the caret. */
export function acOf(v: string): Completion | null {
  const at = /(^|\s)@([^\s@]*)$/.exec(v);
  if (at) return { kind: "@", q: at[2] ?? "", i: 0 };
  const sl = /^\/(\S*)$/.exec(v);
  return sl ? { kind: "/", q: sl[1] ?? "", i: 0 } : null;
}

/** The completion the composer's caret is in, or null in shell mode and for a caret mid-command. */
export function completionFor(c: Composer): Completion | null {
  if (c.shell) return null;
  return acOf(c.text.slice(0, c.cursor));
}

export interface SlashEntry {
  name: string;
  desc: string;
  /** "command", "skill" or "" for a built-in. */
  meta: string;
  /** Client-side action: the TUI runs it itself instead of sending the text. */
  act?: "home" | "model" | "review" | "settings" | "focus" | "details" | "mode" | "turns";
}

export interface CompletionItem {
  /** What goes into the prompt, with its `@` or `/`. */
  text: string;
  label: string;
  desc: string;
  meta: string;
}

export interface CompletionSources {
  files: readonly string[];
  slash: readonly SlashEntry[];
}

export const MAX_COMPLETIONS = 8;

/** Commands the TUI runs itself; the daemon's commands_list and skills_list add the rest. */
export const CLIENT_SLASH: readonly SlashEntry[] = [
  { name: "compact", desc: "Summarize the conversation to free up context", meta: "" },
  { name: "clear", desc: "Start a new session in this project", meta: "", act: "home" },
  { name: "init", desc: "Create the instruction files of this project", meta: "" },
  { name: "model", desc: "Change the model", meta: "", act: "model" },
  { name: "review", desc: "Open the changes for review", meta: "", act: "review" },
  { name: "settings", desc: "Open settings", meta: "", act: "settings" },
  { name: "undo", desc: "Undo the last turn", meta: "" },
];

const base = (f: string): string => f.slice(f.lastIndexOf("/") + 1);

export function completionItems(ac: Completion | null, src: CompletionSources): CompletionItem[] {
  if (!ac) return [];
  const q = ac.q.toLowerCase();
  if (ac.kind === "@") {
    const hits = src.files.filter((f) => f.toLowerCase().includes(q));
    // File name before directory: `@rep` finds report.py ahead of a path that merely contains "rep".
    const ranked = hits
      .map((f, n) => ({
        f,
        n,
        r: base(f).toLowerCase().startsWith(q) ? 0 : base(f).toLowerCase().includes(q) ? 1 : 2,
      }))
      .sort((a, b) => a.r - b.r || a.n - b.n)
      .slice(0, MAX_COMPLETIONS);
    return ranked.map(({ f }) => ({
      text: `@${f}`,
      label: base(f),
      desc: f.split("/").slice(0, -1).join("/"),
      meta: "",
    }));
  }
  return src.slash
    .filter((x) => x.name.includes(q))
    .map((x, n) => ({ x, n }))
    .sort((a, b) => Number(!a.x.name.startsWith(q)) - Number(!b.x.name.startsWith(q)) || a.n - b.n)
    .slice(0, MAX_COMPLETIONS)
    .map(({ x }) => ({ text: `/${x.name}`, label: `/${x.name}`, desc: x.desc, meta: x.meta }));
}

/** Tab or enter on a pick: the token under the caret becomes the item plus a space. */
export function insertCompletion(c: Composer, ac: Completion, text: string): Composer {
  const before = c.text.slice(0, c.cursor);
  const after = c.text.slice(c.cursor);
  if (ac.kind === "@") {
    const head = before.replace(/@[^\s@]*$/, `${text} `);
    return setText(c, head + after, head.length);
  }
  return setText(c, `${text} ${after}`, text.length + 1);
}
