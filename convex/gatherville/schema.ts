// Gatherville schema.
//
// SUPERSEDES `convex/agent/schema.ts` from upstream ai-town. In the fork,
// `agentTables.memories` / `memoryEmbeddings` are removed and every call site in
// `convex/agent/memory.ts` is repointed here. There is exactly ONE memory stream.
//
// The reconciliation: upstream ai-town kept episodic conversation memory, and a
// separate identity/personality blob in `data/characters.ts`. A twin built from a
// real interview needs both in one stream, ranked together — otherwise a week of
// simulated small talk outranks who the person actually is. We solve that with a
// `provenance` field plus an importance floor rather than two stores.

import { v } from 'convex/values';
import { defineTable } from 'convex/server';
import { playerId, conversationId } from '../aiTown/ids';
import { EMBEDDING_DIMENSION } from '../util/llm';

// ---------------------------------------------------------------------------
// Provenance — the field that makes the corpus scientifically usable later
// ---------------------------------------------------------------------------

/**
 * Where a memory came from. This is NOT cosmetic: it separates what a real human
 * told us from what a language model made up while playing them. Losing this
 * distinction silently poisons both the twin and any model trained on the corpus.
 */
export const provenance = v.union(
  v.literal('interview'), // stated by the real user during onboarding
  v.literal('simulated'), // happened in-world to the twin
  v.literal('reflection'), // model-derived higher-order belief
  v.literal('intervention'), // a human god-moded this; strongest available signal
  v.literal('seed'), // synthetic GSS-derived population NPC
);
export type Provenance = typeof provenance.type;

export const memoryData = v.union(
  v.object({ type: v.literal('relationship'), playerId }),
  v.object({
    type: v.literal('conversation'),
    conversationId,
    playerIds: v.array(playerId),
  }),
  v.object({ type: v.literal('reflection'), relatedMemoryIds: v.array(v.id('memories')) }),
  // --- Gatherville additions ---
  v.object({
    type: v.literal('identity'),
    // Which interview question/segment produced this.
    segment: v.string(),
  }),
  v.object({
    type: v.literal('observation'),
    // Free-form world event the twin witnessed.
    kind: v.string(),
  }),
  v.object({
    type: v.literal('correction'),
    // A human said the twin got something wrong about the person it represents.
    correctsMemoryId: v.optional(v.id('memories')),
  }),
);

export const memoryFields = {
  playerId,
  twinId: v.optional(v.id('twins')),
  description: v.string(),
  embeddingId: v.id('memoryEmbeddings'),
  importance: v.number(),
  /** Retrieval never scores this memory below the floor. See constants.ts. */
  importanceFloor: v.optional(v.number()),
  lastAccess: v.number(),
  provenance,
  data: memoryData,
};

export const memoryTables = {
  memories: defineTable(memoryFields)
    .index('embeddingId', ['embeddingId'])
    .index('playerId_type', ['playerId', 'data.type'])
    .index('playerId_provenance', ['playerId', 'provenance'])
    .index('playerId', ['playerId']),
  memoryEmbeddings: defineTable({
    playerId,
    embedding: v.array(v.float64()),
  }).vectorIndex('embedding', {
    vectorField: 'embedding',
    filterFields: ['playerId'],
    dimensions: EMBEDDING_DIMENSION,
  }),
};

// ---------------------------------------------------------------------------
// Twins — the person behind the sprite
// ---------------------------------------------------------------------------

export const twinTables = {
  twins: defineTable({
    userId: v.string(),
    /**
     * The browser uuid this twin was created under, kept when an account
     * claims it.
     *
     * Claiming rewrites userId to the Google subject, which made the twin
     * UNREACHABLE whenever the token lapsed: a Google ID token lasts an hour
     * and is not silently renewed, so the client falls back to the browser id
     * — and that id no longer matched anything. The twin vanished from the UI
     * an hour after being claimed, taking the follow camera with it. Keeping
     * the old id restores exactly the lookup that worked before claiming; it
     * grants no access that the browser did not already have.
     */
    localUserId: v.optional(v.string()),
    playerId: v.optional(playerId),
    worldId: v.optional(v.id('worlds')),
    /** Stable identity facts. Small, and always in the CACHED prompt prefix. */
    scratch: v.object({
      firstName: v.string(),
      lastName: v.optional(v.string()),
      age: v.optional(v.number()),
      location: v.optional(v.string()),
      occupation: v.optional(v.string()),
      household: v.optional(v.string()),
      extra: v.optional(v.record(v.string(), v.string())),
    }),
    /**
     * Digest of the cached prefix (scratch + core reflections). Changing this
     * invalidates the prompt cache for every subsequent decision, so it is
     * versioned explicitly rather than recomputed per request.
     */
    prefixVersion: v.number(),
    prefixDigest: v.string(),
    interviewId: v.optional(v.id('interviews')),
    modelVersion: v.string(),
    createdAt: v.number(),
  })
    .index('userId', ['userId'])
    .index('localUserId', ['localUserId'])
    .index('playerId', ['playerId']),

  interviews: defineTable({
    userId: v.string(),
    audioStorageId: v.optional(v.id('_storage')),
    transcript: v.string(),
    protocolVersion: v.string(),
    completedAt: v.optional(v.number()),
  }).index('userId', ['userId']),

  /** Holdout questions — the scorecard, and the honesty check on the whole product. */
  holdouts: defineTable({
    twinId: v.id('twins'),
    domain: v.string(),
    question: v.string(),
    kind: v.union(v.literal('categorical'), v.literal('numeric'), v.literal('open')),
    options: v.optional(v.array(v.string())),
    /** numeric only — genagents' `float_resp`. Controls int vs float in the template. */
    floatResp: v.optional(v.boolean()),
    userAnswer: v.optional(v.string()),
    twinAnswer: v.optional(v.string()),
    agreed: v.optional(v.boolean()),
  }).index('twinId', ['twinId']),
};

// ---------------------------------------------------------------------------
// Cadence — how 24/7 stays affordable
// ---------------------------------------------------------------------------

export const cadenceTables = {
  twinCadence: defineTable({
    twinId: v.id('twins'),
    playerId,
    tier: v.union(
      v.literal('observed'),
      v.literal('active'),
      v.literal('ambient'),
      v.literal('dormant'),
    ),
    /** Set by the engine; a decision is skipped entirely until now >= this. */
    nextDecisionAt: v.number(),
    watcherCount: v.number(),
    lastWatchedAt: v.optional(v.number()),
    /** Rolling hourly counter for the MAX_DECISIONS_PER_HOUR fuse. */
    hourStartedAt: v.number(),
    decisionsThisHour: v.number(),
  })
    .index('twinId', ['twinId'])
    .index('playerId', ['playerId'])
    .index('nextDecisionAt', ['nextDecisionAt']),
};

// ---------------------------------------------------------------------------
// Traces — the RL corpus
// ---------------------------------------------------------------------------

/**
 * Append-only. Never mutated after write except to flip `exported`.
 *
 * WARNING: upstream `convex/crons.ts` vacuums old rows from several tables.
 * Traces must be exported to object storage before they age out — see
 * traces.ts `exportPendingTraces` and the TRACE_VACUUM_GUARD_MS check.
 */
export const traceTables = {
  traces: defineTable({
    twinId: v.id('twins'),
    playerId,
    worldId: v.id('worlds'),
    ts: v.number(),
    seq: v.number(),

    kind: v.union(
      v.literal('decision'), // twin chose an action
      v.literal('utterance'), // twin said something
      v.literal('intervention'), // a human overrode the twin
      v.literal('outcome'), // what resulted (for credit assignment)
      v.literal('prediction'), // holdout scoring answer
    ),

    /** The situation the twin was in. Serialized, self-contained, replayable. */
    observation: v.string(),
    /** Options the twin was choosing between, when the action space was discrete. */
    candidates: v.optional(v.array(v.string())),
    /** What it did. */
    action: v.string(),
    /** Model-stated reasoning, when the model surfaced any. */
    rationale: v.optional(v.string()),

    /**
     * Set on an `intervention` row: the id of the `decision` trace it replaced.
     * A (decision, intervention) pair IS a preference pair — chosen vs rejected —
     * which is exactly the shape DPO-style training wants. This link is the whole
     * reason god mode is worth building beyond the demo value.
     */
    overrides: v.optional(v.id('traces')),
    /** Who intervened. Null for autonomous decisions. */
    actor: v.optional(v.string()),

    model: v.optional(v.string()),
    effort: v.optional(v.string()),
    /** Digest of the cached prefix used, for grouping traces by identity version. */
    prefixDigest: v.optional(v.string()),
    tokens: v.optional(
      v.object({
        cacheRead: v.number(),
        cacheWrite: v.number(),
        input: v.number(),
        output: v.number(),
      }),
    ),
    costMicros: v.optional(v.number()),

    exported: v.boolean(),
  })
    .index('twinId_seq', ['twinId', 'seq'])
    .index('exported_ts', ['exported', 'ts'])
    .index('overrides', ['overrides']),
};

/**
 * In-flight Batch API submissions for reflection.
 *
 * Needed because batch results come back with only a `custom_id` — we have to
 * remember which source memories each request was built from in order to write
 * `relatedMemoryIds` on the resulting reflection.
 */
export const batchTables = {
  reflectionBatches: defineTable({
    batchId: v.string(),
    /** customId -> source memory ids */
    sourceMap: v.any(),
    createdAt: v.number(),
    collectedAt: v.optional(v.number()),
  }).index('batchId', ['batchId']),
};

export const gathervilleTables = {
  ...memoryTables,
  ...twinTables,
  ...cadenceTables,
  ...traceTables,
  ...batchTables,
  embeddingsCache: defineTable({
    textHash: v.bytes(),
    embedding: v.array(v.float64()),
  }).index('text', ['textHash']),
};
