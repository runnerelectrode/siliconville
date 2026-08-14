// Interview → twin.
//
// The research protocol is a two-hour American Voices Project interview. Ours is
// ~7 minutes, which is the central product risk: a shallow interview yields a
// twin that reads like a horoscope. The holdout score exists to catch exactly
// that, so it is built here alongside the twin rather than bolted on later.
//
// Pipeline:
//   transcript
//     → extract scratch            (identity facts, cached prompt prefix)
//     → segment into observations  (concrete episodes, not generalities)
//     → score importance           (genagents batch template, 0-100)
//     → embed + insert as 'interview' provenance
//     → generate holdout questions
//   later: scoreHoldouts() asks the twin and compares to the human's answers

import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery, action, query } from '../_generated/server';
import { internal, api } from '../_generated/api';
import { workflow } from './onboarding';
import { Doc, Id } from '../_generated/dataModel';
import { playerId as playerIdValidator } from '../aiTown/ids';
import { complete } from './anthropic';
import { embedMany, embed } from './embeddings';
import { renderTemplate } from './templates';
import {
  extractFirstJsonDict,
  extractImportanceScores,
  extractCategorical,
  extractNumerical,
  extractUtterance,
} from './jsonParser';
import { renderFaithful, Scratch } from './prompt';
import { INTERVIEW_IMPORTANCE_FLOOR, IMPORTANCE_MAX } from './constants';

const MODEL_VERSION = 'gatherville-2026-08-05';

// ---------------------------------------------------------------------------
// The protocol
// ---------------------------------------------------------------------------

/**
 * Seven minutes, four phases. The design intent behind each:
 *
 *  - grounding: cheap factual anchors; populates `scratch`.
 *  - episodes: SPECIFIC recent instances. This is the phase that matters. A
 *    memory stream fed on generalities ("I'm organized") produces a twin that
 *    can only restate traits; one fed on episodes can act.
 *  - tensions: where stated values and actual behaviour diverge. This is what
 *    makes a prediction non-trivial — anyone can predict someone's self-image.
 *  - holdout setup: which domains to score on, so the questions are relevant.
 */
export const PROTOCOL_VERSION = 'gv-7min-v1';

export const INTERVIEW_PHASES = [
  {
    id: 'grounding',
    seconds: 60,
    opener: 'To start — what should I call you, and where do you live?',
    followUpGuidance:
      'Stay factual and quick. You MUST establish their name before leaving this phase — the ' +
      'twin cannot exist without one. Then household, work, and the rough shape of a normal day.',
  },
  {
    id: 'episodes',
    seconds: 180,
    opener: 'Tell me about the last time you changed your mind about something that mattered.',
    followUpGuidance:
      'Push for one SPECIFIC recent instance with concrete detail — when, who was there, what was ' +
      'actually said or done. If they answer in generalities ("I usually..."), ask for the last ' +
      'actual time it happened. Never accept a trait as an answer.',
  },
  {
    id: 'tensions',
    seconds: 120,
    opener: 'Is there something you believe you should do more of, but do not actually do?',
    followUpGuidance:
      'Look for gaps between stated values and behaviour, without judgement. Ask what happens in ' +
      'the moment they choose otherwise. These contradictions are the most predictive material ' +
      'in the whole interview.',
  },
  {
    id: 'holdout-setup',
    seconds: 60,
    opener: 'What kinds of decisions do you think people misjudge about you?',
    followUpGuidance: 'Identify 2-3 domains to score the twin on later.',
  },
] as const;

/** Generates the next interview question, live, from what has been said so far. */
export const nextQuestion = action({
  args: {
    phaseId: v.string(),
    transcriptSoFar: v.string(),
  },
  handler: async (ctx, { phaseId, transcriptSoFar }): Promise<{ question: string }> => {
    const phase = INTERVIEW_PHASES.find((p) => p.id === phaseId);
    if (!phase) throw new Error(`Unknown phase: ${phaseId}`);

    if (!transcriptSoFar.trim()) return { question: phase.opener };

    // Interview quality caps twin quality, so this is one of the few live paths
    // that gets the expensive model.
    const result = await complete({
      route: 'salient',
      cachedPrefix: {
        text:
          `You are conducting a short structured interview whose output will be used to build a ` +
          `behavioural model of the person. Ask ONE question at a time. Never ask two things at ` +
          `once. Never summarise what they said back to them — it wastes their time and adds ` +
          `nothing to the transcript.\n\n` +
          // The phase's SUBJECT, not just its technique. Passing only the
          // guidance ("push for one specific instance") with a transcript full
          // of grounding facts made the model invent a specific instance about
          // whatever was last mentioned — it asked about a disagreement over
          // household chores during the phase that is supposed to be about
          // changing your mind. It obeyed the instruction and lost the subject.
          `This phase is asking about: "${phase.opener}"\n` +
          `Every question you ask in this phase must stay on THAT subject. If their answer ` +
          `drifted, steer back to it rather than following the drift.\n\n` +
          `Current phase: ${phase.id}\n${phase.followUpGuidance}`,
        ttl: '1h',
      },
      volatile: `Transcript so far:\n${transcriptSoFar}\n\nAsk the next question.`,
      effort: 'medium',
      maxTokens: 300,
      jsonSchema: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
        additionalProperties: false,
      },
    });

    const parsed = extractFirstJsonDict(result.text);
    const question = parsed?.question;
    return { question: typeof question === 'string' && question.trim() ? question : phase.opener };
  },
});

// ---------------------------------------------------------------------------
// Transcript → twin
// ---------------------------------------------------------------------------

const SCRATCH_SCHEMA = {
  type: 'object',
  properties: {
    firstName: { type: 'string' },
    lastName: { type: 'string' },
    age: { type: 'number' },
    location: { type: 'string' },
    occupation: { type: 'string' },
    household: { type: 'string' },
  },
  required: ['firstName'],
  additionalProperties: false,
} as const;

const OBSERVATIONS_SCHEMA = {
  type: 'object',
  properties: {
    observations: {
      type: 'array',
      items: { type: 'string' },
      description: 'First-person statements, one concrete fact or episode each.',
    },
  },
  required: ['observations'],
  additionalProperties: false,
} as const;

/**
 * Importance scoring, ported from `generate_importance_score`.
 *
 * Uses the BATCH template. Upstream's `remember()` scores one memory per LLM
 * call even though `batch_v1.txt` exists — fine for a research harness, absurd
 * for an interview that produces 30+ observations at once.
 */
async function scoreImportance(records: string[]): Promise<number[]> {
  const recordsStr = records.map((r, i) => `Item ${i + 1}:\n${r}\n`).join('');
  const key =
    records.length > 1
      ? 'memory_stream/importance_score/batch_v1'
      : 'memory_stream/importance_score/singular_v1';

  const result = await complete({
    route: 'salient',
    cachedPrefix: { text: 'You score observations about a person for importance.', ttl: '1h' },
    volatile: renderTemplate(key, [recordsStr]),
    effort: 'low',
    maxTokens: 2_000,
  });

  // Brace-counted extraction + upstream's fail-safe of 25. A naive
  // slice-from-first-brace breaks whenever the model appends commentary.
  return extractImportanceScores(result.text, records.length).map((n) =>
    Math.max(0, Math.min(IMPORTANCE_MAX, n)),
  );
}

export const buildTwin = internalAction({
  args: {
    userId: v.string(),
    transcript: v.string(),
    audioStorageId: v.optional(v.id('_storage')),
  },
  handler: async (ctx, args): Promise<{ twinId: Id<'twins'>; observationCount: number }> => {
    const interviewId: Id<'interviews'> = await ctx.runMutation(
      internal.gatherville.interview.saveInterview,
      {
        userId: args.userId,
        transcript: args.transcript,
        audioStorageId: args.audioStorageId,
        protocolVersion: PROTOCOL_VERSION,
      },
    );

    // --- 1. scratch -------------------------------------------------------
    const scratchResult = await complete({
      route: 'salient',
      cachedPrefix: {
        text:
          'Extract stable identity facts from an interview transcript. Include only what the ' +
          'person actually stated or clearly implied. Do not infer, and do not fill gaps with ' +
          'plausible-sounding detail — an invented fact here propagates into every future prompt.\n\n' +
          'firstName is the one field that must be a real value. If the transcript genuinely ' +
          'never names them, return an empty string rather than guessing — the caller handles ' +
          'that case. Never substitute a placeholder like "Unknown" or a name you inferred from ' +
          'context such as an employer or city.',
        ttl: '1h',
      },
      volatile: `Transcript:\n${args.transcript}`,
      effort: 'high',
      jsonSchema: SCRATCH_SCHEMA,
    });
    const scratchParsed = extractFirstJsonDict(scratchResult.text);
    if (!scratchParsed) throw new Error(`Could not parse scratch from: ${scratchResult.text.slice(0, 300)}`);
    const scratch = scratchParsed as unknown as Scratch;

    // An empty name is not survivable: it reaches Player.join, the town's name
    // label, and genagents' dialogue prompt as "[]: [Fill in]", which hides who
    // is speaking. Upstream returns "" from get_fullname() in exactly this case
    // and carries on regardless — we refuse instead, because a nameless twin is
    // a broken twin and it is far cheaper to catch here than to debug in-world.
    if (!scratch.firstName || !scratch.firstName.trim()) {
      throw new Error(
        'Interview did not establish a name. The transcript must contain what to call this ' +
          'person — the grounding phase asks for it first. Refusing to build a nameless twin.',
      );
    }

    // --- 2. segment into observations ------------------------------------
    const obsResult = await complete({
      route: 'salient',
      cachedPrefix: {
        text:
          'Segment an interview transcript into discrete first-person observations about the ' +
          'speaker. Rules:\n' +
          '- One concrete fact, episode, preference or belief per observation.\n' +
          '- Write in first person, as the speaker would state it.\n' +
          '- Prefer specific episodes over general traits. "I skipped my sister\'s party because ' +
          'I was tired" is worth more than "I am introverted".\n' +
          '- Preserve contradictions. Do not reconcile them — the gaps between what someone says ' +
          'they value and what they actually do are the most predictive material available.\n' +
          '- Never invent detail that is not in the transcript.',
        ttl: '1h',
      },
      volatile: `Transcript:\n${args.transcript}`,
      effort: 'high',
      maxTokens: 8_000,
      jsonSchema: OBSERVATIONS_SCHEMA,
    });
    const obsParsed = extractFirstJsonDict(obsResult.text);
    const observations = ((obsParsed?.observations as string[]) ?? []).filter((o) => o?.trim());
    if (observations.length === 0) {
      throw new Error(`No observations parsed from: ${obsResult.text.slice(0, 300)}`);
    }

    // --- 3. score + embed + persist --------------------------------------
    const importances = await scoreImportance(observations);
    const embeddings = await embedMany(observations);

    const twinId: Id<'twins'> = await ctx.runMutation(internal.gatherville.twins.create, {
      userId: args.userId,
      interviewId,
      scratch,
      modelVersion: MODEL_VERSION,
    });

    for (let i = 0; i < observations.length; i++) {
      await ctx.runMutation(internal.gatherville.memory.insertMemory, {
        playerId: `interview:${twinId}`, // rebound to a real playerId on world join
        twinId,
        description: observations[i],
        embedding: embeddings[i],
        importance: importances[i],
        // Identity can never be buried under a week of simulated small talk.
        importanceFloor: INTERVIEW_IMPORTANCE_FLOOR,
        provenance: 'interview',
        data: { type: 'identity', segment: 'interview' },
      });
    }

    return { twinId, observationCount: observations.length };
  },
});

/**
 * Public entry point for the client: transcript in, twin + holdout questions out.
 *
 * Holdouts are generated here rather than lazily, because they must be written
 * BEFORE the user sees any twin output. Generating them later — after the user
 * has watched the twin behave — would let the question set be shaped by what the
 * twin already does well, which quietly turns the score into marketing.
 */
export const buildFromTranscript = action({
  args: {
    userId: v.string(),
    transcript: v.string(),
    audioStorageId: v.optional(v.id('_storage')),
  },
  handler: async (ctx, args): Promise<{ twinId: Id<'twins'>; observationCount: number }> => {
    const result = await ctx.runAction(internal.gatherville.interview.buildTwin, args);

    // Hand placement to a durable workflow rather than awaiting it here.
    //
    // It used to be an awaited action whose failure was permanent: the life
    // appeared in the population count with no body and nothing retried it.
    // The retry-on-next-visit heal still exists as a backstop, but it needs
    // somebody to come back — a workflow step finishes on its own, survives a
    // server restart, and backs off between attempts.
    //
    // It also stops making the person wait on the town. The scorecard is what
    // they are here for; whether the engine has drained a spawn input yet is
    // not their problem.
    await workflow.start(ctx, internal.gatherville.onboarding.giveBody, {
      twinId: result.twinId,
    });

    await ctx.runAction(internal.gatherville.interview.generateHoldouts, {
      twinId: result.twinId,
    });
    return result;
  },
});

/** Public wrapper — the client triggers scoring once the user has answered. */
export const runScoring = action({
  args: { twinId: v.id('twins') },
  handler: async (
    ctx,
    { twinId },
  ): Promise<{ overall: number; perDomain: Record<string, number>; answered: number }> => {
    return await ctx.runAction(internal.gatherville.interview.scoreHoldouts, { twinId });
  },
});

export const saveInterview = internalMutation({
  args: {
    userId: v.string(),
    transcript: v.string(),
    audioStorageId: v.optional(v.id('_storage')),
    protocolVersion: v.string(),
  },
  handler: async (ctx, args): Promise<Id<'interviews'>> => {
    return await ctx.db.insert('interviews', { ...args, completedAt: Date.now() });
  },
});

/** Rebind interview memories once the twin has a sprite. */
export const rebindMemories = internalMutation({
  args: { twinId: v.id('twins'), playerId: playerIdValidator },
  handler: async (ctx, { twinId, playerId }) => {
    const memories = await ctx.db
      .query('memories')
      .withIndex('playerId', (q) => q.eq('playerId', `interview:${twinId}`))
      .collect();
    for (const m of memories) {
      await ctx.db.patch(m._id, { playerId });
      const embedding = await ctx.db.get(m.embeddingId);
      if (embedding) await ctx.db.patch(m.embeddingId, { playerId });
    }
  },
});

// ---------------------------------------------------------------------------
// Holdout scoring — the product's credibility
// ---------------------------------------------------------------------------

const HOLDOUT_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          question: { type: 'string' },
          kind: { type: 'string', enum: ['categorical', 'numeric'] },
          options: { type: 'array', items: { type: 'string' } },
        },
        required: ['domain', 'question', 'kind', 'options'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
} as const;

/**
 * Generate holdout questions.
 *
 * These must be answerable by the human but NOT stated in the transcript —
 * otherwise the score measures retrieval, not prediction, and flatters us.
 */
export const generateHoldouts = internalAction({
  args: { twinId: v.id('twins'), count: v.optional(v.number()) },
  handler: async (ctx, { twinId, count }): Promise<{ generated: number }> => {
    const twin = await ctx.runQuery(internal.gatherville.interview.getTwin, { twinId });
    if (!twin?.interviewId) throw new Error('Twin has no interview');
    const interview = await ctx.runQuery(internal.gatherville.interview.getInterview, {
      interviewId: twin.interviewId,
    });
    if (!interview) throw new Error('Interview missing');

    const n = count ?? 12;
    const result = await complete({
      route: 'salient',
      cachedPrefix: {
        text:
          `Write ${n} multiple-choice questions to test how well a model of this person can ` +
          `predict them.\n\n` +
          `CRITICAL: the answer must NOT be stated or directly implied in the transcript. A ` +
          `question whose answer appears in the transcript measures retrieval, not prediction, ` +
          `and makes the resulting score meaningless.\n\n` +
          `Ask about concrete situational choices ("you have a free Saturday and two invitations, ` +
          `which do you take"), not self-image ("are you an introvert"). Every option must be ` +
          `genuinely plausible for someone like this — no obviously-wrong filler.`,
        ttl: '1h',
      },
      volatile: `Transcript:\n${interview.transcript}`,
      effort: 'high',
      maxTokens: 6_000,
      jsonSchema: HOLDOUT_SCHEMA,
    });

    const holdoutParsed = extractFirstJsonDict(result.text);
    const questions = (holdoutParsed?.questions ?? []) as {
      domain: string;
      question: string;
      kind: 'categorical' | 'numeric';
      options: string[];
    }[];

    await ctx.runMutation(internal.gatherville.interview.saveHoldouts, { twinId, questions });
    return { generated: questions.length };
  },
});

export const saveHoldouts = internalMutation({
  args: { twinId: v.id('twins'), questions: v.any() },
  handler: async (ctx, { twinId, questions }) => {
    for (const q of questions as any[]) {
      await ctx.db.insert('holdouts', {
        twinId,
        domain: q.domain,
        question: q.question,
        kind: coerceKind(q),
        options: q.options,
      });
    }
  },
});

/**
 * Trust the OPTIONS, not the label the generator put on the question.
 *
 * A question marked `numeric` is asked of the twin as `Range: [...]` and comes
 * back as a bare number, while the human is shown the same `options` as
 * buttons and taps a text label. Scoring is exact string equality, so if the
 * options are text buckets ("More than 4 hours") those two can never match and
 * the item is auto-failed no matter what the twin predicted.
 *
 * That is not hypothetical: it silently zeroed every numeric holdout, which at
 * N=12 moved the headline accuracy by more than 15 points. A question whose
 * options are words is a categorical question regardless of its label.
 */
function coerceKind(q: { kind?: string; options?: unknown }): 'categorical' | 'numeric' | 'open' {
  const kind = (q.kind ?? 'categorical') as 'categorical' | 'numeric' | 'open';
  if (kind !== 'numeric') return kind;
  const opts = Array.isArray(q.options) ? q.options : [];
  const allNumeric =
    opts.length > 0 && opts.every((o) => typeof o === 'number' || /^\s*-?\d+(\.\d+)?\s*$/.test(String(o)));
  if (allNumeric) return 'numeric';
  console.warn(
    `[gatherville] holdout marked numeric but its options are text ` +
      `(${JSON.stringify(opts).slice(0, 80)}) — scoring it as categorical. ` +
      `Left as numeric it would compare a bare number to a text label and always fail.`,
  );
  return 'categorical';
}

/**
 * Ask the twin every unanswered holdout and score it against the human.
 *
 * ⚠️ Questions are asked ONE AT A TIME, deliberately.
 *
 * genagents' `categorical_resp` builds its retrieval anchor as
 * `" ".join(questions.keys())` — batching twelve questions produces one long,
 * semantically muddy anchor and degrades retrieval for every question in the
 * batch (docs/GENAGENTS-ANALYSIS.md §3.2). Batching would be ~12x cheaper and
 * measurably worse, and this number is the product's credibility.
 */
export const scoreHoldouts = internalAction({
  args: { twinId: v.id('twins') },
  handler: async (
    ctx,
    { twinId },
  ): Promise<{ overall: number; perDomain: Record<string, number>; answered: number }> => {
    const twin = await ctx.runQuery(internal.gatherville.interview.getTwin, { twinId });
    if (!twin) throw new Error('No twin');

    const holdouts = await ctx.runQuery(internal.gatherville.interview.pendingHoldouts, { twinId });
    const answerable = holdouts.filter((h) => h.userAnswer !== undefined);

    const results: { holdout: Doc<'holdouts'>; twinAnswer: string; agreed: boolean | undefined }[] = [];

    for (const holdout of answerable) {
      // One question = one anchor = clean retrieval.
      const anchor = holdout.question;
      const memories = await ctx.runAction(internal.gatherville.interview.retrieveForAnchor, {
        playerId: twin.playerId ?? `interview:${twinId}`,
        anchor,
      });

      const agentDesc = renderFaithful(twin.scratch as Scratch, memories as any, true);

      // The three response modes map to three DIFFERENT templates with three
      // different question-block formats. genagents' create_prompt_input:
      //   categorical -> "Q: ...\nOption: [...]"
      //   numerical   -> "Q: ...\nRange: [...]"   <- NOT "Option:"
      //   open        -> no survey template at all; open-ended is `utterance`,
      //                  which takes a dialogue transcript, not a question block.
      let key: string;
      let inputs: (string | number)[];

      if (holdout.kind === 'numeric') {
        const range = JSON.stringify(holdout.options ?? [1, 10]);
        key = 'interaction/numerical_resp/singular_v1';
        inputs = [
          agentDesc,
          `Q: ${holdout.question}\nRange: ${range}`,
          holdout.floatResp ? 'float' : 'integer',
        ];
      } else if (holdout.kind === 'open') {
        // Upstream has no open-ended *survey* mode — `utterance` is the
        // open-ended path, and it expects a dialogue with a trailing
        // "[speaker]: [Fill in]" line (interaction.py:178-181).
        const dialogue =
          `[Interviewer]: ${holdout.question}\n` +
          `[${[twin.scratch.firstName, twin.scratch.lastName].filter(Boolean).join(' ')}]: [Fill in]\n`;
        key = 'interaction/utternace/utterance_v1';
        inputs = [agentDesc, '', dialogue];
      } else {
        key = 'interaction/categorical_resp/singular_v1';
        inputs = [agentDesc, `Q: ${holdout.question}\nOption: ${JSON.stringify(holdout.options ?? [])}`];
      }

      const result = await complete({
        route: 'salient',
        cachedPrefix: { text: 'You predict a specific person\'s survey responses.', ttl: '1h' },
        volatile: renderTemplate(key, inputs),
        effort: 'high',
        maxTokens: 4_000,
      });

      // Upstream scrapes these with regex rather than parsing JSON, so a
      // truncated or malformed response still yields an answer. Note the two
      // kinds differ: categorical Response is a quoted string, numerical is a
      // bare number — treating them identically silently fails on one.
      let twinAnswer: string;
      if (holdout.kind === 'open') {
        twinAnswer = (extractUtterance(result.text) ?? '').trim();
      } else {
        const scraped =
          holdout.kind === 'numeric' ? extractNumerical(result.text) : extractCategorical(result.text);
        twinAnswer = (scraped.responses[0] ?? '').trim();
      }

      // Exact match is only meaningful for closed responses. An open-ended
      // answer needs a judge; scoring it by string equality would report ~0%
      // and make the headline number a lie. Left unscored until that exists.
      const agreed =
        holdout.kind === 'open'
          ? undefined
          : twinAnswer.toLowerCase().trim() === (holdout.userAnswer ?? '').toLowerCase().trim();
      results.push({ holdout, twinAnswer, agreed });
    }

    await ctx.runMutation(internal.gatherville.interview.saveScores, {
      twinId,
      results: results.map((r) => ({
        holdoutId: r.holdout._id,
        twinAnswer: r.twinAnswer,
        agreed: r.agreed,
      })),
    });

    const scored = results.filter((r) => r.agreed !== undefined);
    const perDomain: Record<string, { hit: number; total: number }> = {};
    for (const r of scored) {
      const d = (perDomain[r.holdout.domain] ??= { hit: 0, total: 0 });
      d.total++;
      if (r.agreed) d.hit++;
    }

    return {
      overall: scored.length === 0 ? 0 : scored.filter((r) => r.agreed).length / scored.length,
      perDomain: Object.fromEntries(
        Object.entries(perDomain).map(([k, v]) => [k, v.hit / v.total]),
      ),
      answered: scored.length,
    };
  },
});

/** Wrapper so scoreHoldouts can do vector search (only actions can). */
export const retrieveForAnchor = internalAction({
  args: { playerId: v.string(), anchor: v.string() },
  handler: async (ctx, { playerId, anchor }) => {
    const { retrieveMemories } = await import('./memory');
    const ranked = await retrieveMemories(ctx, playerId, await embed(anchor), 120);
    return ranked.map((r) => r.memory);
  },
});

export const saveScores = internalMutation({
  args: { twinId: v.id('twins'), results: v.any() },
  handler: async (ctx, { results }) => {
    for (const r of results as any[]) {
      await ctx.db.patch(r.holdoutId, { twinAnswer: r.twinAnswer, agreed: r.agreed });
    }
  },
});

export const recordUserAnswer = action({
  args: { holdoutId: v.id('holdouts'), answer: v.string() },
  handler: async (ctx, { holdoutId, answer }) => {
    await ctx.runMutation(internal.gatherville.interview.patchUserAnswer, { holdoutId, answer });
  },
});

export const patchUserAnswer = internalMutation({
  args: { holdoutId: v.id('holdouts'), answer: v.string() },
  handler: async (ctx, { holdoutId, answer }) => {
    await ctx.db.patch(holdoutId, { userAnswer: answer });
  },
});

// --- queries ---------------------------------------------------------------

export const getTwin = internalQuery({
  args: { twinId: v.id('twins') },
  handler: async (ctx, { twinId }): Promise<Doc<'twins'> | null> => await ctx.db.get(twinId),
});

export const getInterview = internalQuery({
  args: { interviewId: v.id('interviews') },
  handler: async (ctx, { interviewId }): Promise<Doc<'interviews'> | null> =>
    await ctx.db.get(interviewId),
});

export const pendingHoldouts = internalQuery({
  args: { twinId: v.id('twins') },
  handler: async (ctx, { twinId }): Promise<Doc<'holdouts'>[]> => {
    const all = await ctx.db
      .query('holdouts')
      .withIndex('twinId', (q) => q.eq('twinId', twinId))
      .collect();
    // Only score what the human has actually answered — an unanswered holdout
    // has no ground truth, and scoring against a guess would inflate the number.
    return all.filter((h) => h.agreed === undefined);
  },
});

export const scorecard = query({
  args: { twinId: v.id('twins') },
  handler: async (ctx, { twinId }) => {
    const holdouts = await ctx.db
      .query('holdouts')
      .withIndex('twinId', (q) => q.eq('twinId', twinId))
      .collect();
    const scored = holdouts.filter((h) => h.agreed !== undefined);
    const perDomain: Record<string, { hit: number; total: number }> = {};
    for (const h of scored) {
      const d = (perDomain[h.domain] ??= { hit: 0, total: 0 });
      d.total++;
      if (h.agreed) d.hit++;
    }
    return {
      overall: scored.length === 0 ? null : scored.filter((h) => h.agreed).length / scored.length,
      answered: scored.length,
      total: holdouts.length,
      perDomain: Object.fromEntries(
        Object.entries(perDomain).map(([k, v]) => [k, v.hit / v.total]),
      ),
      holdouts,
    };
  },
});
