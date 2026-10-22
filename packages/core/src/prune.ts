import type { ContentBlock, Message } from "@agency/schema";

/** Tools whose call the model can send again for the same result. */
const RERUNNABLE = /^(read|bash|grep|glob|fetch|websearch|lsp_\w+)$/;
const MIN_CHARS = 2000;

/** A result is due `age` model calls after it came; due results go once they pass `batchTokens`. */
export interface PruneRule {
  age: number;
  batchTokens: number;
}

/** What a session's first requests cached. Its rule is fixed at the third, so later requests keep one prefix. */
export interface CacheSeen {
  requests: number;
  input: number;
  cached: number;
  written: number;
  rule?: PruneRule;
  /** Set once a request nears the model's long-prompt price step: thinking is not sent back from then on. */
  thinkingDropped?: boolean;
}

// Replay of 108 stored research sessions against age 10/20K: input -30% with no batch; with a cache priced at
// 0.25x, -6% at 10K; at Anthropic's 0.1x read and 1.25x write, -6% at 40K, where smaller batches cost more.
const NO_CACHE: PruneRule = { age: 6, batchTokens: 0 };
const READ_CACHE: PruneRule = { age: 6, batchTokens: 10_000 };
const WRITTEN_CACHE: PruneRule = { age: 6, batchTokens: 40_000 };
// The same replay at Laguna's 0.1x read price: 20K batches cost 11% less than 10K, with 12% more input.
const CHEAP_READ_CACHE: PruneRule = { age: 6, batchTokens: 20_000 };

/** Counts one request's usage until the rule is fixed: a cache that holds half the input keeps batches. */
export function seeCache(
  seen: CacheSeen,
  usage: { inputTokens: number; cachedInputTokens?: number; cacheWriteInputTokens?: number },
  /** A cached input token's price over an input token's, from the catalog. */
  readPrice?: number,
): void {
  if (seen.rule !== undefined) return;
  seen.requests += 1;
  seen.input += usage.inputTokens;
  seen.cached += usage.cachedInputTokens ?? 0;
  seen.written += usage.cacheWriteInputTokens ?? 0;
  if (seen.requests < 3) return;
  seen.rule =
    seen.cached * 2 < seen.input
      ? NO_CACHE
      : seen.written > 0
        ? WRITTEN_CACHE
        : (readPrice ?? 1) <= 0.1
          ? CHEAP_READ_CACHE
          : READ_CACHE;
}

// Replay of 49 Haiku 5.5 benchmark sessions: old thinking was 80% of each prompt over the 100K step and 57% of the
// cost; not sending it after 80% of the step cost 52% less. The server's clear_thinking spares the current tool loop.
const THINKING_STOP_SHARE = 0.8;

/** Marks `seen` once a request and its reply pass 80% of `overTokens`, the prompt size that is priced higher. */
export function seeSize(seen: CacheSeen, tokens: number, overTokens: number | undefined): void {
  if (overTokens !== undefined && tokens > overTokens * THINKING_STOP_SHARE) seen.thinkingDropped = true;
}

/** The history without thinking blocks: with none sent, no later block is bound to a changed prefix. */
export function withoutThinking(messages: Message[]): Message[] {
  return messages.flatMap((message) => {
    const content = message.content.filter(
      (block) => block.type !== "thinking" && block.type !== "redacted_thinking",
    );
    if (content.length === message.content.length) return [message];
    // A reply of thinking alone would be empty, which strict providers reject.
    return content.length > 0 ? [{ ...message, content }] : [];
  });
}

/** Before the rule is fixed, the one that prunes least. */
export const pruneRule = (seen: CacheSeen): PruneRule => seen.rule ?? WRITTEN_CACHE;
/** What an image of a result counts as: about the tokens of a 1000-pixel image. */
const IMAGE_CHARS = 6400;

/**
 * True when a read result holds the text it asked for: not a note that points at an earlier result, and not cut by
 * the read tool. Only such a read makes an earlier one out of date.
 */
function showsWholeText(content: string): boolean {
  return !content.startsWith("[Unchanged") && !content.includes("[The file has ");
}

/** A read names a file and a slice; a read with no slice shows the whole file. */
function readTarget(input: Record<string, unknown>): { path: string; slice: string } {
  const path = String(input.path ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  const whole = input.offset === undefined && input.limit === undefined;
  return { path, slice: whole ? "" : `${input.offset ?? 1}:${input.limit ?? ""}` };
}

/**
 * The history with the results of re-runnable tools over `rule.age` model calls old put as a short note, as Densilo
 * cuts what an agent sends again. Measured on a long session: 25% fewer input tokens and 19% lower cost with the cache.
 * A read that a later read of the same file shows again (the whole file, or the same slice) is due at once: its
 * text is out of date. They go in batches of `rule.batchTokens`, decided by a replay of the history, so a history
 * gives the same requests every time and the prompt cache holds between two batches.
 */
export function pruneStaleResults(messages: Message[], rule: PruneRule): Message[] {
  const names = new Map<string, string>();
  const reads = new Map<string, { path: string; slice: string; at: number; shows?: boolean }>();
  const candidates: Array<{
    message: number;
    block: number;
    due: number;
    chars: number;
    read?: { path: string; slice: string; at: number };
  }> = [];
  let calls = 0;
  messages.forEach((message, index) => {
    message.content.forEach((block, blockIndex) => {
      if (block.type === "tool_call") {
        names.set(block.id, block.name);
        if (block.name === "read") reads.set(block.id, { ...readTarget(block.input), at: calls });
      }
      if (block.type !== "tool_result" || !RERUNNABLE.test(names.get(block.toolCallId) ?? "")) return;
      const own = reads.get(block.toolCallId);
      if (own !== undefined) own.shows = !block.isError && showsWholeText(block.content);
      const chars = block.content.length + (block.images?.length ?? 0) * IMAGE_CHARS;
      const read = block.isError ? undefined : reads.get(block.toolCallId);
      if (chars > MIN_CHARS)
        candidates.push({
          message: index,
          block: blockIndex,
          due: calls + rule.age,
          chars,
          ...(read ? { read } : {}),
        });
    });
    if (message.role === "assistant") calls += 1;
  });
  // A later read of the whole file, or of the same slice, makes an earlier read due at its call.
  for (const candidate of candidates) {
    const own = candidate.read;
    if (own === undefined) continue;
    for (const later of reads.values()) {
      if (
        later.shows === true &&
        later.at > own.at &&
        later.path === own.path &&
        (later.slice === "" || later.slice === own.slice)
      )
        candidate.due = Math.min(candidate.due, later.at - 1);
    }
  }
  candidates.sort((a, b) => a.due - b.due);
  // Replays each model call of the history: once the old results that wait pass a batch, they all go.
  const pruned = new Set<string>();
  let next = 0;
  let waiting: typeof candidates = [];
  for (let call = 0; call <= calls; call++) {
    for (let candidate = candidates[next]; candidate && call > candidate.due; candidate = candidates[next]) {
      waiting.push(candidate);
      next += 1;
    }
    if (waiting.reduce((sum, candidate) => sum + candidate.chars, 0) / 4 > rule.batchTokens) {
      for (const candidate of waiting) pruned.add(`${candidate.message}:${candidate.block}`);
      waiting = [];
    }
  }
  if (pruned.size === 0) return messages;
  return messages.map((message, index) => ({
    ...message,
    content: message.content.map((block, blockIndex) => {
      if (block.type !== "tool_result" || !pruned.has(`${index}:${blockIndex}`)) return block;
      const name = names.get(block.toolCallId);
      return {
        type: "tool_result" as const,
        toolCallId: block.toolCallId,
        isError: block.isError,
        content: `[The ${block.content.length}-character result of this old ${name} call was removed to save context. Call ${name} again if you need it.]`,
      };
    }),
  }));
}

const SAME_READ_MIN_CHARS = 500;

/**
 * A `read` whose text the model can still see in `visible`, the history as the next request sends it, becomes a note
 * that points at the earlier result. Checked against the sent view: once that result is pruned or compacted away, a
 * new read gives the whole text again.
 */
export function dedupeReads<R extends ContentBlock>(
  results: R[],
  calls: ReadonlyArray<{ id: string; name: string; input: Record<string, unknown> }>,
  visible: Message[],
): R[] {
  const earlier = new Map<string, string>();
  const inputs = new Map<string, Record<string, unknown>>();
  for (const message of visible) {
    for (const block of message.content) {
      if (block.type === "tool_call" && block.name === "read") inputs.set(block.id, block.input);
      if (block.type === "tool_result" && !block.isError && inputs.has(block.toolCallId))
        earlier.set(block.content, String(inputs.get(block.toolCallId)?.path ?? ""));
    }
  }
  const byId = new Map(calls.map((call) => [call.id, call]));
  return results.map((result) => {
    if (result.type !== "tool_result" || result.isError) return result;
    const call = byId.get(result.toolCallId);
    if (call?.name !== "read" || result.content.length < SAME_READ_MIN_CHARS) return result;
    const seen = earlier.get(result.content);
    if (seen === undefined) {
      earlier.set(result.content, String(call.input.path ?? ""));
      return result;
    }
    return {
      ...result,
      content: `[Unchanged: the same text as the earlier read result of ${seen}, which is still above.]`,
    };
  });
}
