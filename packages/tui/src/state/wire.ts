/**
 * Shapes the daemon sends, as this client reads them. Sources: `LoopEvent` (packages/core/src/loop.ts) and the
 * broadcasts of packages/cli/src/daemon (compaction, cost_meter, approval_requested, fallback, mode_changed).
 */
export interface WireUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  costUsd?: number;
}

export interface WireApprovalRequest {
  tool: string;
  title: string;
  command?: string;
  path?: string;
  riskTier?: string;
  argsSummary?: string;
  source?: string;
}

/** What a tool measured for its step line (`tool_result`.meta); durationMs comes from the daemon's clock. */
export interface WireToolMeta {
  exitCode?: number;
  added?: number;
  removed?: number;
  lines?: number;
  durationMs?: number;
}

/** How a turn ended (the daemon's `turn_end` entry): the commit it made and the checks it ran. */
export interface WireTurnEnd {
  outcome: "done" | "stopped" | "denied" | "failed";
  deniedBy?: string;
  head?: { before: string; after: string };
  checks: "passed" | "failed" | "stale" | "none";
}

export type WireEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_end"; ms: number }
  | {
      type: "turn_end";
      stopReason: string;
      cancelled: boolean;
      error?: { code: string; message: string };
      end?: WireTurnEnd;
    }
  | { type: "approval_resolved"; requestId: string; decision: "once" | "always" | "reject" }
  | { type: "tool_start"; id: string; name: string; input?: Record<string, unknown> }
  | { type: "tool_progress"; id: string; name: string; message: string }
  | {
      type: "tool_result";
      id: string;
      content: string;
      isError: boolean;
      images?: unknown[];
      meta?: WireToolMeta;
    }
  | {
      type: "turn_complete";
      stopReason: string;
      usage: WireUsage;
      timing?: { ttftMs: number; streamMs: number };
    }
  | { type: "budget_exceeded"; spentTokens: number; spentCostUsd: number }
  | { type: "iteration_limit"; iterations: number }
  | { type: "error"; code: string; message: string }
  | { type: "retry"; attempt: number; message: string; next?: number }
  | { type: "model_route"; model: string; routed: "cheap" | "primary"; tag: string }
  | { type: "heartbeat" }
  | {
      type: "cost_meter";
      sessionId: string;
      turnCostUsd: number;
      runTotalUsd: number;
      runCacheHitRate: number;
      perAgent?: Record<string, number>;
    }
  | {
      type: "compaction";
      phase: "start" | "end";
      sessionId: string;
      /** Only on a compaction that happened: the turns folded into the summary and the size before and after. */
      replaced?: number;
      tokensBefore?: number;
      tokensAfter?: number;
    }
  | { type: "fallback"; from: string; to: string; reason: string }
  | {
      type: "approval_requested";
      requestId: string;
      sessionId: string;
      turnId: string;
      riskTier: string;
      source: string;
      argsSummary: string;
      request: WireApprovalRequest;
    }
  | { type: "mode_changed"; mode: string }
  | { type: "prompt_suggestion"; sessionId: string; turnId: string; text: string };

/** One row of `session_list`. */
export interface WireSessionRow {
  id: string;
  title: string | null;
  tipId: string | null;
  entries: number;
  updatedAt: string | null;
  lastPrompt: string | null;
  branch: string | null;
  costUsd: number;
  /** The last turn: running now, or how it ended; null when the session has no record of it. */
  outcome?: "running" | "done" | "stopped" | "failed" | null;
}

/** `status_get`.status */
export interface WireStatus {
  sessionId: string;
  model: string | null;
  effort: string | null;
  mode: string;
  costUsd: number;
  contextTokens: number;
  contextLimit: number | null;
  /** Tokens at which the session compacts. */
  compactAt?: number | null;
  cacheHitRate: number | null;
  branch: string | null;
}

/** One entry of a session file (`session_show`.entries): only the fields the TUI reads. */
export interface WireEntry {
  id: string;
  type: string;
  createdAt?: string;
  message?: { role: "user" | "assistant" | "system"; content: WireContent[] };
  origin?: "harness" | "inbox" | "shell";
  turnId?: string;
  summary?: string;
  [key: string]: unknown;
}

export type WireContent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean }
  | { type: "image"; mimeType: string; data: string };

/** `git_status` (packages/cli/src/daemon/handlers/git.ts). */
export interface WireGitStatus {
  repo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  lastCommit?: { hash: string; subject: string; when: string };
  files?: Array<{ path: string; status: string; added: number | null; deleted: number | null }>;
  /** A commit message to start from: the session's title or last prompt, else the changed files. */
  suggestedMessage?: string;
}

/** `git_diff`: the diff against HEAD plus the text of untracked files (null when binary or large). */
export interface WireGitDiff {
  diff: string;
  untracked: Array<{ path: string; text: string | null }>;
}

/** One item of `todo_read`.todos. */
export interface WireTodo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "ready_for_review";
}
