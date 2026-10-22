/**
 * Records fixtures/session-stream.json from a real daemon run: `bun packages/tui/test/record-fixture.ts`.
 * The provider is scripted (see scenario.ts); every event is what the daemon itself broadcast.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startScenario } from "./scenario.ts";

interface Recorded {
  t: number;
  event: Record<string, unknown> & { type: string };
}

const s = await startScenario();
const sessionId = "fixture-session";
await s.client.call("session_create", { sessionId });

async function turn(prompt: string, decide: "once" | "reject") {
  const turnId = `turn-${Math.random().toString(36).slice(2, 8)}`;
  const events: Recorded[] = [];
  const answers: Array<{ after: number; requestId: string; decision: string }> = [];
  const t0 = Date.now();
  s.client.subscribe(`turn.${turnId}`);
  s.client.on(`turn.${turnId}`, (payload) => {
    const event = payload as Recorded["event"];
    if (event.type === "heartbeat") return;
    events.push({ t: Date.now() - t0, event });
    if (event.type === "approval_requested") {
      const requestId = event.requestId as string;
      answers.push({ after: events.length - 1, requestId, decision: decide });
      void s.client.call("approval_respond", { requestId, decision: decide, sessionId });
    }
  });
  const result = (await s.client.call("session_send", {
    turnId,
    sessionId,
    provider: "anthropic",
    model: "fixture-model",
    userText: prompt,
    permissionMode: "allow-edits",
  })) as Record<string, unknown>;
  return {
    turnId,
    prompt,
    events,
    answers,
    result: {
      stopReason: result.stopReason,
      cancelled: result.cancelled ?? false,
      error: result.error ?? null,
    },
  };
}

const turns = [
  await turn("Make the 54 task runs faster without changing results.", "once"),
  await turn("Now clean the build folder.", "reject"),
];
const shown = (await s.client.call("session_show", { sessionId })) as { entries: unknown[]; tipId: string };

let json = JSON.stringify({ sessionId, turns, entries: shown.entries, tipId: shown.tipId }, null, 2);
// Nothing of this machine goes into the fixture.
json = json
  .split(s.workspace.replaceAll("\\", "\\\\"))
  .join("<workspace>")
  .split(s.workspace)
  .join("<workspace>");
if (/test-key-not-real|sk-[A-Za-z0-9]{10,}/.test(json)) throw new Error("fixture holds a key");
writeFileSync(join(import.meta.dir, "fixtures", "session-stream.json"), `${json}\n`);
await s.stop();
console.log(
  `recorded ${turns.map((t) => t.events.length).join(" + ")} events and ${shown.entries.length} entries`,
);
process.exit(0);
