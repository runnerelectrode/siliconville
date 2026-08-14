import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { WorldMap, serializedWorldMap } from './worldMap';
import { rememberConversation } from '../agent/memory';
import { GameId, agentId, conversationId, playerId } from './ids';
import {
  continueConversationMessage,
  leaveConversationMessage,
  startConversationMessage,
} from '../agent/conversation';
import { assertNever } from '../util/assertNever';
import { serializedAgent } from './agent';
import { ACTIVITIES, ACTIVITY_COOLDOWN, CONVERSATION_COOLDOWN } from '../constants';
import { api, internal } from '../_generated/api';
import { sleep } from '../util/sleep';
import { serializedPlayer } from './player';
import { twinUtterance } from '../gatherville/conversation';

export const agentRememberConversation = internalAction({
  args: {
    worldId: v.id('worlds'),
    playerId,
    agentId,
    conversationId,
    operationId: v.string(),
  },
  handler: async (ctx, args) => {
    await rememberConversation(
      ctx,
      args.worldId,
      args.agentId as GameId<'agents'>,
      args.playerId as GameId<'players'>,
      args.conversationId as GameId<'conversations'>,
    );
    await sleep(Math.random() * 1000);
    await ctx.runMutation(api.aiTown.main.sendInput, {
      worldId: args.worldId,
      name: 'finishRememberConversation',
      args: {
        agentId: args.agentId,
        operationId: args.operationId,
      },
    });
  },
});

export const agentGenerateMessage = internalAction({
  args: {
    worldId: v.id('worlds'),
    playerId,
    agentId,
    conversationId,
    otherPlayerId: playerId,
    operationId: v.string(),
    type: v.union(v.literal('start'), v.literal('continue'), v.literal('leave')),
    messageUuid: v.string(),
  },
  handler: async (ctx, args) => {
    let completionFn;
    switch (args.type) {
      case 'start':
        completionFn = startConversationMessage;
        break;
      case 'continue':
        completionFn = continueConversationMessage;
        break;
      case 'leave':
        completionFn = leaveConversationMessage;
        break;
      default:
        assertNever(args.type);
    }
    // GATHERVILLE: twins speak from their own memory stream via genagents'
    // utterance template. Population NPCs have no twin record and fall through
    // to upstream's generic prompts, which is correct — they have no interview
    // to ground dialogue in. `twinUtterance` returns null in that case, and also
    // if the response fails to parse, so a failure degrades to ai-town rather
    // than dropping the turn.
    const twinText = await twinUtterance(
      ctx,
      args.worldId,
      args.conversationId as GameId<'conversations'>,
      args.playerId as GameId<'players'>,
      args.otherPlayerId as GameId<'players'>,
      args.type,
    );

    const text =
      twinText ??
      (await completionFn(
        ctx,
        args.worldId,
        args.conversationId as GameId<'conversations'>,
        args.playerId as GameId<'players'>,
        args.otherPlayerId as GameId<'players'>,
      ));

    await ctx.runMutation(internal.aiTown.agent.agentSendMessage, {
      worldId: args.worldId,
      conversationId: args.conversationId,
      agentId: args.agentId,
      playerId: args.playerId,
      text,
      messageUuid: args.messageUuid,
      leaveConversation: args.type === 'leave',
      operationId: args.operationId,
    });
  },
});

export const agentDoSomething = internalAction({
  args: {
    worldId: v.id('worlds'),
    player: v.object(serializedPlayer),
    agent: v.object(serializedAgent),
    map: v.object(serializedWorldMap),
    otherFreePlayers: v.array(v.object(serializedPlayer)),
    operationId: v.string(),
  },
  handler: async (ctx, args) => {
    const { player, agent } = args;
    const map = new WorldMap(args.map);
    const now = Date.now();
    // Don't try to start a new conversation if we were just in one.
    const justLeftConversation =
      agent.lastConversation && now < agent.lastConversation + CONVERSATION_COOLDOWN;
    // Don't try again if we recently tried to find someone to invite.
    const recentlyAttemptedInvite =
      agent.lastInviteAttempt && now < agent.lastInviteAttempt + CONVERSATION_COOLDOWN;
    const recentActivity = player.activity && now < player.activity.until + ACTIVITY_COOLDOWN;
    // Decide whether to do an activity or wander somewhere.
    if (!player.pathfinding) {
      if (recentActivity || justLeftConversation) {
        await sleep(Math.random() * 1000);
        await ctx.runMutation(api.aiTown.main.sendInput, {
          worldId: args.worldId,
          name: 'finishDoSomething',
          args: {
            operationId: args.operationId,
            agentId: agent.id,
            destination: wanderDestination(map),
          },
        });
        return;
      } else {
        // GATHERVILLE: upstream picked uniformly at random from a three-item
        // ACTIVITIES list (read a book / daydream / garden), with a TODO to let
        // the model choose. Three options make every life look identical no
        // matter how well the model knows the person — the menu was the
        // bottleneck, not the brain. Lives now say what they do next in their
        // own words, grounded in their own memories.
        //
        // `decide` returns null when the cadence gate declines, which at
        // ambient tiers is most ticks. That path costs nothing and falls back to
        // the old random pick so the life still looks alive between decisions.
        const twin = await ctx.runQuery(internal.gatherville.twins.byPlayerId, {
          playerId: player.id,
        });

        let chosen: { description: string; emoji: string; duration: number } | null = null;
        if (twin) {
          const decision = await ctx.runAction(internal.gatherville.decide.decide, {
            twinId: twin._id,
            playerId: player.id,
            worldId: args.worldId,
            situation: describeSituation(player, args.otherFreePlayers, map),
            // No candidates — free-form. See FREEFORM_ACTION_SCHEMA.
            kind: 'action',
          });
          if (decision?.action) {
            chosen = {
              description: decision.action,
              emoji: decision.emoji ?? '💭',
              duration: 60_000,
            };
          }
        }

        const activity = chosen ?? ACTIVITIES[Math.floor(Math.random() * ACTIVITIES.length)];
        await sleep(Math.random() * 1000);
        await ctx.runMutation(api.aiTown.main.sendInput, {
          worldId: args.worldId,
          name: 'finishDoSomething',
          args: {
            operationId: args.operationId,
            agentId: agent.id,
            activity: {
              description: activity.description,
              emoji: activity.emoji,
              until: Date.now() + activity.duration,
            },
          },
        });
        return;
      }
    }
    const invitee =
      justLeftConversation || recentlyAttemptedInvite
        ? undefined
        : await ctx.runQuery(internal.aiTown.agent.findConversationCandidate, {
            now,
            worldId: args.worldId,
            player: args.player,
            otherFreePlayers: args.otherFreePlayers,
          });

    // TODO: We hit a lot of OCC errors on sending inputs in this file. It's
    // easy for them to get scheduled at the same time and line up in time.
    await sleep(Math.random() * 1000);
    await ctx.runMutation(api.aiTown.main.sendInput, {
      worldId: args.worldId,
      name: 'finishDoSomething',
      args: {
        operationId: args.operationId,
        agentId: args.agent.id,
        invitee,
      },
    });
  },
});

function wanderDestination(worldMap: WorldMap) {
  // Wander someonewhere at least one tile away from the edge.
  return {
    x: 1 + Math.floor(Math.random() * (worldMap.width - 2)),
    y: 1 + Math.floor(Math.random() * (worldMap.height - 2)),
  };
}

// GATHERVILLE: renders the twin's current situation as prose. This string is
// both the decision context AND the retrieval anchor — matching genagents,
// where the anchor is the question text or the running dialogue
// (docs/GENAGENTS-ANALYSIS.md §3.2). Keep it stable in phrasing: it feeds an
// embedding, so gratuitous variation is retrieval noise.
function describeSituation(
  player: { position: { x: number; y: number }; activity?: { description: string } | null },
  otherFreePlayers: { position: { x: number; y: number } }[],
  map: WorldMap,
): string {
  const nearby = otherFreePlayers.filter(
    (p) => Math.abs(p.position.x - player.position.x) < 6 &&
           Math.abs(p.position.y - player.position.y) < 6,
  ).length;

  const parts: string[] = [];
  parts.push(`I am somewhere in town.`);
  if (player.activity?.description) {
    parts.push(`I was just ${player.activity.description}.`);
  }
  parts.push(
    nearby === 0
      ? `There is nobody nearby.`
      : nearby === 1
        ? `There is one other person nearby.`
        : `There are ${nearby} other people nearby.`,
  );
  parts.push(`I have free time and need to decide what to do next.`);
  return parts.join(' ');
}
