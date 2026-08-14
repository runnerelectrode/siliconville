// Twin dialogue — port of genagents' `utterance()` (interaction.py:177).
//
// Replaces ai-town's `convex/agent/conversation.ts` FOR TWINS ONLY. Population
// NPCs have no twin record and fall through to upstream's generic prompts, which
// is correct: they have no interview and nothing to ground dialogue in.
//
// This closes the last gap between decisions and dialogue. Before this, a twin
// *acted* from its interview (via decide.ts) but *spoke* from ai-town's generic
// character prompt — so the twin that chose "tidying the kitchen because I can't
// settle with stuff on the side" would then talk like a stock NPC.
//
// Upstream shape, reproduced exactly (interaction.py:177-186):
//
//   str_dialogue = ""
//   for row in curr_dialogue:
//       str_dialogue += f"[{row[0]}]: {row[1]}\n"
//   str_dialogue += f"[{agent.get_fullname()}]: [Fill in]\n"
//   anchor = str_dialogue                       <- the WHOLE dialogue is the anchor
//   agent_desc = _utterance_agent_desc(agent, anchor)
//
// Template inputs are [agent_desc, context, str_dialogue] — note `context` is
// INPUT 1 and renders INSIDE the "<Dialogue so far>" block, above the dialogue.

import { v } from 'convex/values';
import { ActionCtx, internalQuery } from '../_generated/server';
import { api, internal } from '../_generated/api';
import { Doc, Id } from '../_generated/dataModel';
import { GameId, conversationId as conversationIdValidator, playerId } from '../aiTown/ids';
import { retrieveMemories } from './memory';
import { embed } from './embeddings';
import { renderTemplate } from './templates';
import { renderFaithful, Scratch } from './prompt';
import { complete } from './anthropic';
import { extractUtterance } from './jsonParser';
import { RETRIEVAL_N_COUNT } from './constants';

export type UtteranceKind = 'start' | 'continue' | 'leave';

/**
 * genagents' `get_fullname()` returns "" unless BOTH names exist
 * (genagents.py:91-94), which would render "[]: [Fill in]" and confuse the
 * model about who is speaking. We fall back to the first name — a deliberate
 * deviation from a clear upstream defect, recorded in FIDELITY.md.
 */
function fullName(scratch: Scratch): string {
  const both = [scratch.firstName, scratch.lastName].filter(Boolean).join(' ');
  return both || scratch.firstName || 'Unknown';
}

/**
 * `context` is INPUT 1. genagents leaves it to the caller; in a survey harness
 * it's empty. Here it carries the one thing the dialogue text cannot: whether
 * this turn opens, continues, or closes the conversation.
 */
function contextFor(kind: UtteranceKind, otherName: string): string {
  switch (kind) {
    case 'start':
      return `You have just run into ${otherName} and are starting a conversation.`;
    case 'continue':
      return `You are in the middle of a conversation with ${otherName}.`;
    case 'leave':
      return `You need to leave this conversation with ${otherName}. Wrap up naturally and say goodbye.`;
  }
}

/**
 * Generate a twin's next utterance.
 *
 * Returns null when this player has no twin — the caller then falls back to
 * ai-town's generic path rather than inventing an identity for an NPC.
 */
export async function twinUtterance(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  conversationId: GameId<'conversations'>,
  playerIdArg: GameId<'players'>,
  otherPlayerIdArg: GameId<'players'>,
  kind: UtteranceKind,
): Promise<string | null> {
  const twin: Doc<'twins'> | null = await ctx.runQuery(internal.gatherville.twins.byPlayerId, {
    playerId: playerIdArg,
  });
  if (!twin) return null;

  const names = await ctx.runQuery(internal.gatherville.conversation.playerNames, {
    worldId,
    playerId: playerIdArg,
    otherPlayerId: otherPlayerIdArg,
  });
  if (!names) return null;

  // --- build the dialogue exactly as upstream does -------------------------
  const messages = await ctx.runQuery(api.messages.listMessages, { worldId, conversationId });
  let strDialogue = '';
  for (const message of messages) {
    const author = message.author === playerIdArg ? names.player : names.otherPlayer;
    strDialogue += `[${author}]: ${message.text}\n`;
  }
  const speaker = fullName(twin.scratch as Scratch);
  strDialogue += `[${speaker}]: [Fill in]\n`;

  // --- the WHOLE dialogue is the retrieval anchor ---------------------------
  // Not a summary, not the last line — matching interaction.py:183. This is why
  // a twin's replies stay grounded as a conversation develops: the anchor moves
  // with the conversation, so retrieval follows it.
  const ranked = await retrieveMemories(
    ctx,
    playerIdArg,
    await embed(strDialogue),
    RETRIEVAL_N_COUNT,
  );

  const agentDesc = renderFaithful(
    twin.scratch as Scratch,
    ranked.map((r) => r.memory) as never,
    true,
  );

  const result = await complete({
    route: 'salient', // dialogue is the most visible thing a twin does
    cachedPrefix: {
      // NOTE: this is ~16 tokens, far below every model's minimum cacheable
      // prefix, so dialogue currently never caches. That is a known cost gap,
      // not an oversight: the whole agent description (scratch + up to 120
      // retrieved memories) is anchor-dependent here, because the anchor IS the
      // running dialogue — it changes every turn by construction.
      //
      // Fixing it means the same two-tier split decide.ts uses: a stable core
      // identity block above the breakpoint, anchor-specific memories below.
      // Deferred until the two-tier A/B settles, so we're not caching a prompt
      // shape we may revert. Tracked in FIDELITY.md.
      text: 'You write the next line of dialogue for a specific real person.',
      ttl: '1h',
    },
    volatile: renderTemplate('interaction/utternace/utterance_v1', [
      agentDesc,
      contextFor(kind, names.otherPlayer),
      strDialogue,
    ]),
    effort: 'high',
    maxTokens: 2_000,
  });

  const utterance = extractUtterance(result.text);
  if (!utterance) {
    // Upstream's fail-safe is None and the caller copes. Returning null hands
    // this turn to ai-town's path rather than emitting raw JSON into the chat.
    console.warn(`[gatherville] utterance parse failed for twin ${twin._id}`);
    return null;
  }

  await ctx.runMutation(internal.gatherville.traces.append, {
    twinId: twin._id,
    playerId: playerIdArg,
    worldId,
    kind: 'utterance',
    observation: strDialogue,
    action: utterance,
    model: result.model,
    effort: 'high',
    prefixDigest: twin.prefixDigest,
    tokens: result.usage,
    costMicros: result.costMicros,
  });

  return utterance;
}

/** Names only — the twin's own name comes from `scratch`, not the sprite. */
export const playerNames = internalQuery({
  args: { worldId: v.id('worlds'), playerId, otherPlayerId: playerId },
  handler: async (
    ctx,
    args,
  ): Promise<{ player: string; otherPlayer: string } | null> => {
    const world = await ctx.db.get(args.worldId);
    if (!world) return null;
    const describe = async (id: string) => {
      const desc = await ctx.db
        .query('playerDescriptions')
        .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', id))
        .first();
      return desc?.name ?? id;
    };
    return {
      player: await describe(args.playerId),
      otherPlayer: await describe(args.otherPlayerId),
    };
  },
});
