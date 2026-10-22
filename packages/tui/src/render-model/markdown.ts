/**
 * Streaming markdown for answers: paragraphs, fenced code, `- ` lists and `inline code`, as the canvas `md`.
 * Settled blocks never change again; one open block (the unfinished line or an unclosed fence) is still growing.
 */
export interface InlinePart {
  t: string;
  code: boolean;
}

export type MdBlock =
  | { kind: "text"; li: boolean; bullet: string; parts: InlinePart[]; gap: boolean }
  | { kind: "code"; lang: string; lines: string[]; gap: true };

export interface MdState {
  settled: MdBlock[];
  /** Raw text of the unfinished line, or of the last line before a newline arrives. */
  tail: string;
  /** Lines of a fence that has opened and not closed yet. */
  fence: { lang: string; lines: string[] } | null;
}

export const emptyMd: MdState = { settled: [], tail: "", fence: null };

export function inline(text: string): InlinePart[] {
  return text
    .split(/(`[^`]+`)/)
    .filter(Boolean)
    .map((x) => (/^`.+`$/.test(x) ? { t: x.slice(1, -1), code: true } : { t: x, code: false }));
}

function textBlock(line: string, prev: MdBlock | undefined): MdBlock {
  const li = /^- /.test(line);
  const prevLi = prev?.kind === "text" && prev.li;
  return {
    kind: "text",
    li,
    bullet: li ? "• " : "",
    parts: inline(li ? line.slice(2) : line),
    gap: prev !== undefined && !(li && prevLi),
  };
}

/** Feeds one complete line into a draft that `pushMd` owns: its arrays are copies, so they grow in place. */
function line(
  draft: { settled: MdBlock[]; fence: { lang: string; lines: string[] } | null },
  text: string,
): void {
  const fence = /^```(.*)$/.exec(text);
  if (draft.fence) {
    if (fence) {
      draft.settled.push({ kind: "code", lang: draft.fence.lang, lines: draft.fence.lines, gap: true });
      draft.fence = null;
    } else draft.fence.lines.push(text);
  } else if (fence) draft.fence = { lang: (fence[1] ?? "").trim(), lines: [] };
  else if (text.trim()) draft.settled.push(textBlock(text, draft.settled.at(-1)));
}

/**
 * Appends streamed text. Complete lines settle (code settles at its closing fence); the rest stays open.
 * One copy per push, so a delta of many lines costs its own size, not its square; one copy per delta stays linear in the blocks so far.
 */
export function pushMd(state: MdState, delta: string): MdState {
  const parts = (state.tail + delta).split("\n");
  const tail = parts.pop() ?? "";
  if (parts.length === 0) return { ...state, tail };
  const draft = {
    settled: state.settled.slice(),
    fence: state.fence ? { lang: state.fence.lang, lines: state.fence.lines.slice() } : null,
  };
  for (const l of parts) line(draft, l);
  return { ...draft, tail };
}

/** The block still growing: an unclosed fence, or the unfinished line. Null when there is none. */
export function openBlock(state: MdState): MdBlock | null {
  if (state.fence) {
    const lines = state.tail === "" ? state.fence.lines : [...state.fence.lines, state.tail];
    return { kind: "code", lang: state.fence.lang, lines, gap: true };
  }
  if (!state.tail.trim()) return null;
  return textBlock(state.tail, state.settled.at(-1));
}

/** Settles everything: the end of the answer. */
export function finishMd(state: MdState): MdState {
  const open = openBlock(state);
  return open
    ? { settled: [...state.settled, open], tail: "", fence: null }
    : { ...state, tail: "", fence: null };
}

/** All blocks of a finished text, as the canvas `md(text)`. */
export function renderMd(text: string): MdBlock[] {
  return finishMd(pushMd(emptyMd, text)).settled;
}

/** Settled blocks plus the open one: what a view draws while the answer streams. */
export function visibleBlocks(state: MdState): MdBlock[] {
  const open = openBlock(state);
  return open ? [...state.settled, open] : state.settled;
}
