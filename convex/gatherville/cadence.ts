// Decision cadence — how a 24/7 simulation stays affordable.
//
// The world never stops. Movement, pathfinding and conversation mechanics are
// deterministic and free (inherited from ai-town's engine). Only LLM decisions
// cost money, so this module — not uptime — is the cost control.
//
// Replaces upstream's `stopInactiveWorlds` cron, which paused worlds after 5
// minutes idle. We never pause; we slow down.

import { v } from 'convex/values';
import { internalMutation, internalQuery, mutation } from '../_generated/server';
import { playerId as playerIdValidator } from '../aiTown/ids';
import {
  CADENCE_MS,
  CadenceTier,
  TIER_AFTER_UNWATCHED,
  ACTIVE_DECAY_MS,
  AMBIENT_DECAY_MS,
  MAX_DECISIONS_PER_HOUR,
} from './constants';

const HOUR_MS = 60 * 60_000;

/**
 * The gate every decision passes through. Returns false and the engine skips
 * the twin entirely — no LLM call, no cost, no trace.
 */
export const mayDecide = internalQuery({
  args: { twinId: v.id('twins'), now: v.number() },
  handler: async (ctx, { twinId, now }): Promise<boolean> => {
    const cadence = await ctx.db
      .query('twinCadence')
      .withIndex('twinId', (q) => q.eq('twinId', twinId))
      .first();
    if (!cadence) return false;
    if (now < cadence.nextDecisionAt) return false;

    // Hourly fuse. Cadence is the dial; this is the thing that turns a runaway
    // loop into a bounded incident instead of an unbounded bill.
    const inCurrentHour = now - cadence.hourStartedAt < HOUR_MS;
    if (inCurrentHour && cadence.decisionsThisHour >= MAX_DECISIONS_PER_HOUR) return false;

    return true;
  },
});

/** Called immediately after a decision is made. Advances the schedule. */
export const recordDecision = internalMutation({
  args: { twinId: v.id('twins'), now: v.number() },
  handler: async (ctx, { twinId, now }) => {
    const cadence = await ctx.db
      .query('twinCadence')
      .withIndex('twinId', (q) => q.eq('twinId', twinId))
      .first();
    if (!cadence) return;

    const rolledOver = now - cadence.hourStartedAt >= HOUR_MS;
    await ctx.db.patch(cadence._id, {
      nextDecisionAt: now + CADENCE_MS[cadence.tier],
      hourStartedAt: rolledOver ? now : cadence.hourStartedAt,
      decisionsThisHour: rolledOver ? 1 : cadence.decisionsThisHour + 1,
    });
  },
});

/**
 * A viewer opened this twin. Jump straight to the fastest tier — the twin
 * should feel alive the moment someone looks at it.
 */
export const attachWatcher = mutation({
  args: { twinId: v.id('twins') },
  handler: async (ctx, { twinId }) => {
    const now = Date.now();
    const cadence = await ctx.db
      .query('twinCadence')
      .withIndex('twinId', (q) => q.eq('twinId', twinId))
      .first();
    if (!cadence) return;
    await ctx.db.patch(cadence._id, {
      tier: 'observed',
      watcherCount: cadence.watcherCount + 1,
      lastWatchedAt: now,
      // Let the twin act immediately rather than waiting out the previous
      // tier's (possibly hour-long) interval.
      nextDecisionAt: Math.min(cadence.nextDecisionAt, now),
    });
  },
});

export const detachWatcher = mutation({
  args: { twinId: v.id('twins') },
  handler: async (ctx, { twinId }) => {
    const now = Date.now();
    const cadence = await ctx.db
      .query('twinCadence')
      .withIndex('twinId', (q) => q.eq('twinId', twinId))
      .first();
    if (!cadence) return;
    const watcherCount = Math.max(0, cadence.watcherCount - 1);
    await ctx.db.patch(cadence._id, {
      watcherCount,
      lastWatchedAt: now,
      tier: watcherCount === 0 ? TIER_AFTER_UNWATCHED : cadence.tier,
    });
  },
});

/**
 * Cron. Decays tiers for twins nobody is watching:
 *   active  --(10 min unwatched)--> ambient
 *   ambient --(6 hr unwatched)----> dormant
 *
 * Twins with a live watcher are never decayed.
 */
export const decayTiers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const all = await ctx.db.query('twinCadence').collect();
    for (const cadence of all) {
      if (cadence.watcherCount > 0) continue;
      const idleFor = now - (cadence.lastWatchedAt ?? cadence.hourStartedAt);

      let next: CadenceTier | null = null;
      if (cadence.tier === 'observed') next = 'active';
      else if (cadence.tier === 'active' && idleFor > ACTIVE_DECAY_MS) next = 'ambient';
      else if (cadence.tier === 'ambient' && idleFor > AMBIENT_DECAY_MS) next = 'dormant';

      if (next) {
        await ctx.db.patch(cadence._id, {
          tier: next,
          // Re-schedule against the NEW, slower interval so the twin doesn't
          // burn a fast-tier decision on the way down.
          nextDecisionAt: now + CADENCE_MS[next],
        });
      }
    }
  },
});

export const initCadence = internalMutation({
  args: { twinId: v.id('twins'), playerId: playerIdValidator, tier: v.optional(v.string()) },
  handler: async (ctx, { twinId, playerId, tier }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query('twinCadence')
      .withIndex('twinId', (q) => q.eq('twinId', twinId))
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert('twinCadence', {
      twinId,
      playerId,
      tier: (tier as CadenceTier) ?? 'ambient',
      nextDecisionAt: now,
      watcherCount: 0,
      hourStartedAt: now,
      decisionsThisHour: 0,
    });
  },
});
