import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@agency/providers";
import type { Message, Migration } from "@agency/schema";

export const SESSION_SCHEMA_VERSION = 2;

/**
 * v1→v2: v1 entries carried schemaVersion: 1 but the same base shape. The
 * migration bumps the version and ensures the entry has the required base
 * fields (id, parentId, createdAt, type). New entry types (agent_lifecycle,
 * todo_state, agent_message, session_title) are already handled by the
 * existing type guards — they just need the version bump to pass through.
 */
export const sessionMigrations: Migration[] = [
  {
    from: 1,
    to: 2,
    migrate(record) {
      // Ensure the entry has all required base fields; v1 entries already
      // have them, but this is a safety net for any edge-case entries.
      return {
        ...record,
        // If any v1 entry is missing these, provide sensible defaults
        id: (record.id as string) ?? randomUUID(),
        parentId: (record.parentId as string | null) ?? null,
        createdAt: (record.createdAt as string) ?? new Date().toISOString(),
        type: (record.type as string) ?? "unknown",
      };
    },
  },
];

/** Every entry carries these regardless of type, including one this reader
 *  doesn't recognize (R5: unknown entries pass through, they're never dropped). */
export interface SessionEntryBase {
  id: string;
  parentId: string | null;
  schemaVersion: number;
  createdAt: string;
  type: string;
}

export type SessionEntry = SessionEntryBase & Record<string, unknown>;

export interface MessageEntry extends SessionEntryBase {
  type: "message";
  message: Message;
  /** A user-role message that entered mid-turn: a viewer keeps it inside the running turn, not as a new prompt. */
  origin?: MessageOrigin;
  /** On a prompt: the turn it started, whose file writes a rewind puts back. */
  turnId?: string;
}

/**
 * "harness": the loop wrote it (Stop-hook feedback). "inbox": the user or a teammate sent it while the turn ran.
 * "shell": the output of a command that the user ran with `shell_run`.
 */
export type MessageOrigin = "harness" | "inbox" | "shell";

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  model: string;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  level: ThinkingLevel;
}

export interface CompactionSummaryEntry extends SessionEntryBase {
  type: "compaction_summary";
  summary: string;
  replacedEntryIds: string[];
}

export interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  label: string;
}

export interface TodoStateEntry extends SessionEntryBase {
  type: "todo_state";
  todos: Array<{
    id: string;
    content: string;
    status: "pending" | "in_progress" | "completed" | "ready_for_review";
    claimedBy?: string;
    priority?: string;
  }>;
}

export interface ItemStateEntry extends SessionEntryBase {
  type: "item_state";
  itemId: string;
  contract: string;
  acceptanceCriteria?: string;
  decisions?: string[];
  filesTouched?: string[];
  verification?: string;
  openQuestions?: string[];
}

export interface AgentMessageEntry extends SessionEntryBase {
  type: "agent_message";
  from: string;
  to: string;
  body: string;
}

export interface AgentLifecycleEntry extends SessionEntryBase {
  type: "agent_lifecycle";
  handle: string;
  state: "working" | "idle" | "blocked" | "failed" | "completed";
  detail?: string;
}

export interface SessionTitleEntry extends SessionEntryBase {
  type: "session_title";
  title: string;
}

/** How a turn ended, written for every turn so a reload tells a stop from a finish; none means the daemon died mid-turn. */
export interface TurnEndEntry extends SessionEntryBase {
  type: "turn_end";
  /** Not `turnId`: that field marks a prompt, which rewind and the history read. */
  forTurn: string;
  outcome: "done" | "stopped" | "denied" | "failed";
  stopReason?: string;
  error?: { code: string; message: string };
  /** What the person refused, as `tool target`. */
  deniedBy?: string;
  /** The short HEAD of the workspace before and after the turn: they differ when the turn committed. */
  head?: { before: string; after: string };
  /** The last test, typecheck, lint or build of the turn: passed, failed, or stale when an edit came after it. */
  checks: "passed" | "failed" | "stale" | "none";
}

export type TurnEnd = Omit<TurnEndEntry, keyof SessionEntryBase> & { type: "turn_end" };

export function isTurnEndEntry(e: SessionEntry): e is SessionEntry & TurnEndEntry {
  return e.type === "turn_end";
}

export function isMessageEntry(e: SessionEntry): e is SessionEntry & MessageEntry {
  return e.type === "message";
}

export function isCompactionSummaryEntry(e: SessionEntry): e is SessionEntry & CompactionSummaryEntry {
  return e.type === "compaction_summary";
}

export function isBranchSummaryEntry(e: SessionEntry): e is SessionEntry & BranchSummaryEntry {
  return e.type === "branch_summary";
}

export function isTodoStateEntry(e: SessionEntry): e is SessionEntry & TodoStateEntry {
  return e.type === "todo_state";
}

export function isItemStateEntry(e: SessionEntry): e is SessionEntry & ItemStateEntry {
  return e.type === "item_state";
}

export function isSessionTitleEntry(e: SessionEntry): e is SessionEntry & SessionTitleEntry {
  return e.type === "session_title";
}

export function isAgentMessageEntry(e: SessionEntry): e is SessionEntry & AgentMessageEntry {
  return e.type === "agent_message";
}

export function isAgentLifecycleEntry(e: SessionEntry): e is SessionEntry & AgentLifecycleEntry {
  return e.type === "agent_lifecycle";
}

export function newEntryId(): string {
  return randomUUID();
}

/** True for anything with the base shape every entry must have, known type or not. */
export function hasEntryShape(raw: unknown): raw is SessionEntry {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    (typeof r.parentId === "string" || r.parentId === null) &&
    typeof r.schemaVersion === "number" &&
    typeof r.createdAt === "string" &&
    typeof r.type === "string"
  );
}
