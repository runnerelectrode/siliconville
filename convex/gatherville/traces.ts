// Append-only trace log — the RL corpus.
//
// ⚠️ Upstream ai-town's `convex/crons.ts` vacuums `memories`, `memoryEmbeddings`
// and `inputs` on a schedule. Left unmodified it would quietly eat this corpus.
// Export runs ahead of vacuum, and `vacuumGuard` refuses to drop unexported
// traces newer than TRACE_VACUUM_GUARD_MS.
//
// Rows are NEVER mutated after insert, except to flip `exported`.

import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery, query } from '../_generated/server';
import { internal } from '../_generated/api';
import { Doc, Id } from '../_generated/dataModel';
import { playerId as playerIdValidator } from '../aiTown/ids';
import { TRACE_EXPORT_BATCH_SIZE, TRACE_VACUUM_GUARD_MS } from './constants';

export type Trace = Doc<'traces'>;

export const append = internalMutation({
  args: {
    twinId: v.id('twins'),
    playerId: playerIdValidator,
    worldId: v.id('worlds'),
    kind: v.string(),
    observation: v.string(),
    candidates: v.optional(v.array(v.string())),
    action: v.string(),
    rationale: v.optional(v.string()),
    overrides: v.optional(v.id('traces')),
    actor: v.optional(v.string()),
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
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
  },
  handler: async (ctx, args): Promise<Id<'traces'>> => {
    // Per-twin monotonic sequence, so an exported corpus can be ordered without
    // relying on wall-clock timestamps (which collide under batching).
    const last = await ctx.db
      .query('traces')
      .withIndex('twinId_seq', (q) => q.eq('twinId', args.twinId))
      .order('desc')
      .first();

    return await ctx.db.insert('traces', {
      ...args,
      kind: args.kind as Trace['kind'],
      ts: Date.now(),
      seq: (last?.seq ?? 0) + 1,
      exported: false,
    });
  },
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const pendingExport = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }): Promise<Trace[]> => {
    return await ctx.db
      .query('traces')
      .withIndex('exported_ts', (q) => q.eq('exported', false))
      .order('asc')
      .take(limit);
  },
});

export const markExported = internalMutation({
  args: { traceIds: v.array(v.id('traces')) },
  handler: async (ctx, { traceIds }) => {
    for (const id of traceIds) await ctx.db.patch(id, { exported: true });
  },
});

/**
 * Cron. Writes pending traces to object storage as JSONL and marks them
 * exported. This is what `training/export/` reads.
 */
export const exportPendingTraces = internalAction({
  args: {},
  handler: async (ctx): Promise<{ exported: number }> => {
    const traces = await ctx.runQuery(internal.gatherville.traces.pendingExport, {
      limit: TRACE_EXPORT_BATCH_SIZE,
    });
    if (traces.length === 0) return { exported: 0 };

    const jsonl = traces.map((t) => JSON.stringify(t)).join('\n');
    await ctx.storage.store(new Blob([jsonl], { type: 'application/x-ndjson' }));

    await ctx.runMutation(internal.gatherville.traces.markExported, {
      traceIds: traces.map((t) => t._id),
    });
    return { exported: traces.length };
  },
});

/**
 * Guard for the vacuum cron. Returns true only when it is safe to drop traces
 * older than `before` — i.e. nothing unexported is at risk.
 */
export const vacuumGuard = internalQuery({
  args: { before: v.number() },
  handler: async (ctx, { before }): Promise<boolean> => {
    const cutoff = Math.min(before, Date.now() - TRACE_VACUUM_GUARD_MS);
    const unexported = await ctx.db
      .query('traces')
      .withIndex('exported_ts', (q) => q.eq('exported', false).lt('ts', cutoff))
      .first();
    return unexported === null;
  },
});

// ---------------------------------------------------------------------------
// Preference pairs — the reason god mode exists
// ---------------------------------------------------------------------------

export type PreferencePair = {
  observation: string;
  candidates?: string[];
  rejected: string; // what the twin chose
  chosen: string; // what the human chose instead
  rejectedRationale?: string;
  actor?: string;
  twinId: Id<'twins'>;
  prefixDigest?: string;
  ts: number;
};

/**
 * Every `(decision, intervention)` pair is a preference pair in identical
 * context: the twin's action is `rejected`, the human's is `chosen`. That is
 * exactly the shape preference-optimization training wants, and it is why
 * interventions are recorded as linked traces rather than as plain edits.
 */
export const preferencePairs = query({
  args: { since: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, { since, limit }): Promise<PreferencePair[]> => {
    const interventions = await ctx.db
      .query('traces')
      .withIndex('exported_ts')
      .filter((q) =>
        q.and(q.eq(q.field('kind'), 'intervention'), q.gte(q.field('ts'), since ?? 0)),
      )
      .take(limit ?? 500);

    const pairs: PreferencePair[] = [];
    for (const intervention of interventions) {
      if (!intervention.overrides) continue;
      const decision = await ctx.db.get(intervention.overrides);
      if (!decision) continue;
      pairs.push({
        observation: decision.observation,
        candidates: decision.candidates,
        rejected: decision.action,
        chosen: intervention.action,
        rejectedRationale: decision.rationale,
        actor: intervention.actor,
        twinId: intervention.twinId,
        prefixDigest: decision.prefixDigest,
        ts: intervention.ts,
      });
    }
    return pairs;
  },
});

/** Spend attribution — the number that tells you whether 24/7 is working. */
export const spendByTwin = query({
  args: { twinId: v.id('twins'), since: v.number() },
  handler: async (ctx, { twinId, since }) => {
    const traces = await ctx.db
      .query('traces')
      .withIndex('twinId_seq', (q) => q.eq('twinId', twinId))
      .filter((q) => q.gte(q.field('ts'), since))
      .collect();

    let costMicros = 0;
    let decisions = 0;
    let cacheReadTokens = 0;
    let uncachedInputTokens = 0;
    for (const t of traces) {
      costMicros += t.costMicros ?? 0;
      if (t.kind === 'decision') decisions++;
      cacheReadTokens += t.tokens?.cacheRead ?? 0;
      uncachedInputTokens += t.tokens?.input ?? 0;
    }
    const totalInput = cacheReadTokens + uncachedInputTokens;
    return {
      costMicros,
      decisions,
      // If this drops, the cached prefix is churning — the single most
      // expensive silent failure in the system.
      cacheHitRate: totalInput === 0 ? 0 : cacheReadTokens / totalInput,
    };
  },
});
