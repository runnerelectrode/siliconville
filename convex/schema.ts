import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
// GATHERVILLE: `agentTables` (./agent/schema) is superseded by `gathervilleTables`.
// It defined a separate `memories`/`memoryEmbeddings` pair with no `provenance`
// field and importance on a 0-9 scale. See docs/GENAGENTS-ANALYSIS.md §2.1.
import { gathervilleTables } from './gatherville/schema';
import { aiTownTables } from './aiTown/schema';
import { conversationId, playerId } from './aiTown/ids';
import { engineTables } from './engine/schema';

export default defineSchema({
  music: defineTable({
    storageId: v.string(),
    type: v.union(v.literal('background'), v.literal('player')),
  }),

  messages: defineTable({
    conversationId,
    messageUuid: v.string(),
    author: playerId,
    text: v.string(),
    worldId: v.optional(v.id('worlds')),
  })
    .index('conversationId', ['worldId', 'conversationId'])
    .index('messageUuid', ['conversationId', 'messageUuid']),

  // Humans talking about the city, not agents talking to each other. Agent
  // dialogue lives in `messages` above and is per-conversation; this is one
  // room for whoever happens to be watching.
  cityChat: defineTable({
    name: v.string(),
    text: v.string(),
    // Client-generated, kept only to rate-limit and to let someone delete
    // their own line later. Not an identity and not trusted as one.
    sessionId: v.string(),
  }).index('bySession', ['sessionId']),

  ...gathervilleTables,
  ...aiTownTables,
  ...engineTables,
});
