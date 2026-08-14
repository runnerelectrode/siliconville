// Prompt assembly.
//
// Two modes:
//
//   renderFaithful()  — byte-identical to genagents' `_main_agent_desc`.
//                       Used by the conformance harness and as the fallback if
//                       the two-tier A/B loses.
//   buildTwoTier()    — DEVIATION. Splits the description at a cache breakpoint
//                       so the stable half can be cached. See below.
//
// Why the deviation exists: genagents puts up to 120 anchor-dependent memory
// contents into every prompt, and only `str(scratch)` (~200 tokens) is stable.
// That is backwards for prompt caching — the stable prefix falls under Opus 5's
// 512-token minimum, so nothing caches and every decision pays full input price.
// docs/GENAGENTS-ANALYSIS.md §5.

import type { Memory } from './memory';

// ---------------------------------------------------------------------------
// Scratch rendering
// ---------------------------------------------------------------------------

export type Scratch = {
  firstName: string;
  lastName?: string;
  age?: number;
  location?: string;
  occupation?: string;
  household?: string;
  extra?: Record<string, string>;
};

/**
 * DEVIATION (register #8). genagents uses `str(self.scratch)` — a raw Python
 * dict repr, e.g. `{'first_name': 'Jane', 'age': 34}`. We render typed fields.
 *
 * Arguably a fix, but it changes prompt bytes, so it is a deviation and not an
 * "improvement": the conformance harness runs in faithful mode with
 * `pythonDictRepr: true` so a real drift still fails the diff.
 */
export function renderScratch(scratch: Scratch, pythonDictRepr = false): string {
  if (pythonDictRepr) {
    const entries: string[] = [];
    const push = (k: string, val: unknown) => {
      if (val === undefined || val === null) return;
      entries.push(typeof val === 'number' ? `'${k}': ${val}` : `'${k}': '${val}'`);
    };
    push('first_name', scratch.firstName);
    push('last_name', scratch.lastName);
    push('age', scratch.age);
    push('location', scratch.location);
    push('occupation', scratch.occupation);
    push('household', scratch.household);
    for (const [k, val] of Object.entries(scratch.extra ?? {})) push(k, val);
    return `{${entries.join(', ')}}`;
  }

  const lines: string[] = [];
  const name = [scratch.firstName, scratch.lastName].filter(Boolean).join(' ');
  if (name) lines.push(`Name: ${name}`);
  if (scratch.age !== undefined) lines.push(`Age: ${scratch.age}`);
  if (scratch.location) lines.push(`Location: ${scratch.location}`);
  if (scratch.occupation) lines.push(`Occupation: ${scratch.occupation}`);
  if (scratch.household) lines.push(`Household: ${scratch.household}`);
  for (const [k, val] of Object.entries(scratch.extra ?? {})) lines.push(`${k}: ${val}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Faithful mode
// ---------------------------------------------------------------------------

/**
 * Byte-identical port of `_main_agent_desc` / `_utterance_agent_desc`
 * (which are the same function upstream — GENAGENTS-ANALYSIS.md §3.1).
 *
 * Upstream, exactly:
 *   agent_desc += f"Self description: {agent.get_self_description()}\n==\n"
 *   agent_desc += f"Other observations about the subject:\n\n"
 *   for node in nodes: agent_desc += f"{node.content}\n"
 */
export function renderFaithful(scratch: Scratch, memories: Memory[], pythonDictRepr = true): string {
  let out = `Self description: ${renderScratch(scratch, pythonDictRepr)}\n==\n`;
  out += `Other observations about the subject:\n\n`;
  for (const m of memories) out += `${m.description}\n`;
  return out;
}

// ---------------------------------------------------------------------------
// Two-tier mode
// ---------------------------------------------------------------------------

/** Frozen. Any edit invalidates every cached prefix in the system. Version it. */
export const SIMULATION_RULES = `You are simulating a specific real person inside a small town.
You act as that person would act, not as an assistant would.
Ground every choice in what you know about the subject below.
When the subject's stated values and actual behaviour conflict, behave as the
observations suggest they actually behave, not as they say they would.`.trim();

export type TwoTierPrompt = {
  /** Byte-stable per (twin, prefixVersion). Sits above the cache breakpoint. */
  cachedPrefix: string;
  /** Varies per call. Sits below the breakpoint. */
  volatile: string;
  approxPrefixTokens: number;
};

export function buildTwoTier(args: {
  scratch: Scratch;
  /** Anchor-independent, importance-ranked. From memory.coreIdentitySet. */
  coreIdentity: Memory[];
  /** Anchor-specific, from the faithful retrieval ranking. */
  retrieved: Memory[];
  /** The situation the twin is deciding about. */
  situation: string;
  /** Discrete options, when the action space is enumerable. */
  candidates?: string[];
}): TwoTierPrompt {
  let cachedPrefix = `${SIMULATION_RULES}\n\n`;
  cachedPrefix += `Self description: ${renderScratch(args.scratch)}\n==\n`;
  cachedPrefix += `Core observations about the subject:\n\n`;
  for (const m of args.coreIdentity) cachedPrefix += `${m.description}\n`;

  let volatile = `Additional observations relevant to right now:\n\n`;
  for (const m of args.retrieved) volatile += `${m.description}\n`;
  volatile += `\n==\nCurrent situation:\n${args.situation}\n`;
  if (args.candidates?.length) {
    volatile += `\nOptions:\n`;
    args.candidates.forEach((c, i) => (volatile += `${i + 1}. ${c}\n`));
  }

  return {
    cachedPrefix,
    volatile,
    // ~4 chars/token is close enough to decide whether we clear the 512-token
    // minimum cacheable prefix. Exact counts come from usage on the response.
    approxPrefixTokens: Math.ceil(cachedPrefix.length / 4),
  };
}

// ---------------------------------------------------------------------------
// Prefix digest
// ---------------------------------------------------------------------------

/**
 * FNV-1a over the cached prefix. Stored on the twin and stamped onto every
 * trace, so we can (a) detect accidental prefix churn — the thing that silently
 * destroys cache hit rate — and (b) group traces by identity version when
 * building training sets.
 */
export function prefixDigest(prefix: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < prefix.length; i++) {
    hash ^= prefix.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Output schemas — genagents templates all specify JSON
// ---------------------------------------------------------------------------

export const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', description: 'The chosen action, verbatim from the options if given.' },
    rationale: { type: 'string', description: "Why, in the subject's own voice." },
  },
  required: ['action', 'rationale'],
  additionalProperties: false,
} as const;

/**
 * Free-form action. Used when there is no candidate list.
 *
 * ai-town shipped a three-item ACTIVITIES menu (read a book / daydream /
 * garden) with a TODO to let the model choose instead. Picking from three
 * options makes every life look identical no matter how well the model knows
 * the person — the bottleneck is the menu, not the brain.
 */
export const FREEFORM_ACTION_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      description:
        'A short present-participle phrase for what this person does next, e.g. ' +
        '"revising for tomorrow\'s exam". Must be something THIS person plausibly ' +
        'does, drawn from their own life, not a generic pastime.',
    },
    emoji: { type: 'string', description: 'One emoji for the action.' },
    rationale: { type: 'string', description: "Why, in the subject's own voice." },
  },
  required: ['action', 'emoji', 'rationale'],
  additionalProperties: false,
} as const;

export const UTTERANCE_SCHEMA = {
  type: 'object',
  properties: { utterance: { type: 'string' } },
  required: ['utterance'],
  additionalProperties: false,
} as const;
