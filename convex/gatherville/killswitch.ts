// Global LLM kill switch.
//
// One env var that stops every paid outbound call — decisions, utterances,
// interviews, reflections, embeddings, batches, and the inherited ai-town
// chat/moderation paths. It is checked inside each network function rather
// than at the callers, so a new call site cannot forget to honour it.
//
// Why an env var and not a table row: `npx convex env set` takes effect on the
// next function invocation with no deploy, so the switch can be thrown faster
// than code can ship. And because it is read at call time rather than at module
// load, an already-warm isolate picks it up too.
//
// Stopping the engine (`testing:stop`) is the other half — that prevents the
// calls from being attempted at all. This guard is the backstop that makes
// spending impossible even if something schedules work anyway.

export class LLMPausedError extends Error {
  constructor(what: string) {
    super(
      `LLM calls are paused (${what}). Nothing was sent and nothing was billed. ` +
        `Resume with:  npx convex env remove LLM_PAUSED`,
    );
    this.name = 'LLMPausedError';
  }
}

/** True when the kill switch is engaged. Read fresh on every call. */
export function llmPaused(): boolean {
  const raw = process.env.LLM_PAUSED;
  if (!raw) return false;
  // Any value other than an explicit off means paused. Erring toward paused is
  // deliberate: a typo should cost nothing rather than silently resume billing.
  return !['0', 'false', 'off', ''].includes(raw.trim().toLowerCase());
}

/** Throw if paused. Call at the top of anything that hits a paid endpoint. */
export function assertLLMAllowed(what: string): void {
  if (llmPaused()) throw new LLMPausedError(what);
}
