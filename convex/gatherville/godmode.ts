// God mode — human intervention in a running twin.
//
// Two things happen on every intervention, and the second one is the point:
//
//   1. A memory with provenance 'intervention' and an importance floor of 90,
//      so the correction actually changes future behaviour rather than being a
//      one-off puppet-string pull.
//   2. A trace of kind 'intervention' whose `overrides` points at the decision
//      trace it replaced — a preference pair in identical context.
//
// Interventions flow through the SAME input pipeline as agent decisions, so
// nothing downstream needs to know an action was human-authored.

import { v } from 'convex/values';
import { action, internalQuery, query } from '../_generated/server';
import { internal } from '../_generated/api';
import { Id } from '../_generated/dataModel';
import { playerId as playerIdValidator } from '../aiTown/ids';
import { INTERVENTION_IMPORTANCE_FLOOR } from './constants';
import { embed } from './embeddings';

/**
 * Override what a twin is about to do.
 *
 * @param overridesTraceId the `decision` trace being replaced. Required — an
 *        intervention with no linked decision is a puppet-string pull with no
 *        training value, and we'd rather refuse than record a useless row.
 */
export const overrideDecision = action({
  args: {
    twinId: v.id('twins'),
    playerId: playerIdValidator,
    worldId: v.id('worlds'),
    overridesTraceId: v.id('traces'),
    action: v.string(),
    /** Optional note explaining the correction, in the operator's words. */
    note: v.optional(v.string()),
    actor: v.string(),
  },
  handler: async (ctx, args): Promise<{ traceId: Id<'traces'> }> => {
    const original = await ctx.runQuery(internal.gatherville.godmode.loadTrace, {
      traceId: args.overridesTraceId,
    });
    if (!original) throw new Error(`No such trace: ${args.overridesTraceId}`);
    if (original.kind !== 'decision') {
      throw new Error(`Can only override a 'decision' trace, got '${original.kind}'`);
    }

    const traceId: Id<'traces'> = await ctx.runMutation(internal.gatherville.traces.append, {
      twinId: args.twinId,
      playerId: args.playerId,
      worldId: args.worldId,
      kind: 'intervention',
      observation: original.observation,
      candidates: original.candidates,
      action: args.action,
      rationale: args.note,
      overrides: args.overridesTraceId,
      actor: args.actor,
      prefixDigest: original.prefixDigest,
    });

    // The twin should learn from being corrected, not just obey once.
    const description = args.note
      ? `In this situation — ${original.observation} — I chose to ${args.action}. ${args.note}`
      : `In this situation — ${original.observation} — I chose to ${args.action}.`;

    await ctx.runMutation(internal.gatherville.memory.insertMemory, {
      playerId: args.playerId,
      twinId: args.twinId,
      description,
      embedding: await embed(description),
      importance: INTERVENTION_IMPORTANCE_FLOOR,
      importanceFloor: INTERVENTION_IMPORTANCE_FLOOR,
      provenance: 'intervention',
      data: { type: 'correction' },
    });

    return { traceId };
  },
});

/**
 * Correct something the twin believes about the person it represents.
 * Distinct from overriding an action — this edits identity, not behaviour.
 */
export const correctBelief = action({
  args: {
    twinId: v.id('twins'),
    playerId: playerIdValidator,
    correction: v.string(),
    correctsMemoryId: v.optional(v.id('memories')),
    actor: v.string(),
  },
  handler: async (ctx, args): Promise<{ memoryId: Id<'memories'> }> => {
    const memoryId: Id<'memories'> = await ctx.runMutation(
      internal.gatherville.memory.insertMemory,
      {
        playerId: args.playerId,
        twinId: args.twinId,
        description: args.correction,
        embedding: await embed(args.correction),
        importance: INTERVENTION_IMPORTANCE_FLOOR,
        importanceFloor: INTERVENTION_IMPORTANCE_FLOOR,
        provenance: 'intervention',
        data: { type: 'correction', correctsMemoryId: args.correctsMemoryId },
      },
    );
    return { memoryId };
  },
});

// internalQuery, not query: `internal.*` cannot reference a public function.
export const loadTrace = internalQuery({
  args: { traceId: v.id('traces') },
  handler: async (ctx, { traceId }) => await ctx.db.get(traceId),
});

/** Recent decisions for a twin — what the god-mode console renders. */
export const recentDecisions = query({
  args: { twinId: v.id('twins'), limit: v.optional(v.number()) },
  handler: async (ctx, { twinId, limit }) => {
    return await ctx.db
      .query('traces')
      .withIndex('twinId_seq', (q) => q.eq('twinId', twinId))
      .order('desc')
      .filter((q) => q.eq(q.field('kind'), 'decision'))
      .take(limit ?? 25);
  },
});

/** Has this decision already been overridden? Keeps the console idempotent. */
export const overrideFor = query({
  args: { traceId: v.id('traces') },
  handler: async (ctx, { traceId }) => {
    return await ctx.db
      .query('traces')
      .withIndex('overrides', (q) => q.eq('overrides', traceId))
      .first();
  },
});
