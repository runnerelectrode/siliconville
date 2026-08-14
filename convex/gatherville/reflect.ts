// Reflection — port of `MemoryStream.reflect()`.
//
// Retrieve against an anchor, infer higher-order first-person beliefs, score
// them, write them back as `reflection` memories.
//
// Two upstream bugs are deliberately NOT reproduced (GENAGENTS-ANALYSIS.md §1, §2.2):
//
//   1. `GenerativeAgent.reflect(anchor, time_step)` passes `time_step`
//      POSITIONALLY into `reflection_count`, so asking for a reflection at
//      time_step=3 silently generates 3 reflections at time 0.
//   2. `reflection/singular_v1.txt` declares `!<INPUT 1>!` (reflection count) in
//      its header and never references it in the body — the parameter is
//      threaded from the caller and dropped. We use the batch template whenever
//      count > 1, which does honour it.
//
// Reflection is never latency-sensitive, so it goes through the Batch API at
// 50% cost. It is also the thing that changes a twin's CACHED PREFIX, so it
// bumps prefixVersion — see the note at the bottom.

import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import { Doc, Id } from '../_generated/dataModel';
import { playerId as playerIdValidator } from '../aiTown/ids';
import { complete, submitBatch, batchReady, collectBatch } from './anthropic';
import { embed, embedMany } from './embeddings';
import { renderTemplate } from './templates';
import { extractReflections, extractImportanceScores } from './jsonParser';
import { retrieveMemories } from './memory';
import { renderScratch, prefixDigest, SIMULATION_RULES, Scratch } from './prompt';
import {
  REFLECTION_IMPORTANCE_THRESHOLD,
  REFLECTION_USE_BATCH,
  IMPORTANCE_MAX,
  RETRIEVAL_N_COUNT,
} from './constants';

/** genagents' default. */
const REFLECTION_COUNT = 5;
const RETRIEVAL_COUNT = RETRIEVAL_N_COUNT;

/**
 * Anchors to reflect on.
 *
 * genagents takes the anchor as a caller argument and offers no opinion about
 * what it should be — its harness reflects on interview topics. In a running
 * simulation nobody supplies one, so we reflect across a fixed set of life
 * domains. Keeping this list STABLE matters: reflections land in the cached
 * prefix, so churn here is churn in every prompt.
 */
export const REFLECTION_ANCHORS = [
  'what I value and what I actually do',
  'how I relate to other people',
  'how I spend my time',
  'what I avoid',
  'what I want that I have not said out loud',
] as const;

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

/**
 * Port of upstream's trigger: reflect once accumulated importance since the last
 * reflection exceeds a threshold. Rescaled with importance to 0-100.
 */
export const shouldReflect = internalQuery({
  args: { playerId: playerIdValidator },
  handler: async (ctx, { playerId }): Promise<boolean> => {
    const total: number = await ctx.runQuery(
      internal.gatherville.memory.importanceSinceLastReflection,
      { playerId },
    );
    return total > REFLECTION_IMPORTANCE_THRESHOLD;
  },
});

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

// Upstream fail-safe is [] — see jsonParser.extractReflections.
const parseReflections = extractReflections;

/** Renders the prompt for one anchor. Shared by the live and batch paths. */
async function buildReflectionPrompt(
  ctx: any,
  playerId: string,
  anchor: string,
  count: number,
): Promise<{ prompt: string; sourceIds: Id<'memories'>[] } | null> {
  const ranked = await retrieveMemories(ctx, playerId, await embed(anchor), RETRIEVAL_COUNT);
  if (ranked.length === 0) return null;

  const recordsStr = ranked.map((r, i) => `Item ${i + 1}:\n${r.memory.description}\n`).join('');
  const key =
    count > 1
      ? 'memory_stream/reflection/batch_v1'
      : 'memory_stream/reflection/singular_v1';

  return {
    prompt: renderTemplate(key, [recordsStr, count, anchor]),
    sourceIds: ranked.map((r) => r.memory._id),
  };
}

/** Live path — used when a reflection is needed immediately (e.g. right after onboarding). */
export const reflectNow = internalAction({
  args: {
    twinId: v.id('twins'),
    playerId: playerIdValidator,
    anchor: v.optional(v.string()),
    count: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ inserted: number }> => {
    const anchor = args.anchor ?? REFLECTION_ANCHORS[0];
    const count = args.count ?? REFLECTION_COUNT;

    const built = await buildReflectionPrompt(ctx, args.playerId, anchor, count);
    if (!built) return { inserted: 0 };

    const result = await complete({
      route: 'salient',
      cachedPrefix: { text: 'You infer higher-order beliefs about a person.', ttl: '1h' },
      volatile: built.prompt,
      effort: 'high',
      maxTokens: 4_000,
    });

    const reflections = parseReflections(result.text);
    if (reflections.length === 0) return { inserted: 0 };

    await ctx.runAction(internal.gatherville.reflect.persistReflections, {
      twinId: args.twinId,
      playerId: args.playerId,
      reflections,
      sourceIds: built.sourceIds,
    });
    return { inserted: reflections.length };
  },
});

/**
 * Batch path — the default. Submits every anchor for every eligible twin as one
 * batch at 50% cost. Returns a batch id to be collected later.
 */
export const submitReflectionBatch = internalAction({
  args: { twins: v.array(v.object({ twinId: v.id('twins'), playerId: v.string() })) },
  handler: async (ctx, { twins }): Promise<{ batchId: string | null; items: number }> => {
    const items: {
      customId: string;
      cachedPrefix: { text: string; ttl: '1h' };
      volatile: string;
      maxTokens: number;
    }[] = [];
    const sourceMap: Record<string, Id<'memories'>[]> = {};

    for (const twin of twins) {
      for (const anchor of REFLECTION_ANCHORS) {
        const built = await buildReflectionPrompt(ctx, twin.playerId, anchor, REFLECTION_COUNT);
        if (!built) continue;
        // custom_id is the ONLY safe way to reattach a result to its twin —
        // batch results come back in arbitrary order.
        const customId = `${twin.twinId}::${anchor.replace(/\s+/g, '_')}`;
        items.push({
          customId,
          cachedPrefix: { text: 'You infer higher-order beliefs about a person.', ttl: '1h' },
          volatile: built.prompt,
          maxTokens: 4_000,
        });
        sourceMap[customId] = built.sourceIds;
      }
    }

    if (items.length === 0) return { batchId: null, items: 0 };

    const batchId = await submitBatch('salient', items);
    await ctx.runMutation(internal.gatherville.reflect.recordBatch, { batchId, sourceMap });
    return { batchId, items: items.length };
  },
});

export const collectReflectionBatch = internalAction({
  args: { batchId: v.string() },
  handler: async (ctx, { batchId }): Promise<{ ready: boolean; inserted: number }> => {
    if (!(await batchReady(batchId))) return { ready: false, inserted: 0 };

    const results = await collectBatch(batchId);
    const record = await ctx.runQuery(internal.gatherville.reflect.getBatch, { batchId });
    if (!record) return { ready: true, inserted: 0 };

    let inserted = 0;
    for (const [customId, text] of results) {
      const [twinId] = customId.split('::');
      const reflections = parseReflections(text);
      if (reflections.length === 0) continue;

      const twin = await ctx.runQuery(internal.gatherville.interview.getTwin, {
        twinId: twinId as Id<'twins'>,
      });
      if (!twin?.playerId) continue;

      await ctx.runAction(internal.gatherville.reflect.persistReflections, {
        twinId: twinId as Id<'twins'>,
        playerId: twin.playerId,
        reflections,
        sourceIds: (record.sourceMap as Record<string, Id<'memories'>[]>)[customId] ?? [],
      });
      inserted += reflections.length;
    }
    return { ready: true, inserted };
  },
});

/**
 * Score, embed, insert — then bump the twin's prefix version.
 *
 * Reflections enter the CORE IDENTITY SET, which lives above the prompt cache
 * breakpoint. Adding one therefore invalidates every cached prefix for that
 * twin. That is correct and unavoidable — but it must be deliberate and visible,
 * which is why it bumps `prefixVersion` rather than letting the digest drift
 * silently. Cache hit rate is the number that tells us whether 24/7 is
 * affordable; unexplained churn in it is the failure we most want to see coming.
 */
export const persistReflections = internalAction({
  args: {
    twinId: v.id('twins'),
    playerId: playerIdValidator,
    reflections: v.array(v.string()),
    sourceIds: v.array(v.id('memories')),
  },
  handler: async (ctx, args): Promise<void> => {
    const recordsStr = args.reflections.map((r, i) => `Item ${i + 1}:\n${r}\n`).join('');
    const key =
      args.reflections.length > 1
        ? 'memory_stream/importance_score/batch_v1'
        : 'memory_stream/importance_score/singular_v1';

    const scoreResult = await complete({
      route: 'salient',
      cachedPrefix: { text: 'You score observations about a person for importance.', ttl: '1h' },
      volatile: renderTemplate(key, [recordsStr]),
      effort: 'low',
      maxTokens: 1_000,
    });

    const scores = extractImportanceScores(scoreResult.text, args.reflections.length);

    const embeddings = await embedMany(args.reflections);

    for (let i = 0; i < args.reflections.length; i++) {
      await ctx.runMutation(internal.gatherville.memory.insertMemory, {
        playerId: args.playerId,
        twinId: args.twinId,
        description: args.reflections[i],
        embedding: embeddings[i],
        importance: Math.max(0, Math.min(IMPORTANCE_MAX, scores[i] ?? 25)),
        provenance: 'reflection',
        data: { type: 'reflection', relatedMemoryIds: args.sourceIds },
      });
    }

    await ctx.runAction(internal.gatherville.reflect.refreshPrefix, { twinId: args.twinId });
  },
});

/** Recompute the cached-prefix digest after the core identity set changed. */
export const refreshPrefix = internalAction({
  args: { twinId: v.id('twins') },
  handler: async (ctx, { twinId }): Promise<void> => {
    const twin = await ctx.runQuery(internal.gatherville.interview.getTwin, { twinId });
    if (!twin?.playerId) return;

    const core = await ctx.runQuery(internal.gatherville.memory.coreIdentitySet, {
      playerId: twin.playerId,
      limit: 24,
    });

    let prefix = `${SIMULATION_RULES}\n\n`;
    prefix += `Self description: ${renderScratch(twin.scratch as Scratch)}\n==\n`;
    prefix += `Core observations about the subject:\n\n`;
    for (const m of core as Doc<'memories'>[]) prefix += `${m.description}\n`;

    await ctx.runMutation(internal.gatherville.twins.bumpPrefix, {
      twinId,
      newDigest: prefixDigest(prefix),
    });
  },
});

// --- batch bookkeeping -----------------------------------------------------

export const recordBatch = internalMutation({
  args: { batchId: v.string(), sourceMap: v.any() },
  handler: async (ctx, { batchId, sourceMap }) => {
    await ctx.db.insert('reflectionBatches', { batchId, sourceMap, createdAt: Date.now() });
  },
});

export const getBatch = internalQuery({
  args: { batchId: v.string() },
  handler: async (ctx, { batchId }) => {
    return await ctx.db
      .query('reflectionBatches')
      .withIndex('batchId', (q) => q.eq('batchId', batchId))
      .first();
  },
});

/** Cron: sweep twins over the reflection threshold and submit one batch. */
export const reflectionSweep = internalAction({
  args: {},
  handler: async (ctx): Promise<{ submitted: number }> => {
    if (!REFLECTION_USE_BATCH) return { submitted: 0 };

    const candidates = await ctx.runQuery(internal.gatherville.reflect.reflectionCandidates, {});
    if (candidates.length === 0) return { submitted: 0 };

    const { items } = await ctx.runAction(internal.gatherville.reflect.submitReflectionBatch, {
      twins: candidates,
    });
    return { submitted: items };
  },
});

export const reflectionCandidates = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ twinId: Id<'twins'>; playerId: string }[]> => {
    const twins = await ctx.db.query('twins').collect();
    const out: { twinId: Id<'twins'>; playerId: string }[] = [];
    for (const twin of twins) {
      if (!twin.playerId) continue;
      const lastReflection = await ctx.db
        .query('memories')
        .withIndex('playerId_provenance', (q) =>
          q.eq('playerId', twin.playerId!).eq('provenance', 'reflection'),
        )
        .order('desc')
        .first();
      const since = lastReflection?._creationTime ?? 0;
      const recent = await ctx.db
        .query('memories')
        .withIndex('playerId', (q) => q.eq('playerId', twin.playerId!))
        .filter((q) => q.gt(q.field('_creationTime'), since))
        .collect();
      const total = recent.reduce((sum, m) => sum + m.importance, 0);
      if (total > REFLECTION_IMPORTANCE_THRESHOLD) {
        out.push({ twinId: twin._id, playerId: twin.playerId });
      }
    }
    return out;
  },
});
