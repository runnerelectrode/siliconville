// Durable onboarding: the steps that must survive the user closing the tab.
//
// Placement was a plain awaited action inside buildFromTranscript, and its
// failure was permanent — the life showed up in the population count with no
// body, and nothing anywhere retried it. That is the bug class this component
// exists to delete: a workflow step runs to completion even across server
// restarts, and retries transient failures with backoff.
//
// It also stops blocking onboarding on the town. The scorecard is the thing
// the person is waiting for; whether the engine has processed a spawn input
// yet is the town's problem, and making somebody watch a spinner for it was
// never right.

import { v } from 'convex/values';
import { WorkflowManager } from '@convex-dev/workflow';
import { components, internal } from '../_generated/api';

export const workflow = new WorkflowManager(components.workflow);

export const giveBody = workflow
  .define({
    args: { twinId: v.id('twins') },
  })
  .handler(async (step, args): Promise<void> => {
    // Retried: the usual failure is the engine being paused with nobody
    // watching, so the spawn input sits unprocessed until the poll times out.
    // placeInWorld wakes the world itself, but a cold start can still lose the
    // race, and losing it should cost a retry rather than a body.
    await step.runAction(
      internal.gatherville.twins.placeInWorld,
      { twinId: args.twinId },
      { retry: { maxAttempts: 4, initialBackoffMs: 2_000, base: 2 } },
    );
  });
