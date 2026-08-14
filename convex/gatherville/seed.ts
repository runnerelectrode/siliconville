// End-to-end seed: canned transcript -> twin -> sprite in the world.
//
// Exists so the whole pipeline can be exercised without the voice UI. Everything
// downstream of `buildFromTranscript` is identical to the real path — this only
// substitutes the input source.
//
//   npx convex run gatherville/seed:seedTwin
//
// The twin takes over an existing ai-town NPC's sprite rather than spawning a
// new player: the engine owns player creation through its input pipeline, and
// reaching around that would break the single-step-per-world guarantee.

import { v } from 'convex/values';
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from '../_generated/server';
import { api, internal } from '../_generated/api';
import { MODELS } from './anthropic';
import { Id } from '../_generated/dataModel';
import { insertInput } from '../aiTown/insertInput';

/**
 * A canned interview. Deliberately written the way a real 7-minute transcript
 * looks: specific episodes, hedges, and — critically — contradictions between
 * what she says she values and what she describes doing. A clean, consistent
 * transcript would produce a twin that is trivially predictable and would make
 * the holdout score meaningless.
 */
export const SAMPLE_TRANSCRIPT = `
[interviewer]: To start — what should I call you, and where do you live?
[you]: Ruth. Ruth Okafor. I'm in Leeds, been here about six years now. Flat share with my friend Dan, though he's away a lot for work so it's mostly just me and the cat. I'm a paediatric nurse, I do nights three days a week at the LGI.

[interviewer]: What does a normal week look like for you?
[you]: Honestly it's built around the nights. I work Tuesday Wednesday Thursday, so Monday I'm winding up and Friday I'm a zombie. I try to keep the weekends properly free but I'm usually wrecked by Thursday and I end up sleeping through half of Saturday.

[interviewer]: Tell me about the last time you changed your mind about something that mattered.
[you]: Um. Probably about my sister actually. She asked me to help her move back in April and I was completely resentful about it, I'd said yes before I thought about it and then spent two weeks annoyed. And then on the day it was fine? We had a laugh, we ordered chips. I think I'd decided she was taking me for granted and actually she just needed help and didn't know how to ask.

[interviewer]: Did you tell her you'd felt that way?
[you]: God no. No. That would have been a whole thing.

[interviewer]: Is there something you believe you should do more of, but don't actually do?
[you]: See people. I say I want to see friends more, I genuinely mean it, and then I cancelled on Priya twice last month. Both times I texted about an hour before. I just get to five o'clock and the idea of getting on a bus is unbearable.

[interviewer]: What happens in the moment you decide to cancel?
[you]: It's not really a decision, that's the thing. It's more like I notice I've already decided. I'll be sat there and I'll realise I've been putting off getting changed for forty minutes and at that point it's basically done.

[interviewer]: Anything you're strict about?
[you]: The kitchen. I know it's a bit much. I can't settle if there's stuff on the side. Dan thinks it's hilarious. But I'll be shattered off a night shift and I'll still do the washing up before I go to bed, I can't get in otherwise.

[interviewer]: What kinds of decisions do you think people misjudge about you?
[you]: People think I'm the organised one because of work and the kitchen thing. But my actual life is chaos, I've not done a tax return in two years. I think people assume I'm sociable because I'm chatty on shift and really I need a lot of time on my own. I took the long way home last Tuesday just to have twenty minutes where nobody wanted anything.
`.trim();

/**
 * Diagnostics. Run this BEFORE seeding — it verifies the embedding provider is
 * reachable and emits vectors of the expected width, which is otherwise only
 * discovered on the first memory write, several expensive LLM calls in.
 *
 *   npx convex run gatherville/seed:checkProviders
 */
export const checkProviders = action({
  args: {},
  handler: async (): Promise<{ embeddings: unknown; anthropic: string }> => {
    const { checkEmbeddingProvider } = await import('./embeddings');
    let embeddings: unknown;
    try {
      embeddings = await checkEmbeddingProvider();
    } catch (e) {
      embeddings = { error: String(e) };
    }
    return {
      embeddings,
      anthropic: process.env.OPENROUTER_API_KEY
        ? `via OpenRouter — salient=${MODELS.salient} routine=${MODELS.routine}`
        : process.env.ANTHROPIC_API_KEY
          ? `first-party — salient=${MODELS.salient} routine=${MODELS.routine}`
          : "MISSING — set ANTHROPIC_API_KEY or OPENROUTER_API_KEY",
    };
  },
});

export const seedTwin = action({
  args: {
    userId: v.optional(v.string()),
    transcript: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    twinId: Id<'twins'>;
    observationCount: number;
    playerId: string | null;
    holdouts: number;
  }> => {
    const userId = args.userId ?? 'seed-user';

    console.log('[seed] building twin from transcript…');
    const { twinId, observationCount } = await ctx.runAction(
      api.gatherville.interview.buildFromTranscript,
      { userId, transcript: args.transcript ?? SAMPLE_TRANSCRIPT },
    );
    console.log(`[seed] twin ${twinId} with ${observationCount} observations`);

    // Same placement step the browser flow uses — one code path, exercised twice.
    const placed = await ctx.runAction(internal.gatherville.twins.placeInWorld, { twinId });
    if (placed) {
      console.log(`[seed] attached to player ${placed.playerId}`);
    } else {
      console.warn('[seed] could not place — run `npx convex run init` first');
    }

    const holdouts = await ctx.runQuery(api.gatherville.interview.scorecard, { twinId });

    return {
      twinId,
      observationCount,
      playerId: placed?.playerId ?? null,
      holdouts: holdouts.total,
    };
  },
});

/**
 * First player in the default world not already bound to a twin.
 *
 * ai-town's agents live inside the `worlds` document rather than their own
 * table, so this reads the world doc rather than querying players.
 */
export const firstUnclaimedPlayer = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ worldId: Id<'worlds'>; playerId: string } | null> => {
    const worldStatus = await ctx.db
      .query('worldStatus')
      .filter((q) => q.eq(q.field('isDefault'), true))
      .unique();
    if (!worldStatus) return null;

    const world = await ctx.db.get(worldStatus.worldId);
    if (!world) return null;

    const claimed = new Set(
      (await ctx.db.query('twins').collect()).map((t) => t.playerId).filter(Boolean),
    );

    for (const player of world.players) {
      if (!claimed.has(player.id)) {
        return { worldId: worldStatus.worldId, playerId: player.id };
      }
    }
    return null;
  },
});

/** Force one decision immediately, bypassing the cadence wait. For testing. */
export const forceDecision = action({
  args: { twinId: v.id('twins') },
  handler: async (ctx, { twinId }): Promise<unknown> => {
    const twin = await ctx.runQuery(internal.gatherville.interview.getTwin, { twinId });
    if (!twin?.playerId || !twin.worldId) throw new Error('Twin is not attached to a world');

    // Cadence gates on nextDecisionAt; a freshly attached twin is 'observed'
    // with nextDecisionAt = now, so this should pass straight through.
    return await ctx.runAction(internal.gatherville.decide.decide, {
      twinId,
      playerId: twin.playerId,
      worldId: twin.worldId,
      situation:
        'I am at home. It is early evening. There is nobody nearby. I have free time and need to decide what to do next.',
      // No candidates — exercises the free-form path the world now uses.
      kind: 'action',
    });
  },
});

/**
 * Exercise the twin dialogue path end to end without waiting for the engine to
 * pair two agents up.
 *
 * Seeds a real conversation row + messages, then calls the SAME `twinUtterance`
 * that `agentGenerateMessage` calls — so this covers twin lookup, message
 * loading, dialogue construction, anchor retrieval, template render, the model
 * call, parsing and tracing. The only thing it skips is ai-town's scheduling.
 *
 *   npx convex run gatherville/seed:forceUtterance '{"twinId":"..."}'
 */
export const forceUtterance = action({
  args: {
    twinId: v.id('twins'),
    priorLines: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<unknown> => {
    const { twinUtterance } = await import('./conversation');

    const twin = await ctx.runQuery(internal.gatherville.interview.getTwin, {
      twinId: args.twinId,
    });
    if (!twin?.playerId || !twin.worldId) throw new Error('Twin is not attached to a world');

    const other = await ctx.runQuery(internal.gatherville.seed.someOtherPlayer, {
      worldId: twin.worldId,
      excludePlayerId: twin.playerId,
    });
    if (!other) throw new Error('No other player in the world to talk to');

    const conversationId = await ctx.runMutation(internal.gatherville.seed.seedConversation, {
      worldId: twin.worldId,
      authorId: other,
      lines: args.priorLines ?? [
        "Hiya — you look like you've just come off a shift.",
        'Are you about this weekend at all?',
      ],
    });

    const utterance = await twinUtterance(
      ctx,
      twin.worldId,
      conversationId as never,
      twin.playerId as never,
      other as never,
      'continue',
    );

    return { conversationId, otherPlayerId: other, utterance };
  },
});

export const someOtherPlayer = internalQuery({
  args: { worldId: v.id('worlds'), excludePlayerId: v.string() },
  handler: async (ctx, { worldId, excludePlayerId }): Promise<string | null> => {
    const world = await ctx.db.get(worldId);
    if (!world) return null;
    const other = world.players.find((p) => p.id !== excludePlayerId);
    return other?.id ?? null;
  },
});

export const seedConversation = internalMutation({
  args: { worldId: v.id('worlds'), authorId: v.string(), lines: v.array(v.string()) },
  handler: async (ctx, { worldId, authorId, lines }): Promise<string> => {
    // ai-town conversation ids are game ids of the form `c:<n>`; a high number
    // keeps this out of the engine's way.
    const conversationId = `c:9${Math.floor(Math.random() * 1000)}`;
    for (const text of lines) {
      await ctx.db.insert('messages', {
        worldId,
        conversationId: conversationId as never,
        messageUuid: crypto.randomUUID(),
        author: authorId as never,
        text,
      });
    }
    return conversationId;
  },
});

/**
 * Repair asset URLs stored in the database.
 *
 * `maps.tileSetUrl` is written at init time from `data/gentle.js`, so changing
 * the source path does nothing for a world that already exists — the row keeps
 * the old value and the map renders as an empty blue rectangle with no error
 * anywhere. This patches existing rows in place rather than forcing a re-init,
 * which would destroy the seeded twin.
 *
 *   npx convex run gatherville/seed:fixAssetUrls
 */
export const fixAssetUrls = mutation({
  args: {},
  handler: async (ctx): Promise<{ patched: number; urls: string[] }> => {
    const maps = await ctx.db.query('maps').collect();
    const urls: string[] = [];
    let patched = 0;
    for (const map of maps) {
      if (map.tileSetUrl.startsWith('/ai-town/')) {
        const fixed = map.tileSetUrl.replace('/ai-town/', '/');
        await ctx.db.patch(map._id, { tileSetUrl: fixed });
        urls.push(`${map.tileSetUrl} -> ${fixed}`);
        patched++;
      } else {
        urls.push(`${map.tileSetUrl} (already ok)`);
      }
    }
    return { patched, urls };
  },
});




