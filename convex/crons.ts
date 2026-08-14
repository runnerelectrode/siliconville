import { cronJobs } from 'convex/server';
import { DELETE_BATCH_SIZE, VACUUM_MAX_AGE } from './constants';
import { TRACE_EXPORT_INTERVAL_MS } from './gatherville/constants';
import { internal } from './_generated/api';
import { internalMutation } from './_generated/server';
import { TableNames } from './_generated/dataModel';
import { v } from 'convex/values';

const crons = cronJobs();

// GATHERVILLE: `stopInactiveWorlds` is registered again, and the reasoning that
// removed it was wrong.
//
// It said: "continuity is free and only LLM decisions cost money", so a world
// could run 24/7 with cadence tiering standing in for pausing. That holds for
// tokens and not for the database. Every engine step rewrites the WHOLE world
// document — at 72 residents in Siliconville that document reached 31 MiB, and
// the step rate is about one per second. The deployment ran out of its plan's
// database bandwidth and was disabled, taking the interview and the city with
// it. Continuity is not free; it costs bandwidth proportional to world size
// times step rate, and it was being paid every second for a city nobody was
// looking at.
//
// Cadence tiering still does its job for LLM spend. This handles the other axis.
// The city is for people who signed up, and nobody else. This evicts residents
// with no `twins` row behind them — the synthetic cast the world used to seed
// itself with. On a cron rather than run once by hand, because the ~72 already
// in the world document resume writing the moment the engine is kicked, and
// the cleanup has to be waiting for them.
crons.interval('evict synthetic residents', { minutes: 5 }, internal.siliconville.evictSyntheticResidents);

crons.interval('stop inactive worlds', { seconds: 60 }, internal.world.stopInactiveWorlds);

// NOTE the ordering hazard: this restarts worlds whose engine has died, and it
// deliberately does NOT resurrect one that stopInactiveWorlds paused — that
// sets status to 'inactive', and restartDeadWorlds only revives 'running'
// worlds whose engine stalled. Without that distinction the two crons would
// fight, one stopping the world and the other starting it a minute later,
// which is roughly what has been happening.
crons.interval('restart dead worlds', { seconds: 60 }, internal.world.restartDeadWorlds);

// Decay cadence tiers for unwatched twins: observed -> active -> ambient -> dormant.
crons.interval('decay cadence tiers', { seconds: 60 }, internal.gatherville.cadence.decayTiers);

// Export traces to durable storage. MUST stay ahead of the vacuum below — the
// vacuum drops rows that the RL corpus is built from.
crons.interval(
  'export traces',
  { seconds: TRACE_EXPORT_INTERVAL_MS / 1000 },
  internal.gatherville.traces.exportPendingTraces,
);

crons.daily('vacuum old entries', { hourUTC: 4, minuteUTC: 20 }, internal.crons.vacuumOldEntries);

export default crons;

// GATHERVILLE: `memories` and `memoryEmbeddings` are REMOVED from this list.
//
// Upstream treated memories as disposable cache. For us they are the twin — a
// vacuumed identity is a twin that forgets who it is — and interview-derived
// rows are irreplaceable user-supplied data we promised to hold under consent.
// `traces` is likewise never vacuumed here; it is the RL corpus, and it is
// pruned only after export (see `vacuumGuard` in gatherville/traces.ts).
//
// Embedding growth still needs managing eventually; the answer is consolidation
// of low-importance simulated memories, not blanket deletion by age.
const TablesToVacuum: TableNames[] = [
  // Un-comment this to also clean out old conversations.
  // 'conversationMembers', 'conversations', 'messages',

  // Inputs aren't useful unless you're trying to replay history.
  'inputs',
];

export const vacuumOldEntries = internalMutation({
  args: {},
  handler: async (ctx, args) => {
    const before = Date.now() - VACUUM_MAX_AGE;
    for (const tableName of TablesToVacuum) {
      console.log(`Checking ${tableName}...`);
      const exists = await ctx.db
        .query(tableName)
        .withIndex('by_creation_time', (q) => q.lt('_creationTime', before))
        .first();
      if (exists) {
        console.log(`Vacuuming ${tableName}...`);
        await ctx.scheduler.runAfter(0, internal.crons.vacuumTable, {
          tableName,
          before,
          cursor: null,
          soFar: 0,
        });
      }
    }
  },
});

export const vacuumTable = internalMutation({
  args: {
    tableName: v.string(),
    before: v.number(),
    cursor: v.union(v.string(), v.null()),
    soFar: v.number(),
  },
  handler: async (ctx, { tableName, before, cursor, soFar }) => {
    const results = await ctx.db
      .query(tableName as TableNames)
      .withIndex('by_creation_time', (q) => q.lt('_creationTime', before))
      .paginate({ cursor, numItems: DELETE_BATCH_SIZE });
    for (const row of results.page) {
      await ctx.db.delete(row._id);
    }
    if (!results.isDone) {
      await ctx.scheduler.runAfter(0, internal.crons.vacuumTable, {
        tableName,
        before,
        soFar: results.page.length + soFar,
        cursor: results.continueCursor,
      });
    } else {
      console.log(`Vacuumed ${soFar + results.page.length} entries from ${tableName}`);
    }
  },
});
