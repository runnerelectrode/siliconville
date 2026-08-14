// Population counts for the town.
//
// "Residents" is everyone with a sprite; "twins" is the subset backed by a real
// person's interview. The gap between them is the honest number — a town of 8
// residents where 1 is a twin is a demo, and the counter should say so rather
// than flattering us with a single blended figure.

import { query } from '../_generated/server';

export type Population = {
  /** Players in the default world — twins plus population NPCs. */
  residents: number;
  /** Backed by a real interview. */
  twins: number;
  /** Twins currently bound to a sprite (a twin can exist before it's placed). */
  placed: number;
};

export const counts = query({
  args: {},
  handler: async (ctx): Promise<Population> => {
    // Resolve the SAME way twins.defaultWorld does, and for the same reason.
    //
    // This asked for isDefault === true. Siliconville is created with
    // isDefault: false — deliberately, so it could coexist with the original
    // ai-town world — and on a fresh deployment it is now the ONLY world. So
    // this found nothing and reported 0 residents for a city that had people
    // in it, which reads as "my character went somewhere else" rather than
    // "the counter is looking at the wrong world".
    const siliconvilleMap = await ctx.db
      .query('maps')
      .filter((q) => q.eq(q.field('tileSetUrl'), '/assets/siliconville.png'))
      .first();
    const worldStatus = siliconvilleMap
      ? await ctx.db
          .query('worldStatus')
          .withIndex('worldId', (q) => q.eq('worldId', siliconvilleMap.worldId))
          .unique()
      : await ctx.db
          .query('worldStatus')
          .filter((q) => q.eq(q.field('isDefault'), true))
          .unique();

    const world = worldStatus ? await ctx.db.get(worldStatus.worldId) : null;

    // Full scans. Fine at demo scale and honest about it: if this ever holds
    // meaningful numbers of twins, replace with a maintained counter rather
    // than reading every row on every subscriber's poll.
    const twins = await ctx.db.query('twins').collect();

    return {
      residents: world?.players.length ?? 0,
      twins: twins.length,
      placed: twins.filter((t) => t.playerId !== undefined).length,
    };
  },
});
