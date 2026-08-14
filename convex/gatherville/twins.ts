// Twin lifecycle: the link between a real person, their behavior model, and a
// sprite in the world.

import { v } from 'convex/values';
import { action, internalMutation, internalQuery, query } from '../_generated/server';
import { Doc, Id } from '../_generated/dataModel';
import { playerId as playerIdValidator } from '../aiTown/ids';
import { prefixDigest, renderScratch, SIMULATION_RULES, Scratch } from './prompt';
import { internalAction } from '../_generated/server';
import { api, internal } from '../_generated/api';
import { insertInput } from '../aiTown/insertInput';
import { ENGINE_ACTION_DURATION } from '../constants';

/**
 * Hot path — called from `agentDoSomething` on every decision attempt.
 * Returns null for population NPCs, which have no twin and fall through to
 * upstream's random behaviour.
 */
export const byPlayerId = internalQuery({
  args: { playerId: playerIdValidator },
  handler: async (ctx, { playerId }): Promise<Doc<'twins'> | null> => {
    return await ctx.db
      .query('twins')
      .withIndex('playerId', (q) => q.eq('playerId', playerId))
      .first();
  },
});

export const byId = query({
  args: { twinId: v.id('twins') },
  handler: async (ctx, { twinId }): Promise<Doc<'twins'> | null> => await ctx.db.get(twinId),
});

export const byUserId = query({
  args: { userId: v.string() },
  handler: async (ctx, { userId }): Promise<Doc<'twins'> | null> => {
    return await ctx.db
      .query('twins')
      .withIndex('userId', (q) => q.eq('userId', userId))
      .first();
  },
});

/**
 * The caller's twin: account first, browser second.
 *
 * The UI used to pick the key itself — `me ? me.subject : localId` — which
 * meant signing in SWITCHED which key was used, and a lapsed token switched it
 * back to one that no longer matched a claimed twin. Deciding here, where both
 * facts are available, removes that whole class of mismatch.
 */
export const mine = query({
  args: { localUserId: v.optional(v.string()) },
  handler: async (ctx, { localUserId }): Promise<Doc<'twins'> | null> => {
    const id = await ctx.auth.getUserIdentity();
    if (id) {
      const owned = await ctx.db
        .query('twins')
        .withIndex('userId', (q) => q.eq('userId', id.subject))
        .first();
      if (owned) return owned;
    }
    if (!localUserId) return null;
    // Unclaimed: still keyed by the browser uuid.
    const unclaimed = await ctx.db
      .query('twins')
      .withIndex('userId', (q) => q.eq('userId', localUserId))
      .first();
    if (unclaimed) return unclaimed;
    // Claimed by an account, but the token has lapsed — this is the path that
    // used to return nothing and hide the twin.
    return await ctx.db
      .query('twins')
      .withIndex('localUserId', (q) => q.eq('localUserId', localUserId))
      .first();
  },
});

export const create = internalMutation({
  args: {
    userId: v.string(),
    interviewId: v.optional(v.id('interviews')),
    scratch: v.any(),
    modelVersion: v.string(),
  },
  handler: async (ctx, args): Promise<Id<'twins'>> => {
    // The digest is computed from the same rules + scratch text that will sit
    // above the cache breakpoint. Core identity memories are appended later and
    // bump prefixVersion — see `bumpPrefix`.
    const seed = `${SIMULATION_RULES}\n\nSelf description: ${renderScratch(
      args.scratch as Scratch,
    )}\n`;
    return await ctx.db.insert('twins', {
      userId: args.userId,
      interviewId: args.interviewId,
      scratch: args.scratch,
      prefixVersion: 1,
      prefixDigest: prefixDigest(seed),
      modelVersion: args.modelVersion,
      createdAt: Date.now(),
    });
  },
});

/** Bind a twin to a sprite, and start its clock. */
export const attachToWorld = internalMutation({
  args: { twinId: v.id('twins'), worldId: v.id('worlds'), playerId: playerIdValidator },
  handler: async (ctx, { twinId, worldId, playerId }) => {
    await ctx.db.patch(twinId, { worldId, playerId });
    const existing = await ctx.db
      .query('twinCadence')
      .withIndex('twinId', (q) => q.eq('twinId', twinId))
      .first();
    if (existing) return;
    const now = Date.now();
    await ctx.db.insert('twinCadence', {
      twinId,
      playerId,
      // New twins start fast — the user just built this and is watching.
      tier: 'observed',
      nextDecisionAt: now,
      watcherCount: 0,
      hourStartedAt: now,
      decisionsThisHour: 0,
    });
  },
});

/**
 * Record that the cached prefix changed.
 *
 * Call this whenever the core identity set materially changes (new reflections,
 * scratch edits). It is deliberately explicit rather than recomputed per
 * request: silent prefix churn destroys the cache hit rate, and we would rather
 * see an intentional version bump in the traces than discover a drifting digest
 * in a cost report.
 */
export const bumpPrefix = internalMutation({
  args: { twinId: v.id('twins'), newDigest: v.string() },
  handler: async (ctx, { twinId, newDigest }) => {
    const twin = await ctx.db.get(twinId);
    if (!twin || twin.prefixDigest === newDigest) return;
    await ctx.db.patch(twinId, {
      prefixDigest: newDigest,
      prefixVersion: twin.prefixVersion + 1,
    });
  },
});

// ---------------------------------------------------------------------------
// Placing a life in the world
// ---------------------------------------------------------------------------
//
// This lived in seed.ts, which meant only the CLI seeding path ever ran it —
// the browser onboarding built a life with memories and a scorecard and then
// left it bodiless, with its memories still keyed to a placeholder player id.
// Both paths now call `placeInWorld`, so there is one way for a life to enter
// the town and it is exercised by the real flow.

/**
 * Spawn a player + agent for a twin through the engine's input pipeline, then
 * wait for the engine to process it.
 *
 * The engine owns `world.players`; writing to it directly would break the
 * single-step guarantee, so we submit an input and poll for the result.
 */
export const spawnTwinBody = internalAction({
  args: { twinId: v.id('twins') },
  handler: async (ctx, { twinId }): Promise<{ worldId: Id<'worlds'>; playerId: string } | null> => {
    const twin = await ctx.runQuery(internal.gatherville.interview.getTwin, { twinId });
    if (!twin) return null;

    const worldStatus = await ctx.runQuery(internal.gatherville.twins.defaultWorld, {});
    if (!worldStatus) throw new Error('No default world — run `npx convex run init` first');

    const scratch = twin.scratch as {
      firstName: string; lastName?: string; age?: number;
      occupation?: string; location?: string;
    };
    const name = [scratch.firstName, scratch.lastName].filter(Boolean).join(' ') || scratch.firstName;

    // Identity from the interview, not invented. Kept factual — anything
    // characterful here would be a persona we made up.
    const identity = [
      name,
      scratch.age !== undefined ? `${scratch.age}` : null,
      scratch.occupation ? `a ${scratch.occupation}` : null,
      scratch.location ? `in ${scratch.location}` : null,
    ].filter(Boolean).join(', ') + '.';

    // Wake the target world first. The spawn goes through the engine's input
    // queue, and an unwatched city gets paused by `stopInactiveWorlds` — the
    // input then sits unprocessed, the poll below times out, and the life ends
    // up bodiless. Nobody is looking at the city during onboarding, so the
    // paused case is the NORMAL one, not an edge.
    await ctx.runMutation(internal.gatherville.twins.resumeWorldEngine, {
      worldId: worldStatus.worldId,
    });

    await ctx.runMutation(internal.gatherville.twins.submitCreateTwin, {
      worldId: worldStatus.worldId,
      name,
      // Sprite only — carries no personality.
      character: `f${(Math.floor(Math.random() * 8) + 1)}`,
      identity,
    });

    // The engine steps once per second; poll rather than assume.
    for (let i = 0; i < 20; i++) {
      const found = await ctx.runQuery(internal.gatherville.twins.playerByName, {
        worldId: worldStatus.worldId,
        name,
      });
      if (found) return { worldId: worldStatus.worldId, playerId: found };
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  },
});

/**
 * Where a new twin's body goes.
 *
 * This used to return whichever world has `isDefault: true`, which is
 * Gatherville's. Siliconville runs in a second world deliberately marked
 * non-default so the old front page kept pointing at its own — with the
 * consequence that every twin built from an interview was spawned into the
 * 64x48 town at /gatherville while the page that invited them showed a city
 * they were not in. The pipeline was connected; it was connected to the wrong
 * city.
 *
 * Siliconville is preferred when it exists, identified by its map's tileSetUrl
 * the same way convex/siliconville.ts finds it. Falls back to the default
 * world, so a deployment that has never run siliconville:init still works.
 */
export const defaultWorld = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ worldId: Id<'worlds'> } | null> => {
    const siliconvilleMap = await ctx.db
      .query('maps')
      .filter((q) => q.eq(q.field('tileSetUrl'), '/assets/siliconville.png'))
      .first();
    if (siliconvilleMap) {
      const ws = await ctx.db
        .query('worldStatus')
        .withIndex('worldId', (q) => q.eq('worldId', siliconvilleMap.worldId))
        .unique();
      if (ws) return { worldId: ws.worldId };
    }
    const fallback = await ctx.db
      .query('worldStatus')
      .filter((q) => q.eq(q.field('isDefault'), true))
      .unique();
    return fallback ? { worldId: fallback.worldId } : null;
  },
});

export const submitCreateTwin = internalMutation({
  args: {
    worldId: v.id('worlds'),
    name: v.string(),
    character: v.string(),
    identity: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    // Static import: Convex mutations run in a V8 isolate with no dynamic
    // import support ("dynamic module import unsupported"). Actions tolerate it;
    // mutations do not.
    await insertInput(ctx as never, args.worldId, 'createTwinAgent' as never, {
      name: args.name,
      character: args.character,
      identity: args.identity,
    } as never);
  },
});

export const playerByName = internalQuery({
  args: { worldId: v.id('worlds'), name: v.string() },
  handler: async (ctx, { worldId, name }): Promise<string | null> => {
    const desc = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', worldId))
      .filter((q) => q.eq(q.field('name'), name))
      .first();
    return desc?.playerId ?? null;
  },
});

/**
 * Give a life a body and rebind its memories to the real player id.
 *
 * Interview memories are written before a player exists, under
 * `interview:<twinId>`. Until they are rebound, every retrieval for the real
 * player returns nothing — the life is in the town but remembers none of its
 * own interview.
 */
export const placeInWorld = internalAction({
  args: { twinId: v.id('twins') },
  handler: async (ctx, { twinId }): Promise<{ playerId: string } | null> => {
    const existing: Doc<'twins'> | null = await ctx.runQuery(
      internal.gatherville.interview.getTwin,
      { twinId },
    );
    if (!existing) return null;
    if (existing.playerId) return { playerId: existing.playerId };

    const body = await ctx.runAction(internal.gatherville.twins.spawnTwinBody, { twinId });
    if (!body) return null;

    await ctx.runMutation(internal.gatherville.twins.attachToWorld, {
      twinId,
      worldId: body.worldId,
      playerId: body.playerId,
    });
    await ctx.runMutation(internal.gatherville.interview.rebindMemories, {
      twinId,
      playerId: body.playerId,
    });
    return { playerId: body.playerId };
  },
});

/**
 * Resume a world's engine if the inactivity cron paused it.
 *
 * Mirrors siliconville.heartbeat: `restartDeadWorlds` deliberately refuses to
 * revive anything not already 'running', so something with a reason to need
 * the engine must do the reviving. 'stoppedByDeveloper' is left alone — that
 * is somebody holding the world still on purpose.
 */
export const resumeWorldEngine = internalMutation({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, { worldId }) => {
    const ws = await ctx.db
      .query('worldStatus')
      .withIndex('worldId', (q) => q.eq('worldId', worldId))
      .unique();
    if (!ws || ws.status !== 'inactive') return;
    const engine = (await ctx.db.get(ws.engineId))!;
    const generationNumber = engine.generationNumber + 1;
    await ctx.db.patch(ws._id, { status: 'running', lastViewed: Date.now() });
    await ctx.db.patch(ws.engineId, { running: true, generationNumber });
    await ctx.scheduler.runAfter(0, internal.aiTown.main.runStep, {
      worldId,
      generationNumber,
      maxDuration: ENGINE_ACTION_DURATION,
    });
  },
});

/**
 * Give the caller's twin a body if placement never happened.
 *
 * Placement runs once, inside onboarding, and its failure is survivable on
 * purpose — the scorecard must not be hostage to the town. But a failure there
 * used to be permanent: the life showed up in the population count and nowhere
 * on the map, with nothing anywhere to retry it. The city page calls this when
 * it sees a twin without a playerId, so a bodiless life heals on the next
 * visit instead of staying broken forever.
 */
export const ensureBody = action({
  args: { localUserId: v.optional(v.string()) },
  handler: async (ctx, { localUserId }): Promise<{ playerId: string } | null> => {
    // Same resolution as twins.mine — account first, browser second — and run
    // as a query from here so the auth context carries over.
    const twin: Doc<'twins'> | null = await ctx.runQuery(api.gatherville.twins.mine, {
      localUserId,
    });
    if (!twin) return null;
    if (twin.playerId) return { playerId: twin.playerId };
    return await ctx.runAction(internal.gatherville.twins.placeInWorld, { twinId: twin._id });
  },
});

/**
 * Delete a twin and everything that hangs off it.
 *
 * Test twins are unavoidable — you cannot verify the onboarding pipeline
 * without running it — and a half-deleted one is worse than none: memories
 * outlive their twin and still surface in retrieval, embeddings keep occupying
 * the vector index, and the body keeps walking around the city as a resident
 * nobody signed up to be.
 *
 * Memories are keyed by playerId rather than twinId (retrieval's hot path is
 * per-player), so both are swept — a twin that never got a body has memories
 * under `interview:<twinId>` from before rebinding.
 */
export const purgeTwin = internalMutation({
  args: { twinId: v.id('twins') },
  handler: async (ctx, { twinId }) => {
    const twin = await ctx.db.get(twinId);
    if (!twin) return { deleted: false };

    const playerKeys = [twin.playerId, `interview:${twinId}`].filter(Boolean) as string[];
    let memories = 0;
    let embeddings = 0;
    for (const key of playerKeys) {
      const rows = await ctx.db
        .query('memories')
        .withIndex('playerId', (q) => q.eq('playerId', key as never))
        .collect();
      for (const m of rows) {
        // The embedding first: a memory row is how you find it, so deleting
        // that first would strand the vector with nothing pointing at it.
        await ctx.db.delete(m.embeddingId);
        embeddings++;
        await ctx.db.delete(m._id);
        memories++;
      }
    }

    let holdouts = 0;
    for (const h of await ctx.db
      .query('holdouts')
      .withIndex('twinId', (q) => q.eq('twinId', twinId))
      .collect()) {
      await ctx.db.delete(h._id);
      holdouts++;
    }

    let interviews = 0;
    for (const i of await ctx.db
      .query('interviews')
      .withIndex('userId', (q) => q.eq('userId', twin.userId))
      .collect()) {
      await ctx.db.delete(i._id);
      interviews++;
    }

    // Traces have no twinId index; this table is small at demo scale and the
    // alternative is leaving spend records pointing at a twin that is gone.
    let traces = 0;
    for (const t of await ctx.db.query('traces').collect()) {
      if (t.twinId === twinId) {
        await ctx.db.delete(t._id);
        traces++;
      }
    }

    // The body last, and via the engine's input queue rather than by patching
    // the world document — the engine holds world state in memory and would
    // write our edit straight back out.
    if (twin.playerId && twin.worldId) {
      await insertInput(ctx as never, twin.worldId, 'leave' as never, {
        playerId: twin.playerId,
      } as never);
    }

    await ctx.db.delete(twinId);
    return { deleted: true, memories, embeddings, holdouts, interviews, traces };
  },
});
