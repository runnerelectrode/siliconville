import { v } from 'convex/values';
import { agentId, conversationId, parseGameId, playerId } from './ids';
import { Player, activity } from './player';
import { Conversation, conversationInputs } from './conversation';
import { blocked, movePlayer, stopPlayer } from './movement';
import { inputHandler } from './inputHandler';
import { point } from '../util/types';
import { Descriptions } from '../../data/characters';
import { AgentDescription } from './agentDescription';
import { Agent } from './agent';

export const agentInputs = {
  finishRememberConversation: inputHandler({
    args: {
      operationId: v.string(),
      agentId,
    },
    handler: (game, now, args) => {
      const agentId = parseGameId('agents', args.agentId);
      const agent = game.world.agents.get(agentId);
      if (!agent) {
        throw new Error(`Couldn't find agent: ${agentId}`);
      }
      if (
        !agent.inProgressOperation ||
        agent.inProgressOperation.operationId !== args.operationId
      ) {
        console.debug(`Agent ${agentId} isn't remembering ${args.operationId}`);
      } else {
        delete agent.inProgressOperation;
        delete agent.toRemember;
      }
      return null;
    },
  }),
  finishDoSomething: inputHandler({
    args: {
      operationId: v.string(),
      agentId: v.id('agents'),
      destination: v.optional(point),
      invitee: v.optional(v.id('players')),
      activity: v.optional(activity),
    },
    handler: (game, now, args) => {
      const agentId = parseGameId('agents', args.agentId);
      const agent = game.world.agents.get(agentId);
      if (!agent) {
        throw new Error(`Couldn't find agent: ${agentId}`);
      }
      if (
        !agent.inProgressOperation ||
        agent.inProgressOperation.operationId !== args.operationId
      ) {
        console.debug(`Agent ${agentId} didn't have ${args.operationId} in progress`);
        return null;
      }
      delete agent.inProgressOperation;
      const player = game.world.players.get(agent.playerId)!;
      if (args.invitee) {
        const inviteeId = parseGameId('players', args.invitee);
        const invitee = game.world.players.get(inviteeId);
        if (!invitee) {
          throw new Error(`Couldn't find player: ${inviteeId}`);
        }
        Conversation.start(game, now, player, invitee);
        agent.lastInviteAttempt = now;
      }
      if (args.destination) {
        movePlayer(game, now, player, args.destination);
      }
      if (args.activity) {
        player.activity = args.activity;
      }
      return null;
    },
  }),
  agentFinishSendingMessage: inputHandler({
    args: {
      agentId,
      conversationId,
      timestamp: v.number(),
      operationId: v.string(),
      leaveConversation: v.boolean(),
    },
    handler: (game, now, args) => {
      const agentId = parseGameId('agents', args.agentId);
      const agent = game.world.agents.get(agentId);
      if (!agent) {
        throw new Error(`Couldn't find agent: ${agentId}`);
      }
      const player = game.world.players.get(agent.playerId);
      if (!player) {
        throw new Error(`Couldn't find player: ${agent.playerId}`);
      }
      const conversationId = parseGameId('conversations', args.conversationId);
      const conversation = game.world.conversations.get(conversationId);
      if (!conversation) {
        throw new Error(`Couldn't find conversation: ${conversationId}`);
      }
      if (
        !agent.inProgressOperation ||
        agent.inProgressOperation.operationId !== args.operationId
      ) {
        console.debug(`Agent ${agentId} wasn't sending a message ${args.operationId}`);
        return null;
      }
      delete agent.inProgressOperation;
      conversationInputs.finishSendingMessage.handler(game, now, {
        playerId: agent.playerId,
        conversationId: args.conversationId,
        timestamp: args.timestamp,
      });
      if (args.leaveConversation) {
        conversation.leave(game, now, player);
      }
      return null;
    },
  }),
  // GATHERVILLE: create an agent for a real twin.
  //
  // `createAgent` below builds a player from `Descriptions[i]` — one of
  // ai-town's eight invented personas. A twin must not borrow one: its name and
  // identity come from its own interview, and hijacking a stock NPC's body was
  // what left twins sprite-less once we stopped spawning those NPCs.
  //
  // Goes through the input pipeline like everything else, so the engine keeps
  // its single-step-per-world guarantee.
  /**
   * Walk a body in a direction, on behalf of the person it belongs to.
   *
   * Direction rather than a destination: the caller doesn't need to know where
   * the figure currently is, so there's no client/server position to keep in
   * sync and no prediction to reconcile. The engine commits about once a
   * second, and a short hop resolves well within that.
   *
   * Ownership is checked by the caller (siliconville:steer) — this handler
   * runs inside the engine and has no auth context.
   */
  steer: inputHandler({
    args: {
      playerId,
      dx: v.number(),
      dy: v.number(),
      /** How far to try, in tiles. */
      tiles: v.number(),
      /** Tiles per second while a person is driving. */
      speed: v.optional(v.number()),
      /** Release: halt here instead of coasting to a far destination. */
      stop: v.optional(v.boolean()),
      /** Wall-clock ms until which the agent should keep its hands off. */
      until: v.number(),
    },
    handler: (game, now, args) => {
      const playerId = parseGameId('players', args.playerId);
      const player = game.world.players.get(playerId);
      if (!player) {
        throw new Error(`Invalid player ID ${args.playerId}`);
      }

      // Hold the wheel even if the step below finds nowhere to go — otherwise
      // walking into a wall hands control straight back to the agent.
      for (const agent of game.world.agents.values()) {
        if (agent.playerId === playerId) {
          agent.driving = args.until;
          break;
        }
      }

      if (args.stop) {
        // Let go and you stop. Without this the figure keeps walking to a
        // destination up to 24 tiles away long after the key is released,
        // which feels like the controls are ignoring you.
        stopPlayer(player);
        return 'ok';
      }

      // movePlayer throws for a player in a conversation. Throwing here would
      // abort the whole engine step, so refuse — and say so. These outcomes
      // land on the input's returnValue: a refusal that only ever reached the
      // backend logs looked, from the browser, exactly like working controls.
      const talking = [...game.world.conversations.values()].some(
        (c) => c.participants.get(playerId)?.status.kind === 'participating',
      );
      if (talking) return 'in a conversation';

      const len = Math.hypot(args.dx, args.dy) || 1;
      const ux = args.dx / len;
      const uy = args.dy / len;

      // Farthest walkable tile along the ray — scanning PAST obstacles, not
      // stopping at the first one.
      //
      // This used to break on the first blocked tile, which in a city means
      // almost immediately: with a building four tiles ahead you got a
      // three-tile destination, walked into the wall and stopped, and every
      // refresh then found the wall at once and picked nothing. Walking felt
      // like a couple of steps and then dead controls — while the same input
      // crossed twenty tiles of open ground perfectly, which is what made it
      // look intermittent rather than wrong.
      //
      // A* is entirely capable of routing around a building to a destination
      // on the far side. Refusing to look past the first obstacle threw that
      // away. If the far tile turns out to be enclosed, findRoute fails, the
      // player stops, and the next refresh picks again — no worse than here.
      // Destinations must be integral: movePlayer rejects fractions outright.
      let target: { x: number; y: number } | null = null;
      for (let step = 1; step <= Math.max(1, Math.floor(args.tiles)); step++) {
        const candidate = {
          x: Math.round(player.position.x + ux * step),
          y: Math.round(player.position.y + uy * step),
        };
        if (!blocked(game, now, candidate, playerId)) target = candidate;
      }
      if (!target) return 'no walkable tile that way';
      movePlayer(game, now, player, target, false, args.speed);
      return 'ok';
    },
  }),

  createTwinAgent: inputHandler({
    args: {
      name: v.string(),
      character: v.string(),
      identity: v.string(),
    },
    handler: (game, now, args) => {
      const playerId = Player.join(game, now, args.name, args.character, args.identity);
      const agentId = game.allocId('agents');
      game.world.agents.set(
        agentId,
        new Agent({
          id: agentId,
          playerId,
          inProgressOperation: undefined,
          lastConversation: undefined,
          lastInviteAttempt: undefined,
          toRemember: undefined,
        }),
      );
      game.agentDescriptions.set(
        agentId,
        new AgentDescription({
          agentId,
          identity: args.identity,
          // ai-town uses `plan` in its own conversation prompts, which twins
          // bypass entirely (see gatherville/conversation.ts). Left blank rather
          // than inventing a motive the person never stated.
          plan: '',
        }),
      );
      return playerId;
    },
  }),

  createAgent: inputHandler({
    args: {
      descriptionIndex: v.number(),
    },
    handler: (game, now, args) => {
      const description = Descriptions[args.descriptionIndex];
      const playerId = Player.join(
        game,
        now,
        description.name,
        description.character,
        description.identity,
      );
      const agentId = game.allocId('agents');
      game.world.agents.set(
        agentId,
        new Agent({
          id: agentId,
          playerId: playerId,
          inProgressOperation: undefined,
          lastConversation: undefined,
          lastInviteAttempt: undefined,
          toRemember: undefined,
        }),
      );
      game.agentDescriptions.set(
        agentId,
        new AgentDescription({
          agentId: agentId,
          identity: description.identity,
          plan: description.plan,
        }),
      );
      return { agentId };
    },
  }),
};
