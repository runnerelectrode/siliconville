// Pure retrieval scoring — port of genagents' `memory_stream.py`.
//
// DELIBERATELY FREE OF CONVEX IMPORTS. This file is imported both by the Convex
// runtime and by the offline conformance harness (training/conformance), which
// diffs it against the Python original. Adding a Convex import here breaks that
// harness and removes our only mechanical guard against fidelity drift.
//
// Fidelity contract (docs/FIDELITY.md tier 1):
//   hp = [recency 0, relevance 1, importance 0.5]
//   per-component normalization to [0,1] over the candidate set, before weighting
//   degenerate range==0 -> flat 0.5
//   recency decay 0.99 over last-access
//   output ordered by creation time ASCENDING

import {
  RETRIEVAL_WEIGHTS,
  RECENCY_DECAY,
  RETRIEVAL_N_COUNT,
  PROVENANCE_BONUS,
  IMPORTANCE_MAX,
  INTERVIEW_IMPORTANCE_FLOOR,
  INTERVENTION_IMPORTANCE_FLOOR,
} from './constants';

/** Minimal shape the scorer needs. Convex `Doc<'memories'>` satisfies it. */
export interface MemoryLike {
  description: string;
  importance: number;
  importanceFloor?: number;
  lastAccess: number;
  provenance: string;
  _creationTime: number;
}

/**
 * Port of `normalize_dict_floats(d, 0, 1)`.
 *
 * The degenerate branch matters more than it looks: when every value is equal
 * (one memory, or N identically-scored ones) upstream returns a flat 0.5 rather
 * than 1.0 or 0.0. Cold-start retrieval is therefore near-arbitrary — a real
 * condition for a freshly built twin, and the reason we gate twin output on a
 * minimum distinct-memory count.
 */
export function normalizeToUnit(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) return values.map(() => 0.5);
  return values.map((v) => (v - min) / range);
}

/**
 * Port of `extract_recency`. Measures how recently a memory was RETRIEVED, not
 * when it happened — same as upstream. Inert while RETRIEVAL_WEIGHTS.recency is 0.
 */
export function extractRecency(memories: MemoryLike[]): number[] {
  if (memories.length === 0) return [];
  const maxAccess = Math.max(...memories.map((m) => m.lastAccess));
  // Upstream's unit is an integer time_step; ours is epoch ms. Whole seconds
  // keeps the decay exponent in a comparable range.
  return memories.map((m) => Math.pow(RECENCY_DECAY, (maxAccess - m.lastAccess) / 1000));
}

/**
 * @param faithful when true, bypasses OUR deviations (importance floors) and
 *        returns the raw upstream value. Used by the conformance harness to
 *        prove the core scoring is identical to genagents before deviations are
 *        layered on. Without this, every declared deviation looks like drift and
 *        the harness stops being a usable gate.
 */
export function effectiveImportance(m: MemoryLike, faithful = false): number {
  if (faithful) return m.importance;
  const floor =
    m.importanceFloor ??
    (m.provenance === 'interview'
      ? INTERVIEW_IMPORTANCE_FLOOR
      : m.provenance === 'intervention'
        ? INTERVENTION_IMPORTANCE_FLOOR
        : 0);
  return Math.min(IMPORTANCE_MAX, Math.max(m.importance, floor));
}

/** DEVIATION #1, default off. See docs/FIDELITY.md deviation register. */
function provenanceBonus(p: string): number {
  if (!PROVENANCE_BONUS.enabled) return 0;
  if (p === 'interview') return PROVENANCE_BONUS.interview;
  if (p === 'intervention') return PROVENANCE_BONUS.intervention;
  return 0;
}

export type Scored<T extends MemoryLike> = { memory: T; score: number };

/**
 * Port of `MemoryStream.retrieve()`.
 *
 * `relevanceByIndex` is cosine similarity per candidate, supplied by the caller
 * because vector search lives in a Convex action. Upstream scores relevance over
 * the ENTIRE stream; we prefilter via the vector index, so rankings agree only
 * when the candidate set is a superset of what upstream would have ranked —
 * hence the over-fetch in memory.ts and the assertion in the conformance harness.
 */
export function rankMemories<T extends MemoryLike>(
  candidates: T[],
  relevanceByIndex: number[],
  nCount: number = RETRIEVAL_N_COUNT,
  opts: { faithful?: boolean } = {},
): Scored<T>[] {
  if (candidates.length === 0) return [];
  const faithful = opts.faithful ?? false;

  const recency = normalizeToUnit(extractRecency(candidates));
  const importance = normalizeToUnit(candidates.map((m) => effectiveImportance(m, faithful)));
  const relevance = normalizeToUnit(relevanceByIndex);

  const scored = candidates.map((memory, i) => ({
    memory,
    score:
      RETRIEVAL_WEIGHTS.recency * recency[i] +
      RETRIEVAL_WEIGHTS.relevance * relevance[i] +
      RETRIEVAL_WEIGHTS.importance * importance[i] +
      (faithful ? 0 : provenanceBonus(memory.provenance)),
  }));

  // Top-N by score, then re-sorted by creation time ASCENDING so memories reach
  // the prompt chronologically. (Upstream line 416 sorts ascending; its comment
  // claims descending and is wrong.) This ordering is load-bearing for
  // prompt-byte conformance — get it backwards and every diff fails.
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, nCount)
    .sort((a, b) => a.memory._creationTime - b.memory._creationTime);
}
