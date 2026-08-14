// Unified memory stream.
//
// This is a port of `genagents/modules/memory_stream.py`. It replaces upstream
// ai-town's `convex/agent/memory.ts`. Fidelity notes are inline; the full read is
// in docs/GENAGENTS-ANALYSIS.md and the deviation register is in docs/FIDELITY.md.
//
// Ported faithfully:
//   - retrieval scoring: hp = [recency 0, relevance 1, importance 0.5]
//   - per-component normalization to [0,1] across the candidate set, incl. the
//     degenerate range==0 -> 0.5 case
//   - recency decay 0.99 over `last_retrieved` (inert by default; see below)
//   - final ordering by `created` ASCENDING
//   - importance on a 0-100 scale
//
// Deliberately NOT ported (upstream bugs — GENAGENTS-ANALYSIS.md §2.3, §1):
//   - `retrieved_time_step` typo that leaves `last_retrieved` permanently unwritten
//   - `reflect()` passing time_step positionally into reflection_count

import { v } from 'convex/values';
import { internalMutation, internalQuery, ActionCtx, MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { Doc, Id } from '../_generated/dataModel';
import { playerId as playerIdValidator } from '../aiTown/ids';
import {
  RETRIEVAL_N_COUNT,
  IMPORTANCE_MAX,
  MEMORY_ACCESS_THROTTLE,
  VECTOR_SEARCH_MAX,
} from './constants';
import { rankMemories, effectiveImportance, type Scored } from './scoring';
import type { Provenance } from './schema';

export type Memory = Doc<'memories'>;
export type ScoredMemory = Scored<Memory>;

// Scoring primitives live in ./scoring.ts — deliberately Convex-free so the
// offline conformance harness can diff them against the Python original.
// Re-exported here so existing call sites keep working.
export {
  normalizeToUnit,
  extractRecency,
  effectiveImportance,
  rankMemories,
} from './scoring';

// ---------------------------------------------------------------------------
// Convex surface
// ---------------------------------------------------------------------------

/**
 * Retrieve memories for a focal point. Runs in an action because it needs
 * `ctx.vectorSearch`.
 *
 * @param overFetch multiplier on nCount for the vector prefilter. Higher =
 *        closer to upstream's "score everything" behaviour, at more read cost.
 */
export async function retrieveMemories(
  ctx: ActionCtx,
  playerId: string,
  focalEmbedding: number[],
  nCount: number = RETRIEVAL_N_COUNT,
  overFetch = 3,
): Promise<ScoredMemory[]> {
  // Convex caps vector queries at 256 results — a hard platform limit, not a
  // tunable. This bounds how faithful we can be: genagents scores relevance
  // over the ENTIRE memory stream, so our ranking matches only while the
  // candidate set is a superset of what upstream would have ranked. Once a twin
  // exceeds 256 memories, exact rank-equivalence is permanently impossible and
  // we are approximating. Documented rather than hidden — see FIDELITY.md.
  const requested = nCount * overFetch;
  const limit = Math.min(requested, VECTOR_SEARCH_MAX);
  if (requested > VECTOR_SEARCH_MAX) {
    console.warn(
      `[gatherville] vector over-fetch clamped ${requested} -> ${VECTOR_SEARCH_MAX} ` +
        `(nCount=${nCount}). Effective over-fetch is now ` +
        `${(VECTOR_SEARCH_MAX / nCount).toFixed(1)}x.`,
    );
  }

  const hits = await ctx.vectorSearch('memoryEmbeddings', 'embedding', {
    vector: focalEmbedding,
    filter: (q) => q.eq('playerId', playerId),
    limit,
  });
  if (hits.length === 0) return [];

  const memories = await ctx.runQuery(internal.gatherville.memory.loadByEmbeddingIds, {
    embeddingIds: hits.map((h) => h._id),
  });

  // Convex returns hits ordered by score; realign similarity to memory order.
  const scoreByEmbeddingId = new Map(hits.map((h) => [h._id, h._score]));
  const relevance = memories.map((m) => scoreByEmbeddingId.get(m.embeddingId) ?? 0);

  const ranked = rankMemories(memories, relevance, nCount);

  await ctx.runMutation(internal.gatherville.memory.touchMemories, {
    memoryIds: ranked.map((r) => r.memory._id),
  });

  return ranked;
}

export const loadByEmbeddingIds = internalQuery({
  args: { embeddingIds: v.array(v.id('memoryEmbeddings')) },
  handler: async (ctx, { embeddingIds }): Promise<Memory[]> => {
    const out: Memory[] = [];
    for (const embeddingId of embeddingIds) {
      const memory = await ctx.db
        .query('memories')
        .withIndex('embeddingId', (q) => q.eq('embeddingId', embeddingId))
        .first();
      if (memory) out.push(memory);
    }
    return out;
  },
});

/**
 * Updates `lastAccess`, throttled.
 *
 * genagents intends this (`retrieve(..., stateless=False)`) but the write lands
 * on a misspelled attribute, so `last_retrieved` is never updated upstream. We
 * write the field it meant to write. This only becomes observable if
 * RETRIEVAL_WEIGHTS.recency is raised above 0 — flagged so an A/B on recency is
 * measuring recency, not a latent upstream bug.
 */
export const touchMemories = internalMutation({
  args: { memoryIds: v.array(v.id('memories')) },
  handler: async (ctx, { memoryIds }) => {
    const now = Date.now();
    for (const id of memoryIds) {
      const memory = await ctx.db.get(id);
      if (memory && memory.lastAccess < now - MEMORY_ACCESS_THROTTLE) {
        await ctx.db.patch(id, { lastAccess: now });
      }
    }
  },
});

/** Anchor-independent core identity set — the cacheable half of the prompt. */
export const coreIdentitySet = internalQuery({
  args: { playerId: playerIdValidator, limit: v.number() },
  handler: async (ctx, { playerId, limit }): Promise<Memory[]> => {
    const identity = await ctx.db
      .query('memories')
      .withIndex('playerId_provenance', (q) =>
        q.eq('playerId', playerId).eq('provenance', 'interview'),
      )
      .collect();
    const reflections = await ctx.db
      .query('memories')
      .withIndex('playerId_provenance', (q) =>
        q.eq('playerId', playerId).eq('provenance', 'reflection'),
      )
      .collect();

    return [...identity, ...reflections]
      .sort((a, b) => effectiveImportance(b) - effectiveImportance(a))
      .slice(0, limit)
      .sort((a, b) => a._creationTime - b._creationTime);
  },
});

export const insertMemory = internalMutation({
  args: {
    playerId: playerIdValidator,
    twinId: v.optional(v.id('twins')),
    description: v.string(),
    embedding: v.array(v.float64()),
    importance: v.number(),
    importanceFloor: v.optional(v.number()),
    provenance: v.string(),
    data: v.any(),
  },
  handler: async (ctx, args): Promise<Id<'memories'>> => {
    const embeddingId = await ctx.db.insert('memoryEmbeddings', {
      playerId: args.playerId,
      embedding: args.embedding,
    });
    return await ctx.db.insert('memories', {
      playerId: args.playerId,
      twinId: args.twinId,
      description: args.description,
      embeddingId,
      importance: Math.max(0, Math.min(IMPORTANCE_MAX, args.importance)),
      importanceFloor: args.importanceFloor,
      lastAccess: Date.now(),
      provenance: args.provenance as Provenance,
      data: args.data,
    });
  },
});

/** Accumulated importance since the last reflection — the reflection trigger. */
export const importanceSinceLastReflection = internalQuery({
  args: { playerId: playerIdValidator },
  handler: async (ctx, { playerId }): Promise<number> => {
    const lastReflection = await ctx.db
      .query('memories')
      .withIndex('playerId_provenance', (q) =>
        q.eq('playerId', playerId).eq('provenance', 'reflection'),
      )
      .order('desc')
      .first();
    const since = lastReflection?._creationTime ?? 0;

    const recent = await ctx.db
      .query('memories')
      .withIndex('playerId', (q) => q.eq('playerId', playerId))
      .filter((q) => q.gt(q.field('_creationTime'), since))
      .collect();

    return recent.reduce((sum, m) => sum + effectiveImportance(m), 0);
  },
});
