import { askModel, renderTranscript } from "@agency/core";
import type { Message } from "@agency/schema";
import type { DaemonContext, RunTurnParams } from "../types.ts";
import { hookModel } from "../types.ts";

/** How many of the newest messages the suggester reads. */
const SUGGEST_MESSAGES = 6;
const SYSTEM =
  "You write the next prompt that the user is most likely to send to a coding agent. Reply with that one prompt in the user's voice, under 15 words, with no quotes. Reply with nothing when no follow-up is likely.";

/** Opt-in (`promptSuggestions`): one small-model request after a finished root turn, sent as `prompt_suggestion`. */
export async function suggestNextPrompt(
  ctx: DaemonContext,
  params: RunTurnParams,
  sessionId: string,
  messages: Message[],
): Promise<void> {
  if (ctx.config.promptSuggestions !== true) return;
  try {
    const { adapterFor, config, getKeychain, http, providers } = ctx;
    const { ref, apiKey } = await hookModel({ config, providers, adapterFor, http, getKeychain }, undefined);
    const text = await askModel(
      {
        adapter: adapterFor(ref.provider),
        http,
        model: ref.model,
        apiKey,
        maxTokens: 256,
        signal: AbortSignal.timeout(15_000),
      },
      SYSTEM,
      renderTranscript(messages.slice(-SUGGEST_MESSAGES)),
    );
    if (!text) return;
    const payload = { type: "prompt_suggestion", sessionId, turnId: params.turnId, text };
    ctx.broadcast(`session.${sessionId}`, payload);
    ctx.broadcast(`turn.${params.turnId}`, payload);
  } catch {
    // A failed suggestion must not touch the turn.
  }
}
