// A second world, running the Siliconville map.
//
// The front page's world is found by `isDefault: true`, and there is only one
// of those. Rather than add a name column to worldStatus and migrate it, this
// world is identified by the one thing already unique to it: its map's
// tileSetUrl. The maps table holds one row per world and is indexed by
// worldId, so the lookup is a single scan of a table with a handful of rows.
//
// Everything else is the ai-town engine unchanged. The agents walk the SAME
// tile grid the 3D view is generated from — data/siliconville.js is emitted by
// the same generator as data/siliconville3d.js — so a player standing at tile
// (x, y) in the simulation is standing at that spot in the city, and the
// renderer needs no reconciliation.

import { v } from 'convex/values';
import { internal } from './_generated/api';
import { MutationCtx, QueryCtx, internalMutation, mutation, query } from './_generated/server';
import { Id } from './_generated/dataModel';
import * as map from '../data/siliconville';
import { createEngine } from './aiTown/main';
import { insertInput } from './aiTown/insertInput';
import { ENGINE_ACTION_DURATION, IDLE_WORLD_TIMEOUT } from './constants';

const TILESET = '/assets/siliconville.png';

// Takes either context: the query reads it, the mutation writes through it.
async function findWorld(ctx: QueryCtx | MutationCtx) {
  const m = await ctx.db
    .query('maps')
    .filter((q) => q.eq(q.field('tileSetUrl'), TILESET))
    .first();
  if (!m) return null;
  const worldStatus = await ctx.db
    .query('worldStatus')
    .withIndex('worldId', (q) => q.eq('worldId', m.worldId))
    .unique();
  return worldStatus ?? null;
}

/** Where the client looks to find out whether the city is running. */
export const status = query({
  handler: async (ctx) => {
    const ws = await findWorld(ctx);
    if (!ws) return null;
    const world = await ctx.db.get(ws.worldId);
    return {
      worldId: ws.worldId,
      engineId: ws.engineId,
      status: ws.status,
      players: world?.players.length ?? 0,
      agents: world?.agents.length ?? 0,
    };
  },
});

/**
 * Create the world if it does not exist, then top it up to `numAgents`.
 *
 * Idempotent on purpose: this is wired to a button, and a button gets pressed
 * twice. Creating a second engine for the same map would leave two of them
 * stepping the same world forever.
 */
export const init = mutation({
  args: { numAgents: v.optional(v.number()) },
  handler: async (ctx, args) => {
    let ws = await findWorld(ctx);
    if (!ws) {
      const engineId = await createEngine(ctx);
      const engine = (await ctx.db.get(engineId))!;
      const worldId = await ctx.db.insert('worlds', {
        nextId: 0,
        agents: [],
        conversations: [],
        players: [],
      });
      const statusId = await ctx.db.insert('worldStatus', {
        engineId,
        // NOT the default world. The front page must keep pointing at its own.
        isDefault: false,
        lastViewed: Date.now(),
        status: 'running',
        worldId,
      });
      // COLLISION ONLY. bgTiles is deliberately empty.
      //
      // Convex documents cap at 1 MiB and it counts its own encoding, where
      // every tile is a float64 — not the JSON text I sized this against the
      // first time, which read 0.37 MB and was wrong. 256x192 across three
      // layers is 147,456 numbers, 1.27 MiB, and the insert failed outright.
      //
      // The engine only ever reads width, height and objectTiles (see
      // isBlocked in aiTown/movement.ts). bgTiles exists for PixiStaticMap,
      // and nothing renders THIS world through Pixi — the 3D view draws from
      // data/siliconville3d.js and the 2D map reads data/siliconville.js
      // directly. So the two background layers were 786 KB of data nothing
      // would ever read.
      await ctx.db.insert('maps', {
        worldId,
        width: map.mapwidth,
        height: map.mapheight,
        tileSetUrl: map.tilesetpath,
        tileSetDimX: map.tilesetpxw,
        tileSetDimY: map.tilesetpxh,
        tileDim: map.tiledim,
        bgTiles: [],
        objectTiles: map.objmap,
        animatedSprites: [],
      });
      await ctx.scheduler.runAfter(0, internal.aiTown.main.runStep, {
        worldId,
        generationNumber: engine.generationNumber,
        maxDuration: ENGINE_ACTION_DURATION,
      });
      ws = (await ctx.db.get(statusId))!;
    }

    // Deliberately seeds NOBODY.
    //
    // This used to fill the city from data/characters — Alice, Bob, a cast of
    // invented people with invented backstories. They are gone. The city is now
    // populated only by residents who came out of a completed sign-up, and an
    // empty city on first boot is the correct state, not a broken one.
    //
    // `numAgents` is kept only so existing callers don't break; it is ignored.
    return { worldId: ws.worldId, engineId: ws.engineId, added: 0 };
  },
});

/**
 * Push the current collision map into the existing world.
 *
 * The map is written once, at creation. Every time the generator changes —
 * closing the archways to pedestrians, say — the running world keeps the old
 * one, and agents happily walk through walls that now exist because their
 * collision map says they do not. Without this the only fix is deleting the
 * world and losing everyone in it.
 */
export const refreshMap = mutation({
  handler: async (ctx) => {
    const ws = await findWorld(ctx);
    if (!ws) return { updated: false };
    const doc = await ctx.db
      .query('maps')
      .withIndex('worldId', (q) => q.eq('worldId', ws.worldId))
      .unique();
    if (!doc) return { updated: false };
    await ctx.db.patch(doc._id, {
      width: map.mapwidth,
      height: map.mapheight,
      objectTiles: map.objmap,
      bgTiles: [],
    });
    return { updated: true, width: map.mapwidth, height: map.mapheight };
  },
});

/**
 * Move anyone standing in a tile that is now solid back to the spawn garden.
 *
 * Changing the collision map under a running world strands whoever happened to
 * be inside the newly-solid tiles — closing the archways put 15 of 32
 * residents inside a letter. They are not "walking through walls" so much as
 * entombed: pathfinding out of a blocked tile fails, so they stop.
 *
 * Positions are patched directly rather than sent as inputs because there is
 * no input for "you are inside a building now, please leave". The engine
 * reloads the world at the start of each step, so a patch between steps is
 * picked up.
 */
export const evacuate = mutation({
  handler: async (ctx) => {
    const ws = await findWorld(ctx);
    if (!ws) return { moved: 0 };
    const world = (await ctx.db.get(ws.worldId))!;
    const blocked = map.objmap[0];
    const free = (x: number, y: number) =>
      blocked[x] !== undefined && blocked[x][y] === -1;

    let moved = 0;
    const players = world.players.map((p) => {
      const x = Math.round(p.position.x);
      const y = Math.round(p.position.y);
      if (free(x, y)) return p;
      // Spawn garden, same rect the engine spawns into.
      for (let i = 0; i < 200; i++) {
        const nx = 170 + Math.floor(Math.random() * 24);
        const ny = 98 + Math.floor(Math.random() * 14);
        if (free(nx, ny)) {
          moved++;
          // Clear pathfinding too: a route computed from inside a wall is not
          // a route anyone can follow.
          return { ...p, position: { x: nx, y: ny }, pathfinding: undefined };
        }
      }
      return p;
    });
    await ctx.db.patch(ws.worldId, { players });
    return { moved, total: players.length };
  },
});

/** Stop or resume the city without destroying it. */
export const setRunning = mutation({
  args: { running: v.boolean() },
  handler: async (ctx, args) => {
    const ws = await findWorld(ctx);
    if (!ws) return null;
    if (args.running && ws.status !== 'running') {
      await ctx.db.patch(ws._id, { status: 'running', lastViewed: Date.now() });
      const engine = (await ctx.db.get(ws.engineId))!;
      await ctx.db.patch(ws.engineId, { running: true, generationNumber: engine.generationNumber + 1 });
      await ctx.scheduler.runAfter(0, internal.aiTown.main.runStep, {
        worldId: ws.worldId,
        generationNumber: engine.generationNumber + 1,
        maxDuration: ENGINE_ACTION_DURATION,
      });
    } else if (!args.running && ws.status === 'running') {
      await ctx.db.patch(ws._id, { status: 'stoppedByDeveloper' });
      await ctx.db.patch(ws.engineId, { running: false });
    }
    return { status: args.running ? 'running' : 'stoppedByDeveloper' };
  },
});

/** The last N messages in the city chat, oldest first for display. */
export const chat = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(100, Math.max(1, args.limit ?? 50));
    const rows = await ctx.db.query('cityChat').order('desc').take(limit);
    return rows.reverse().map((m) => ({
      id: m._id,
      at: m._creationTime,
      name: m.name,
      text: m.text,
    }));
  },
});

const CHAT_MAX = 280;
const CHAT_COOLDOWN_MS = 2000;

/**
 * Post to the city chat.
 *
 * This is an unauthenticated public write, which is the whole risk: anything
 * anyone types goes straight onto a page other people load. The guards are
 * deliberately boring — a length cap, a per-session cooldown, and trimming —
 * and none of them are a substitute for moderation if this ever gets traffic.
 *
 * sessionId comes from the client and is trivially forgeable. It is here to
 * stop an ordinary person double-posting, not to stop someone who is trying.
 */
export const say = mutation({
  args: { name: v.string(), text: v.string(), sessionId: v.string() },
  handler: async (ctx, args) => {
    const text = args.text.trim().slice(0, CHAT_MAX);
    const name = args.name.trim().slice(0, 24) || 'Anon';
    if (!text) return { posted: false, reason: 'empty' };

    const last = await ctx.db
      .query('cityChat')
      .withIndex('bySession', (q) => q.eq('sessionId', args.sessionId))
      .order('desc')
      .first();
    if (last && Date.now() - last._creationTime < CHAT_COOLDOWN_MS) {
      return { posted: false, reason: 'too fast' };
    }

    await ctx.db.insert('cityChat', { name, text, sessionId: args.sessionId });
    return { posted: true };
  },
});

/**
 * Break a conversation deadlock.
 *
 * Every agent can end up permanently inside inProgressOperation =
 * agentGenerateMessage: the operation completes, the agent immediately starts
 * another, and the tick that would notice the conversation has outlived
 * MAX_CONVERSATION_DURATION never runs. Measured on this world: 36
 * conversations aged 21 to 162 minutes against a 10-minute cap, 72 of 72
 * players with no path. The city looks frozen because it is.
 *
 * Clearing the conversation list and the in-flight operations lets every agent
 * fall through to "decide what to do next", which is walking.
 *
 * MUST run with the engine stopped. It keeps world state in memory and writes
 * it back each step, so a patch applied to a running engine is overwritten by
 * the next step — the same trap as evacuate.
 */
export const unstick = mutation({
  handler: async (ctx) => {
    const ws = await findWorld(ctx);
    if (!ws) return { cleared: 0 };
    const world = (await ctx.db.get(ws.worldId))!;
    const cleared = world.conversations.length;
    await ctx.db.patch(ws.worldId, {
      conversations: [],
      agents: world.agents.map((a) => ({
        ...a,
        inProgressOperation: undefined,
        // Leave lastConversation set: it feeds the cooldown, and wiping it
        // would let everyone immediately start talking again.
      })),
      players: world.players.map((p) => ({ ...p, pathfinding: undefined })),
    });
    return { cleared, agents: world.agents.length };
  },
});

/**
 * Who the caller is, according to the token Convex verified.
 *
 * Returns null when signed out. Everything on this page works signed out, so
 * this is additive: it tells the client whether to offer the things that need
 * an identity, not whether to render at all.
 *
 * The subject is Google's stable `sub` claim, not the email — an email can be
 * changed or reassigned within a workspace, and a twin should not follow it.
 */
export const me = query({
  handler: async (ctx) => {
    const id = await ctx.auth.getUserIdentity();
    if (!id) return null;
    return {
      subject: id.subject,
      name: id.name ?? null,
      email: id.email ?? null,
      picture: id.pictureUrl ?? null,
    };
  },
});

/**
 * Attach an existing browser-local twin to the signed-in account.
 *
 * Before sign-in, a twin is keyed by a random uuid in localStorage — which is
 * a browser, not a person: clear storage and the twin is orphaned, and it
 * cannot follow anyone to a second device. On first sign-in we adopt whatever
 * twin this browser was carrying.
 *
 * Refuses to steal a twin already claimed by a different account, because the
 * uuid is client-supplied and anyone could send someone else's.
 */
export const claimTwin = mutation({
  args: { localUserId: v.string() },
  handler: async (ctx, args) => {
    const id = await ctx.auth.getUserIdentity();
    if (!id) return { claimed: false, reason: 'signed out' };

    const mine = await ctx.db
      .query('twins')
      .filter((q) => q.eq(q.field('userId'), id.subject))
      .first();
    if (mine) {
      // Already claimed — but a twin claimed BEFORE localUserId existed has no
      // record of the browser it came from, which is precisely the twin that
      // disappears when the token lapses. Record it now, so the repair happens
      // on the next signed-in load instead of needing a migration.
      if (!mine.localUserId && args.localUserId) {
        await ctx.db.patch(mine._id, { localUserId: args.localUserId });
        return { claimed: false, reason: 'already have one; linked this browser', twinId: mine._id };
      }
      return { claimed: false, reason: 'already have one', twinId: mine._id };
    }

    const local = await ctx.db
      .query('twins')
      .filter((q) => q.eq(q.field('userId'), args.localUserId))
      .first();
    if (!local) return { claimed: false, reason: 'nothing to claim' };

    // Claiming rewrites userId to the account subject, so a second attempt
    // with the old uuid finds nothing and falls out above. The window is
    // therefore only ever an UNCLAIMED twin.
    //
    // Worth being honest about the trust model: localUserId is a random uuid
    // held in a browser, and whoever presents it gets the twin. That was
    // already true before sign-in existed — it is what identified you — so
    // this does not weaken anything. It is not a secret worth protecting
    // seriously, and if twins ever carry anything sensitive it should become
    // a server-issued token instead.
    await ctx.db.patch(local._id, { userId: id.subject, localUserId: args.localUserId });
    return { claimed: true, twinId: local._id };
  },
});

/**
 * Put the city back to a known, cheap state.
 *
 * Trims to `target` residents, drops the sampled paths of everyone who leaves,
 * clears conversations and in-flight operations. Everything a long-running
 * world accumulates and nothing it needs to keep.
 *
 * Stop the engine first. It holds world state in memory and writes it back each
 * step, so a patch applied to a running engine is overwritten by the next one.
 */
/**
 * Ceiling on residents, as a backstop only.
 *
 * The rule that actually governs population is `evictSyntheticResidents`
 * below: you are in this city because you completed the sign-up form. This
 * number exists so that a surge of real sign-ups can't silently reproduce the
 * runaway that disabled the last deployment — every engine step rewrites the
 * whole world document, so cost scales with residents times step rate.
 */
export const POPULATION_CAP = 10;

/**
 * Remove everyone who isn't a real person.
 *
 * A resident is legitimate exactly when a `twins` row points at their playerId
 * — that row is created by finishing the interview, so it is the record of a
 * completed sign-up and there is no other way to obtain one. Anything else in
 * `world.agents` is a leftover from when the city seeded itself from
 * data/characters, and this deletes it.
 *
 * It runs on a cron rather than once, by hand, because the 72 synthetic
 * residents already in the world document are not reachable from here while
 * the deployment is disabled — and the instant it comes back, `restart dead
 * worlds` kicks the engine and they resume writing ~31 MiB a second. The
 * cleanup has to be waiting for them.
 *
 * It STOPS the engine before patching. The engine holds the world in memory
 * across an entire action and writes it back at the end, so a patch applied to
 * a running engine is overwritten by the next save. Status goes to `inactive`
 * because `restartDeadWorlds` only revives worlds marked `running` — so the
 * city stays down until a viewer's heartbeat brings it up, cleaned.
 */
export const evictSyntheticResidents = internalMutation({
  handler: async (ctx) => {
    // EVERY world, not just Siliconville's. The default ai-town world is a
    // separate row with its own engine, and an engine nobody renders still
    // steps once a second and still rewrites its whole world document. A sweep
    // that skipped it would leave the more expensive half of the problem
    // running.
    const statuses = await ctx.db.query('worldStatus').collect();
    const twins = await ctx.db.query('twins').collect();

    for (const ws of statuses) {
      const world = await ctx.db.get(ws.worldId);
      if (!world || world.agents.length === 0) continue;

      const real = new Set(
        twins.filter((t) => t.worldId === ws.worldId && t.playerId).map((t) => t.playerId!),
      );
      const keep = world.agents.filter((a) => real.has(a.playerId)).slice(0, POPULATION_CAP);
      if (keep.length === world.agents.length) continue;

      console.warn(
        `Evicting ${world.agents.length - keep.length} residents with no sign-up from world ` +
          `${ws.worldId} (${keep.length} real remain).`,
      );
      if (ws.status === 'running') {
        await ctx.db.patch(ws._id, { status: 'inactive' });
        await ctx.db.patch(ws.engineId, { running: false });
      }
      await keepOnly(ctx, ws.worldId, keep.map((a) => a.playerId));
    }
  },
});

/** Reduce the world to `playerIds`, dropping everything that referred to the rest. */
async function keepOnly(ctx: MutationCtx, worldId: Id<'worlds'>, playerIds: string[]) {
  const world = (await ctx.db.get(worldId))!;
  const keepIds = new Set(playerIds);
  const before = world.agents.length;
  await ctx.db.patch(worldId, {
    agents: world.agents
      .filter((a) => keepIds.has(a.playerId))
      .map((a) => ({ ...a, inProgressOperation: undefined })),
    players: world.players
      .filter((p) => keepIds.has(p.id))
      .map((p) => ({ ...p, pathfinding: undefined })),
    // Conversations reference players who may no longer exist, and historical
    // paths are the bulk of the document's size.
    conversations: [],
    historicalLocations: (world.historicalLocations ?? []).filter((h) => keepIds.has(h.playerId)),
  });
  return { residents: keepIds.size, removed: before - keepIds.size };
}

export const reset = mutation({
  args: {},
  handler: async (ctx) => {
    const ws = await findWorld(ctx);
    if (!ws) return { reset: false };
    const world = (await ctx.db.get(ws.worldId))!;
    const twins = await ctx.db.query('twins').collect();
    const real = new Set(
      twins.filter((t) => t.worldId === ws.worldId && t.playerId).map((t) => t.playerId!),
    );
    if (ws.status === 'running') {
      await ctx.db.patch(ws._id, { status: 'stoppedByDeveloper' });
      await ctx.db.patch(ws.engineId, { running: false });
    }
    const keep = world.agents.filter((a) => real.has(a.playerId)).slice(0, POPULATION_CAP);
    return { reset: true, ...(await keepOnly(ctx, ws.worldId, keep.map((a) => a.playerId))) };
  },
});

/**
 * How long one steer holds the wheel. Long enough that a held key feels
 * continuous, and generous after release: at 5s the agent snatched the body
 * back moments after a person paused to look around, and walked it off to its
 * own plans — which read as haunted controls.
 */
const DRIVE_LEASE_MS = 15_000;

/**
 * Tiles per second while a person is at the controls.
 *
 * The global pace is 0.75 t/s — a fine amble for an NPC living its life, and
 * glacial for someone exploring, who would need over five minutes to cross the
 * map. This applies only to routes a human asked for.
 */
const DRIVE_SPEED = 3;

/**
 * Walk YOUR resident.
 *
 * The engine's `moveTo` moves any player by id and checks nothing — fine while
 * only the engine called it, exploitable the moment a browser can. So the
 * ownership check lives here: we resolve the caller's own twin and steer that
 * body, rather than trusting a playerId from the client.
 *
 * Resolution matches twins.mine — account first, browser second — so steering
 * survives a lapsed Google token exactly like the follow camera does.
 */
export const steer = mutation({
  args: {
    dx: v.number(),
    dy: v.number(),
    localUserId: v.optional(v.string()),
    tiles: v.optional(v.number()),
    /** Key released — halt rather than coasting to the far destination. */
    stop: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const ws = await findWorld(ctx);
    if (!ws) return { moved: false, reason: 'no world' };

    const id = await ctx.auth.getUserIdentity();
    let twin = id
      ? await ctx.db
          .query('twins')
          .withIndex('userId', (q) => q.eq('userId', id.subject))
          .first()
      : null;
    if (!twin && args.localUserId) {
      twin =
        (await ctx.db
          .query('twins')
          .withIndex('userId', (q) => q.eq('userId', args.localUserId!))
          .first()) ??
        (await ctx.db
          .query('twins')
          .withIndex('localUserId', (q) => q.eq('localUserId', args.localUserId!))
          .first());
    }
    if (!twin) return { moved: false, reason: 'no twin' };
    if (!twin.playerId) return { moved: false, reason: 'twin has no body yet' };
    if (twin.worldId !== ws.worldId) return { moved: false, reason: 'twin is in another world' };

    const inputId = await insertInput(ctx, ws.worldId, 'steer', {
      playerId: twin.playerId,
      dx: args.dx,
      dy: args.dy,
      // Up to 24: a long lead means the figure keeps walking between refreshes
      // instead of stopping at the end of each short hop, which is what made
      // held keys feel like a series of taps.
      tiles: Math.max(1, Math.min(24, Math.floor(args.tiles ?? 16))),
      speed: DRIVE_SPEED,
      stop: args.stop ?? false,
      until: Date.now() + DRIVE_LEASE_MS,
    });
    // `moved` only means "queued". The engine can still refuse a tick later —
    // in a conversation, nowhere walkable — and that verdict lands on the
    // input's returnValue. Hand back the id so the client can watch it via
    // aiTown/main.inputStatus instead of the refusal dying in backend logs.
    return { moved: true, playerId: twin.playerId, inputId };
  },
});

/** Keep the world from being reaped for inactivity while someone is watching. */
export const heartbeat = mutation({
  handler: async (ctx) => {
    const ws = await findWorld(ctx);
    if (!ws) return;

    // Only write when it actually moves the deadline.
    //
    // This patched on EVERY call. The city page pings every 30s per open tab,
    // so a document write was being spent to re-state something already true —
    // and each write fans out to every client subscribed to the world. A ping
    // that changes nothing should cost nothing.
    const stale = Date.now() - ws.lastViewed > IDLE_WORLD_TIMEOUT / 5;
    if (stale) await ctx.db.patch(ws._id, { lastViewed: Date.now() });

    // Bumping lastViewed is not enough once the world can actually STOP.
    //
    // `stopInactiveWorlds` pauses an unwatched city, and `restartDeadWorlds`
    // deliberately refuses to revive anything that isn't already 'running' —
    // that's what keeps the two crons from fighting. Which leaves nothing to
    // start the engine again, so the first visitor after an idle period would
    // find a city frozen forever, with a heartbeat firing every 30s into a
    // world that never wakes.
    //
    // A viewer IS the signal to resume. So resuming is this mutation's job.
    if (ws.status !== 'inactive') return;
    // 'stoppedByDeveloper' is excluded above on purpose: that pause is somebody
    // holding the world still on purpose, and a passing viewer must not undo it.
    const engine = (await ctx.db.get(ws.engineId))!;
    const generationNumber = engine.generationNumber + 1;
    await ctx.db.patch(ws._id, { status: 'running' });
    await ctx.db.patch(ws.engineId, { running: true, generationNumber });
    await ctx.scheduler.runAfter(0, internal.aiTown.main.runStep, {
      worldId: ws.worldId,
      generationNumber,
      maxDuration: ENGINE_ACTION_DURATION,
    });
  },
});
