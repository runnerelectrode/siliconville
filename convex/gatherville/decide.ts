// The agent brain. Replaces upstream ai-town's `agentDoSomething` LLM path.
//
// Called from `Agent.tick` via `startOperation`, so it inherits ai-town's
// single-step-per-world guarantee and its input pipeline — the returned action
// is submitted as a normal engine input, exactly like a human's.
//
// Flow:
//   cadence gate → retrieve (genagents ranking) → two-tier prompt → route by
//   salience → Claude → trace (with cost + prefix digest) → advance cadence

import { v } from 'convex/values';
import { internalAction, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import { Doc, Id } from '../_generated/dataModel';
import { playerId as playerIdValidator } from '../aiTown/ids';
import { retrieveMemories, effectiveImportance } from './memory';
import { embed } from './embeddings';
import { renderWorldContext } from './worldContext';
import * as city from './siliconvilleZones';
import {
  buildTwoTier,
  prefixDigest,
  DECISION_SCHEMA,
  FREEFORM_ACTION_SCHEMA,
  UTTERANCE_SCHEMA,
  Scratch,
} from './prompt';
import { complete, suspectCacheMiss, Route } from './anthropic';
import { extractFirstJsonDict, extractUtterance } from './jsonParser';
import { RETRIEVAL_LIMIT } from './constants';

const CORE_IDENTITY_LIMIT = 24;

/**
 * Which model handles this decision.
 *
 * Routine wandering is not worth Opus. Anything the user is likely to see and
 * judge — a conversation, a correction, a genuine choice between options — is.
 */
/**
 * Which model handles this decision.
 *
 * In-world actions ALWAYS use the cheap model. Measured, not assumed: Haiku
 * produced "checking my phone for any messages from my tutor about tomorrow's
 * session" for $0.00136, while Opus produced "reading a book" for $0.00864.
 * The quality came from removing the three-item action menu, not from the model.
 *
 * An earlier version routed watched lives to Opus on the theory that visible
 * output deserves the better model. That paired the most expensive model with
 * the most frequent tier — watching cost ~$3.11/hour against ~$0.55 on Haiku —
 * for no measurable gain. Actions are frequent and cheap; that is the whole
 * point of the cadence design.
 *
 * Dialogue stays on the expensive model: it is rare, it is the most scrutinised
 * thing a life produces, and it is what someone screenshots.
 */
/**
 * The shared world block. Identical for every twin and every decision, so it is
 * the first cached block and all twins share one entry for it.
 *
 * Built once per isolate. Rebuilding it per call would be harmless for
 * correctness but wasteful, and any accidental per-call variation here would
 * destroy the cache for the whole population at once rather than one twin.
 */
const WORLD_CONTEXT = renderWorldContext({
  placeName: city.PLACE_NAME,
  variantLabel: city.LABEL,
  zones: city.ZONES as never,
  staff: city.STAFF,
  tileFeet: city.TILE_FEET,
});

/**
 * Cache TTL by cadence tier. The rule is simply whether the next decision
 * arrives before the entry expires:
 *
 *   observed/active  ~88s apart  -> 5m, comfortably inside
 *   ambient          15 min      -> 1h, since 5m would always have expired
 *   dormant          60 min      -> off. Even a 1h entry has usually gone, so
 *                                  marking it pays the 2x write EVERY time and
 *                                  never reads: strictly worse than no caching.
 */
function ttlForTier(tier: string, watched: boolean): '5m' | '1h' | 'off' {
  if (watched || tier === 'observed' || tier === 'active') return '5m';
  if (tier === 'dormant') return 'off';
  return '1h';
}

function routeFor(kind: string, _candidateCount: number, _watched: boolean): Route {
  if (kind === 'utterance') return 'salient';
  return 'routine';
}

export const twinContext = internalQuery({
  args: { twinId: v.id('twins') },
  handler: async (
    ctx,
    { twinId },
  ): Promise<{ twin: Doc<'twins'>; coreIdentity: Doc<'memories'>[]; watched: boolean; tier: string } | null> => {
    const twin = await ctx.db.get(twinId);
    if (!twin || !twin.playerId) return null;

    // Inlined rather than delegated: a Convex query handler has `ctx.db` but no
    // `ctx.runQuery`, so it cannot call another query.
    const identity = await ctx.db
      .query('memories')
      .withIndex('playerId_provenance', (q) =>
        q.eq('playerId', twin.playerId!).eq('provenance', 'interview'),
      )
      .collect();
    const reflections = await ctx.db
      .query('memories')
      .withIndex('playerId_provenance', (q) =>
        q.eq('playerId', twin.playerId!).eq('provenance', 'reflection'),
      )
      .collect();
    const coreIdentity = [...identity, ...reflections]
      .sort((a, b) => effectiveImportance(b) - effectiveImportance(a))
      .slice(0, CORE_IDENTITY_LIMIT)
      .sort((a, b) => a._creationTime - b._creationTime);

    const cadence = await ctx.db
      .query('twinCadence')
      .withIndex('twinId', (q) => q.eq('twinId', twinId))
      .first();

    return {
      twin,
      coreIdentity,
      watched: (cadence?.watcherCount ?? 0) > 0,
      tier: cadence?.tier ?? 'ambient',
    };
  },
});

/**
 * Make one decision. Returns null when the cadence gate declines — that path
 * costs nothing and is the common case at ambient/dormant tiers.
 */
export const decide = internalAction({
  args: {
    twinId: v.id('twins'),
    playerId: playerIdValidator,
    worldId: v.id('worlds'),
    /** What's happening, in prose. Becomes the retrieval anchor. */
    situation: v.string(),
    /** Discrete options, when the action space is enumerable. */
    candidates: v.optional(v.array(v.string())),
    /** 'action' | 'utterance' */
    kind: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ action: string; rationale?: string; emoji?: string; traceId: Id<'traces'> } | null> => {
    const now = Date.now();

    const allowed = await ctx.runQuery(internal.gatherville.cadence.mayDecide, {
      twinId: args.twinId,
      now,
    });
    if (!allowed) return null;

    const context = await ctx.runQuery(internal.gatherville.decide.twinContext, {
      twinId: args.twinId,
    });
    if (!context) return null;
    const { twin, coreIdentity, watched, tier } = context;

    // The situation IS the anchor — matching genagents, where the retrieval
    // query is the question text (categorical/numerical) or the whole dialogue
    // (utterance). See GENAGENTS-ANALYSIS.md §3.2.
    const anchor = args.situation;
    const retrieved = await retrieveMemories(ctx, args.playerId, await embed(anchor), RETRIEVAL_LIMIT);

    const prompt = buildTwoTier({
      scratch: twin.scratch as Scratch,
      coreIdentity,
      retrieved: retrieved.map((r) => r.memory),
      situation: args.situation,
      candidates: args.candidates,
    });

    const digest = prefixDigest(prompt.cachedPrefix);
    if (twin.prefixDigest && digest !== twin.prefixDigest) {
      // Not fatal, but it means every cached prefix for this twin just died.
      // If this fires often, something non-stable leaked above the breakpoint.
      console.warn(
        `[gatherville] prefix digest changed for twin ${args.twinId}: ` +
          `${twin.prefixDigest} -> ${digest}. Cache invalidated.`,
      );
    }

    const kind = args.kind ?? 'action';
    const route = routeFor(kind, args.candidates?.length ?? 0, watched);

    const result = await complete({
      route,
      cachedPrefix: [
        // World first: byte-identical across every twin, so all of them share
        // one cache entry for this segment instead of each caching a copy.
        { text: WORLD_CONTEXT, ttl: ttlForTier(tier, watched) },
        // Then identity, which diverges per twin.
        { text: prompt.cachedPrefix, ttl: ttlForTier(tier, watched) },
      ],
      volatile: prompt.volatile,
      effort: route === 'salient' ? 'high' : undefined,
      jsonSchema:
        kind === 'utterance'
          ? UTTERANCE_SCHEMA
          : (args.candidates?.length ?? 0) > 0
            ? DECISION_SCHEMA
            : FREEFORM_ACTION_SCHEMA,
    });

    if (suspectCacheMiss(result.usage, prompt.approxPrefixTokens)) {
      console.warn(
        `[gatherville] expected a cache hit for twin ${args.twinId} ` +
          `(~${prompt.approxPrefixTokens} prefix tokens) but saw neither read nor write.`,
      );
    }

    // Brace-counted extraction: models routinely append prose after the JSON,
    // which a slice-from-first-brace parse cannot survive.
    let action: string;
    let rationale: string | undefined;
    let emoji: string | undefined;
    if (kind === 'utterance') {
      action = extractUtterance(result.text) ?? result.text.trim();
    } else {
      const parsed = extractFirstJsonDict(result.text);
      action = typeof parsed?.action === 'string' ? parsed.action : result.text.trim();
      rationale = typeof parsed?.rationale === 'string' ? parsed.rationale : undefined;
      emoji = typeof parsed?.emoji === 'string' ? parsed.emoji : undefined;
    }

    const traceId: Id<'traces'> = await ctx.runMutation(internal.gatherville.traces.append, {
      twinId: args.twinId,
      playerId: args.playerId,
      worldId: args.worldId,
      kind: kind === 'utterance' ? 'utterance' : 'decision',
      observation: args.situation,
      candidates: args.candidates,
      action,
      rationale,
      model: result.model,
      effort: route === 'salient' ? 'high' : undefined,
      prefixDigest: digest,
      tokens: result.usage,
      costMicros: result.costMicros,
    });

    await ctx.runMutation(internal.gatherville.cadence.recordDecision, {
      twinId: args.twinId,
      now,
    });

    return { action, rationale, emoji, traceId };
  },
});
