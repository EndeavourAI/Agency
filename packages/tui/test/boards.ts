/**
 * The 18 canvas boards as application states, built the way the daemon builds them: through events. Sample data is
 * the canvas's own; nothing of it ships.
 */

import {
  type AppState,
  type Event,
  initialState,
  reduce,
  type ThemeName,
  type WireEvent,
  type WireSessionRow,
  type WireStatus,
} from "../src/state/index.ts";
import { Driver } from "./helpers.ts";

export const SID = "retry";
const T0 = Date.parse("2026-10-22T08:00:00Z");
export const NOW = T0 + 12 * 60_000 + 42_000;

export const ROWS: WireSessionRow[] = [
  {
    id: "retry",
    title: "Retry infra faults",
    tipId: "x",
    entries: 9,
    updatedAt: new Date(NOW - 5_000).toISOString(),
    lastPrompt: null,
    branch: "dev",
    costUsd: 1.75,
    outcome: "done",
  },
  {
    id: "tui",
    title: "TUI concepts",
    tipId: "x",
    entries: 4,
    updatedAt: new Date(NOW - 4 * 60_000).toISOString(),
    lastPrompt: null,
    branch: "dev",
    costUsd: 0.4,
    outcome: "done",
  },
  {
    id: "gates",
    title: "Tune stop gates",
    tipId: "x",
    entries: 6,
    updatedAt: new Date(NOW - 86_400_000).toISOString(),
    lastPrompt: null,
    branch: "dev",
    costUsd: 0.9,
    outcome: "done",
  },
  {
    id: "path",
    title: "Sample: failed turn",
    tipId: "x",
    entries: 3,
    updatedAt: new Date(NOW - 3 * 86_400_000).toISOString(),
    lastPrompt: null,
    branch: "dev",
    costUsd: 0.3,
    outcome: "failed",
  },
];

const MODELS = [
  {
    ref: "anthropic/haiku",
    provider: "anthropic",
    providerName: "Anthropic",
    id: "haiku",
    name: "Haiku 5.5",
    contextWindow: 200_000,
    inPerMTok: 0.1,
    outPerMTok: 0.5,
    tags: "",
  },
  {
    ref: "anthropic/sonnet",
    provider: "anthropic",
    providerName: "Anthropic",
    id: "sonnet",
    name: "Sonnet 5.5",
    contextWindow: 1_000_000,
    inPerMTok: 2,
    outPerMTok: 10,
    tags: "",
  },
  {
    ref: "anthropic/opus",
    provider: "anthropic",
    providerName: "Anthropic",
    id: "opus",
    name: "Opus 5.5",
    contextWindow: 1_000_000,
    inPerMTok: 4,
    outPerMTok: 20,
    tags: "",
  },
  {
    ref: "openai/gpt",
    provider: "openai",
    providerName: "OpenAI",
    id: "gpt",
    name: "GPT-5.2",
    contextWindow: 400_000,
    inPerMTok: 5,
    outPerMTok: 20,
    tags: "",
  },
  {
    ref: "google/gemini",
    provider: "google",
    providerName: "Google",
    id: "gemini",
    name: "Gemini 3 Pro",
    contextWindow: 1_000_000,
    inPerMTok: 2.5,
    outPerMTok: 10,
    tags: "",
  },
  {
    ref: "openrouter/deepseek",
    provider: "openrouter",
    providerName: "OpenRouter",
    id: "deepseek",
    name: "DeepSeek V4",
    contextWindow: 128_000,
    inPerMTok: 0.5,
    outPerMTok: 2,
    tags: "",
  },
  {
    ref: "openrouter/laguna",
    provider: "openrouter",
    providerName: "OpenRouter",
    id: "laguna",
    name: "Laguna S 2.1",
    contextWindow: 128_000,
    inPerMTok: 0,
    outPerMTok: 0,
    tags: "free",
  },
];

const STATUS: WireStatus = {
  sessionId: SID,
  model: "sonnet",
  effort: "high",
  mode: "ask",
  costUsd: 1.75,
  contextTokens: 112_000,
  contextLimit: 200_000,
  compactAt: 180_000,
  cacheHitRate: 0.91,
  branch: "dev",
};

const SLASH = [
  { name: "compact", desc: "Summarize the conversation to free up context", meta: "" },
  { name: "clear", desc: "Start a new session in this project", meta: "", act: "home" as const },
  { name: "init", desc: "Create the instruction files of this project", meta: "" },
  { name: "model", desc: "Change the model", meta: "", act: "model" as const },
  { name: "review", desc: "Open the changes for review", meta: "", act: "review" as const },
  { name: "settings", desc: "Open settings", meta: "", act: "settings" as const },
  { name: "undo", desc: "Undo the last turn", meta: "" },
  { name: "eval", desc: "Run the harbor eval on one task", meta: "command" },
  { name: "antislop", desc: "Audit UI work for AI slop", meta: "skill" },
];

const FILES = [
  "packages/eval/harbor/run.sh",
  "packages/eval/harbor/report.py",
  "packages/core/src/loop.ts",
  "packages/core/src/prune.ts",
  "packages/cli/src/daemon/index.ts",
  "packages/cli/src/daemon/handlers/session.ts",
  "packages/cli/src/daemon/handlers/git.ts",
  "AGENTS.md",
  "package.json",
];

export interface BoardOptions {
  cols?: number;
  rows?: number;
  theme?: ThemeName;
}

/** The daemon has told a client its lists, its models and its config: the state before a person does anything. */
export function connected(o: BoardOptions = {}): Driver {
  const d = new Driver({
    ...initialState({
      cols: o.cols ?? 160,
      rows: o.rows ?? 40,
      workspace: "/home/dev/Agency",
      theme: o.theme ?? "agency",
    }),
  });
  d.daemon(
    { type: "conn", status: "online" },
    { type: "sessions_loaded", rows: ROWS },
    { type: "week_cost_loaded", costUsd: 3.35 },
    { type: "live_turns", sessionIds: [] },
    { type: "slash_loaded", slash: SLASH },
    { type: "files_loaded", files: FILES },
    {
      type: "models_loaded",
      models: MODELS,
      connected: ["anthropic", "openai", "google", "openrouter"],
      defaultModel: "anthropic/sonnet",
    },
    { type: "config_loaded", config: {} },
  );
  return d;
}

const wire = (d: Driver, turnId: string, event: WireEvent, at: number): void =>
  d.daemon({ type: "turn_event", sessionId: SID, turnId, event, at });

const ANSWER =
  "Retries replace the failed trial in place, so both arms keep the same task set:\n```sh\nharbor run -r 2 --retry-include RuntimeError --retry-include NetworkConnectionError\n```\n- `AgentSetupTimeoutError` is a machine fault too, so it retries\n- a task that fails twice still counts as a fail\n";

/** The open session of the main board: a finished turn after a compaction marker, and a live one. */
export function session(o: BoardOptions = {}, live = true): Driver {
  const d = connected(o);
  d.daemon({ type: "session_opened", sessionId: SID, title: "Retry infra faults" });
  d.daemon({
    type: "turn_started",
    sessionId: SID,
    turnId: "t1",
    prompt: "Make the 54 task runs faster without changing results.",
    images: [],
    at: T0,
  });
  wire(
    d,
    "t1",
    {
      type: "compaction",
      phase: "end",
      sessionId: SID,
      replaced: 6,
      tokensBefore: 148_000,
      tokensAfter: 31_000,
    },
    T0 + 1,
  );
  wire(
    d,
    "t1",
    {
      type: "thinking_delta",
      text: "Read the run script first, then check which retry flags Harbor accepts.",
    },
    T0 + 2,
  );
  wire(d, "t1", { type: "thinking_end", ms: 7000 }, T0 + 3);
  const steps: Array<[string, string, Record<string, unknown>, string]> = [
    [
      "read",
      "r1",
      { path: "packages/eval/harbor/run.sh" },
      '#!/usr/bin/env bash\nset -euo pipefail\nhere="$(cd "$(dirname "$0")" && pwd)"\nsource=(--path "$here/tasks")\ninclude=(--include "${TASKS:-*}")\nJOB="${JOB:-run-$(date +%s)}"',
    ],
    [
      "bash",
      "r2",
      { command: 'harbor run --help | grep -E "retr|concurren"' },
      "  -n, --n-concurrent INTEGER   Trials to run at once\n  -r, --max-retries INTEGER    Retries for a failed trial\n      --retry-include TEXT     Exception type to retry; repeat it",
    ],
    [
      "edit",
      "r3",
      {
        path: "packages/eval/harbor/run.sh",
        oldText: '  -a "${AGENT}" -o "$jobs" -y',
        newText: '  -a "${AGENT}" -o "$jobs" -y \\\n  -r 2 --retry-include RuntimeError',
      },
      "ok",
    ],
    [
      "bash",
      "r4",
      { command: "dry run with no matching task" },
      "harbor: 0 tasks match --include nothing\nflags accepted: -r 2, --retry-include ×3\nexit 0",
    ],
  ];
  steps.forEach(([name, id, input, content], i) => {
    wire(d, "t1", { type: "tool_start", id, name, input }, T0 + 10 + i * 2);
    wire(d, "t1", { type: "tool_result", id, content, isError: false }, T0 + 11 + i * 2);
  });
  wire(d, "t1", { type: "text_delta", text: ANSWER }, T0 + 30);
  wire(
    d,
    "t1",
    {
      type: "turn_complete",
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 3440 },
      timing: { ttftMs: 2000, streamMs: 40_000 },
    },
    T0 + 40_000,
  );
  d.daemon({
    type: "turn_finished",
    sessionId: SID,
    turnId: "t1",
    at: T0 + 40_000,
    outcome: { stopReason: "end_turn" },
  });
  d.daemon({
    type: "turn_started",
    sessionId: SID,
    turnId: "t2",
    prompt: "Also count environment start timeouts as machine faults.",
    images: [],
    at: NOW - 102_000,
  });
  if (live) {
    wire(
      d,
      "t2",
      { type: "thinking_delta", text: "The start timeout is an environment fault like the others." },
      NOW - 100_000,
    );
    wire(
      d,
      "t2",
      { type: "tool_start", id: "q1", name: "read", input: { path: "packages/eval/harbor/report.py" } },
      NOW - 99_000,
    );
    wire(
      d,
      "t2",
      { type: "tool_result", id: "q1", content: "import json, sys", isError: false },
      NOW - 98_000,
    );
    wire(
      d,
      "t2",
      { type: "tool_start", id: "q2", name: "edit", input: { path: "packages/eval/harbor/report.py" } },
      NOW - 97_000,
    );
    wire(
      d,
      "t2",
      {
        type: "text_delta",
        text: "The start timeout is an environment fault like the others, so it goes in the same `INFRA` list. Editing `report.py` now",
      },
      NOW - 96_000,
    );
  }
  d.daemon({ type: "live_turns", sessionIds: live ? [SID] : [] });
  d.daemon({ type: "status_loaded", sessionId: SID, status: STATUS, line: "ci passing · 2 open PRs" });
  d.daemon({
    type: "todos_loaded",
    sessionId: SID,
    todos: [
      { id: "1", content: "Rebuild Linux binary", status: "completed" },
      { id: "2", content: "Retry infra faults", status: "completed" },
      { id: "3", content: "Count start timeouts", status: "in_progress" },
      { id: "4", content: "Compare per task", status: "pending" },
    ],
  });
  d.daemon({
    type: "git_loaded",
    git: {
      repo: true,
      branch: "dev",
      files: [
        { path: "packages/eval/harbor/run.sh", status: "M", added: 2, deleted: 1 },
        { path: "packages/eval/harbor/report.py", status: "M", added: 1, deleted: 1 },
      ],
    },
  });
  return d;
}

export const apply = (state: AppState, ...events: Event[]): AppState => events.reduce(reduce, state);
