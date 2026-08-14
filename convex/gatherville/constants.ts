// Gatherville tuning constants.
//
// The single most important number in this file is the decision cadence.
// The simulation runs 24/7, but LLM decisions do NOT happen every tick —
// movement, pathfinding and conversation mechanics are deterministic and free.
// Cost scales with DECISIONS, not with uptime.

// ---------------------------------------------------------------------------
// Decision cadence (24/7 operation)
// ---------------------------------------------------------------------------

/**
 * How often a twin is allowed to make an LLM-backed decision, by tier.
 *
 * Rough cost per twin per month, assuming ~$0.0019/decision on Haiku 4.5
 * with a warm prompt cache (see prompt.ts):
 *
 *   observed  (10s)  → ~$490/mo   ← only while a human is actually watching
 *   active    (60s)  → ~$82/mo
 *   ambient   (15m)  → ~$5.50/mo
 *   dormant   (60m)  → ~$1.40/mo
 *
 * Nobody is watching most twins most of the time, so the steady state is
 * ambient/dormant and the expensive tiers are transient.
 */
/**
 * Minimum spacing between LLM decisions, per tier.
 *
 * These are CEILINGS, not rates. A decision also needs the engine to ask for
 * one, and `agentDoSomething` only fires when the life is neither mid-activity
 * nor walking — a chosen activity lasts 60s (constants.ts ACTIVITIES) plus
 * pathfinding plus ACTIVITY_COOLDOWN. Measured across production traces that
 * comes to a median of 88s, min 79s.
 *
 * So the effective interval is max(~88s, CADENCE_MS[tier]):
 *
 *   observed  10s  ->  88s   engine binds; tier is inert
 *   active    60s  ->  88s   engine binds; tier is inert
 *   ambient   15m  ->  15m   tier binds
 *   dormant   60m  ->  60m   tier binds
 *
 * `observed` and `active` are therefore the same tier in practice and have
 * never throttled a call. They are kept distinct because the value of watching
 * is the immediate WAKE in cadence.attachWatcher, not the interval — and if
 * activity durations ever shrink, these numbers start binding again.
 *
 * Do not derive cost estimates from these numbers; derive them from the traces.
 * Doing the former overstated watched cost by ~10x.
 */
export const CADENCE_MS = {
  observed: 10_000,
  active: 60_000,
  ambient: 15 * 60_000,
  dormant: 60 * 60_000,
} as const;

export type CadenceTier = keyof typeof CADENCE_MS;

/** Tier a twin drops to when the last watcher detaches. */
export const TIER_AFTER_UNWATCHED: CadenceTier = 'active';

/** How long a twin stays 'active' after being watched before decaying to 'ambient'. */
export const ACTIVE_DECAY_MS = 10 * 60_000;

/** How long 'ambient' persists before decaying to 'dormant'. */
export const AMBIENT_DECAY_MS = 6 * 60 * 60_000;

/**
 * Hard ceiling on LLM decisions per twin per hour, enforced regardless of tier.
 * This is the backstop that makes a runaway loop a bounded incident rather than
 * an unbounded bill. Cadence is the dial; this is the fuse.
 */
export const MAX_DECISIONS_PER_HOUR = 400;

/**
 * Fraction of decisions routed to the expensive model. The rest go to Haiku.
 * Salience is decided in decide.ts — this is just the budget guard.
 */
export const SALIENT_DECISION_RATIO = 0.15;

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * IMPORTANCE SCALE IS 0-100 — from genagents'
 * `memory_stream/importance_score/singular_v1.txt`.
 *
 * ⚠️ ai-town's `calculateImportance` (convex/agent/memory.ts) uses **0-9**.
 * The two must never coexist in one stream: a 0-9 score sorts below every 0-100
 * score, so ai-town-derived memories would silently never be retrieved. The
 * ai-town scorer is rescaled to 0-100 in our fork. See docs/GENAGENTS-ANALYSIS.md §2.1.
 */
export const IMPORTANCE_MAX = 100;

/** Interview-derived memories never score below this, so identity can't be buried. */
export const INTERVIEW_IMPORTANCE_FLOOR = 70;

/** Human interventions are the strongest signal we ever get about a twin. */
export const INTERVENTION_IMPORTANCE_FLOOR = 90;

/**
 * Retrieval weights. These MATCH genagents' `MemoryStream.retrieve()` default
 * `hp=[recency_w, relevance_w, importance_w] = [0, 1, 0.5]` exactly.
 *
 * Note recency is ZERO. That is not an oversight in the upstream research — it is
 * a deliberate departure from the original Smallville paper (which used 1/1/1).
 * For predicting what a person believes, *when* they said something matters much
 * less than whether it is relevant. Do not "fix" this without an experiment.
 *
 * See docs/FIDELITY.md.
 */
export const RETRIEVAL_WEIGHTS = {
  recency: 0.0,
  relevance: 1.0,
  importance: 0.5,
} as const;

/** genagents: `recency_decay = 0.99`, applied exponentially over chronological index. */
export const RECENCY_DECAY = 0.99;

/**
 * DEVIATION, default OFF. Bonus for identity-bearing memories so a week of
 * simulated small talk can't crowd out who the person actually is.
 *
 * genagents has no world simulation, so it never faces this problem — its stream
 * is pure interview. Ours is mixed, which is a genuinely new condition. Keep at
 * zero to stay bit-identical to upstream; raise only behind an A/B measured on
 * holdout accuracy.
 */
export const PROVENANCE_BONUS = {
  enabled: false,
  interview: 0.6,
  intervention: 0.9,
} as const;

/**
 * Convex hard limit on vector query results. Not tunable.
 *
 * genagents scores relevance across the whole memory stream; we prefilter via
 * the vector index and over-fetch to approximate that. This ceiling caps the
 * over-fetch, so for a twin with more than 256 memories our ranking is an
 * approximation of upstream's, not a reproduction of it.
 */
export const VECTOR_SEARCH_MAX = 256;

/** genagents `retrieve()` default is n_count=120. We pull fewer into a live prompt. */
export const RETRIEVAL_N_COUNT = 120;
export const RETRIEVAL_LIMIT = 12;

/** Don't re-touch a memory's lastAccess more often than this (from ai-town). */
export const MEMORY_ACCESS_THROTTLE = 300_000;

// ---------------------------------------------------------------------------
// Reflection
// ---------------------------------------------------------------------------

/**
 * Trigger reflection once accumulated importance since last reflection exceeds this.
 * ai-town used 500 on its 0-9 scale (~100 memories × avg 5). Rescaled to 0-100.
 */
export const REFLECTION_IMPORTANCE_THRESHOLD = 5_000;

/** Reflection is never latency-sensitive — always route through the Batch API. */
export const REFLECTION_USE_BATCH = true;

// ---------------------------------------------------------------------------
// Traces / RL corpus
// ---------------------------------------------------------------------------

/**
 * ai-town's crons.ts vacuums `memories`, `memoryEmbeddings` and `inputs`.
 * Traces must be exported to durable object storage BEFORE they age out, or
 * the training corpus silently evaporates. Export must stay ahead of vacuum.
 */
export const TRACE_EXPORT_INTERVAL_MS = 15 * 60_000;
export const TRACE_EXPORT_BATCH_SIZE = 1_000;

/** Refuse to vacuum traces newer than this that haven't been exported yet. */
export const TRACE_VACUUM_GUARD_MS = 24 * 60 * 60_000;
