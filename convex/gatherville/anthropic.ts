// Claude client: model routing, prompt caching, batch submission, usage capture.
//
// Replaces upstream ai-town's `convex/util/llm.ts` (OpenAI-compatible fetch).
// Embeddings are NOT handled here — Anthropic doesn't serve an embedding model;
// see `embeddings.ts` for that provider, and note EMBEDDING_DIMENSION is a
// compile-time constant, so switching providers means reindexing every memory.

import Anthropic from '@anthropic-ai/sdk';
import { assertLLMAllowed } from './killswitch';

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export type Route = 'salient' | 'routine';

/**
 * OpenRouter exposes an Anthropic-NATIVE `/v1/messages` endpoint, so the official
 * SDK works against it with only a baseURL change — same request shape, same
 * response shape, and `cache_read_input_tokens` is reported correctly
 * (verified empirically, 6301 tokens written then read).
 *
 * Model ids differ: `anthropic/claude-haiku-4.5` vs `claude-haiku-4-5`.
 */
const VIA_OPENROUTER = !!process.env.OPENROUTER_API_KEY;

function modelId(route: Route): string {
  const override =
    route === 'salient'
      ? process.env.GATHERVILLE_MODEL_SALIENT
      : process.env.GATHERVILLE_MODEL_ROUTINE;
  if (override) return override;
  if (VIA_OPENROUTER) {
    return route === 'salient' ? 'anthropic/claude-opus-5' : 'anthropic/claude-haiku-4.5';
  }
  return route === 'salient' ? 'claude-opus-5' : 'claude-haiku-4-5';
}

export const MODELS = {
  get salient() {
    return modelId('salient');
  },
  get routine() {
    return modelId('routine');
  },
};

/**
 * Per-model capability flags. These are not cosmetic — sending an unsupported
 * parameter is a 400, and the two models genuinely differ:
 *
 *  - Opus 5 runs adaptive thinking by DEFAULT (omitting `thinking` still thinks)
 *    and accepts `output_config.effort` through `max`. `max_tokens` bounds
 *    thinking + visible output together, so it needs headroom.
 *  - Haiku 4.5 rejects `effort` outright and does not support adaptive thinking.
 *    We send neither.
 */
type Caps = {
  effort: boolean;
  adaptiveThinking: boolean;
  cacheControl: boolean;
  minCacheableTokens: number;
};

/**
 * Capabilities follow the MODEL, not the route.
 *
 * These used to be keyed by route on the assumption that salient is always
 * Opus and routine is always Haiku. The moment you point
 * GATHERVILLE_MODEL_SALIENT at a non-Anthropic model — a cheap Qwen through
 * OpenRouter, say — that assumption sends `output_config.effort` and
 * `cache_control` to a model that has never heard of either, and every salient
 * call 400s. The override existed; the capability gating did not follow it.
 *
 * `cache_control` is Anthropic's prompt-caching mechanism specifically. Other
 * providers on OpenRouter either ignore it or reject it, and either way the
 * token accounting stops meaning what the cost model thinks it means.
 */
function capsFor(route: Route): Caps {
  const id = modelId(route).toLowerCase();
  const isClaude = id.includes('claude');
  // Adaptive thinking and effort are Claude 4.6+ / 5 features. Older Claude
  // models take budget_tokens instead, which we do not send.
  const modern = /opus-5|opus-4[-.]?8|opus-4[-.]?7|opus-4[-.]?6|sonnet-5|sonnet-4[-.]?6|fable-5/.test(id);
  const base = ROUTE_DEFAULTS[route];
  if (!isClaude) {
    return { effort: false, adaptiveThinking: false, cacheControl: false, minCacheableTokens: Infinity };
  }
  return {
    effort: base.effort && modern,
    adaptiveThinking: base.adaptiveThinking && modern,
    cacheControl: true,
    minCacheableTokens: base.minCacheableTokens,
  };
}

const ROUTE_DEFAULTS: Record<
  Route,
  { effort: boolean; adaptiveThinking: boolean; minCacheableTokens: number }
> = {
  // MINIMUM CACHEABLE PREFIX IS PER-MODEL AND NOT MONOTONIC:
  //   Opus 5 = 512, Sonnet 5 = 1024, Haiku 4.5 = 4096.
  //
  // A prefix under the threshold is silently NOT cached — no error, no warning,
  // `cache_read_input_tokens` just stays 0 forever. Our routine path is the
  // high-volume one, so a two-tier prefix sized for Opus (~1.5k tokens) would
  // never cache on Haiku and the 24/7 cost model would be wrong by ~4x.
  // Verified empirically: 1812-token prefix cached nothing; 6301 cached fully.
  salient: { effort: true, adaptiveThinking: true, minCacheableTokens: 512 },
  routine: { effort: false, adaptiveThinking: false, minCacheableTokens: 4096 },
};

/** $ per 1M tokens, for per-trace cost attribution. */
const PRICING: Record<Route, { input: number; output: number }> = {
  salient: { input: 5.0, output: 25.0 },
  routine: { input: 1.0, output: 5.0 },
};

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    if (VIA_OPENROUTER) {
      client = new Anthropic({
        apiKey: process.env.OPENROUTER_API_KEY!,
        // NOT '/api/v1' — the SDK appends '/v1/messages' itself, so that would
        // request '/api/v1/v1/messages', 404 to OpenRouter's SPA, and surface as
        // a wall of HTML rather than an API error.
        baseURL: 'https://openrouter.ai/api',
      });
    } else if (process.env.ANTHROPIC_API_KEY) {
      client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    } else {
      throw new Error(
        "No LLM key. Set one:\n" +
          "  npx convex env set ANTHROPIC_API_KEY 'sk-ant-...'   (first-party)\n" +
          "  npx convex env set OPENROUTER_API_KEY 'sk-or-...'   (OpenRouter)",
      );
    }
  }
  return client;
}

// ---------------------------------------------------------------------------
// Usage / cost
// ---------------------------------------------------------------------------

export type Usage = {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
};

export function emptyUsage(): Usage {
  return { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 };
}

export function extractUsage(u: Anthropic.Usage): Usage {
  return {
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  };
}

/**
 * Cost in micro-dollars. Cache reads bill at ~0.1x input, writes at ~1.25x
 * (5-minute TTL) or ~2x (1-hour). We assume 5-minute here; the 1h paths pass
 * their own multiplier.
 */
export function costMicros(route: Route, usage: Usage, cacheWriteMultiplier = 1.25): number {
  const p = PRICING[route];
  const dollars =
    (usage.input * p.input +
      usage.cacheRead * p.input * 0.1 +
      usage.cacheWrite * p.input * cacheWriteMultiplier +
      usage.output * p.output) /
    1_000_000;
  return Math.round(dollars * 1_000_000);
}

/**
 * A cache miss where we expected a hit is the single most expensive silent
 * failure in this system. Call this on decision paths and alert on it.
 */
export function suspectCacheMiss(usage: Usage, expectedPrefixTokens: number): boolean {
  return expectedPrefixTokens > 512 && usage.cacheRead === 0 && usage.cacheWrite === 0;
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

export type CachedPrefix = {
  /** Byte-stable across every call for this twin. Never interpolate a tick/timestamp. */
  text: string;
  /**
   * '1h' costs 2x to write but survives the gaps between ambient-tier decisions.
   * 'off' disables caching for this block — which is the correct choice whenever
   * the gap between calls exceeds the TTL. At dormant cadence (60 min) even a 1h
   * entry has usually expired, so marking it would pay the 2x write every single
   * time and never read: strictly worse than not caching.
   */
  ttl?: '5m' | '1h' | 'off';
};

export type CompleteArgs = {
  route: Route;
  /**
   * Goes above the cache breakpoint. Must be byte-stable.
   *
   * An ARRAY places one breakpoint after each block, in order. Anthropic caches
   * the prefix from position 0 up to each breakpoint, so ordering decides what
   * is shared: put blocks that are identical across twins FIRST (the world) and
   * per-twin blocks after (identity). Then every twin shares one cache entry for
   * the world segment instead of each paying to cache its own copy.
   *
   * Caveat that governs the design: the per-model minimum applies to the length
   * of each cached SEGMENT measured from position 0. A shared block of 2k tokens
   * cannot be its own entry on Haiku 4.5 (4096 minimum) — only the cumulative
   * breakpoint would qualify.
   */
  cachedPrefix: CachedPrefix | CachedPrefix[];
  /** Goes below the breakpoint. Free to vary per call. */
  volatile: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Ask for JSON back — genagents' templates all specify JSON output. */
  jsonSchema?: Record<string, unknown>;
};

export type CompleteResult = {
  text: string;
  usage: Usage;
  costMicros: number;
  model: string;
};

export async function complete(args: CompleteArgs): Promise<CompleteResult> {
  assertLLMAllowed(`complete/${args.route}`);
  const caps = capsFor(args.route);
  const model = MODELS[args.route];

  const blocks = Array.isArray(args.cachedPrefix) ? args.cachedPrefix : [args.cachedPrefix];

  // ~4 chars/token. Cumulative, because a breakpoint caches everything from
  // position 0 up to it — not just its own block.
  let cumulative = 0;
  const system = blocks.map((b) => {
    cumulative += Math.ceil(b.text.length / 4);
    // A block below the model's minimum is silently NOT cached: no error, and
    // cache_read_input_tokens just stays 0 forever. Marking it anyway is worse
    // than leaving it unmarked, because a marked-but-uncacheable block still
    // pays the write multiplier on some paths.
    const cacheable =
      caps.cacheControl && cumulative >= caps.minCacheableTokens && b.ttl !== 'off';
    return {
      type: 'text' as const,
      text: b.text,
      ...(cacheable
        ? { cache_control: { type: 'ephemeral', ttl: b.ttl ?? '5m' } }
        : {}),
    };
  });

  const anyCacheable = system.some((b) => 'cache_control' in b);
  // Only warn when caching was actually available. On a non-Anthropic model
  // there is no prefix cache to miss, and warning about it every call would
  // train everyone to ignore the warning that matters.
  if (caps.cacheControl && !anyCacheable && blocks.every((b) => b.ttl !== 'off')) {
    console.warn(
      `[gatherville] cached prefix ~${cumulative} tok is below ${model}'s ` +
        `${caps.minCacheableTokens}-token minimum — this request will NOT cache. ` +
        `Note that padding it purely to clear the threshold costs MORE than sending ` +
        `a short uncached prompt; only grow it with content worth sending.`,
    );
  }

  const req: Record<string, unknown> = {
    model,
    // Opus 5 counts thinking against max_tokens, so leave real headroom or
    // responses truncate mid-thought.
    max_tokens: args.maxTokens ?? (caps.adaptiveThinking ? 8_000 : 2_000),
    system,
    messages: [{ role: 'user', content: args.volatile }],
  };

  if (caps.effort) {
    req.output_config = { effort: args.effort ?? 'high' };
  }
  if (args.jsonSchema) {
    req.output_config = {
      ...(req.output_config as object | undefined),
      format: { type: 'json_schema', schema: args.jsonSchema },
    };
  }

  const response = (await getClient().messages.create(req as never)) as Anthropic.Message;

  const usage = extractUsage(response.usage);
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return {
    text,
    usage,
    costMicros: costMicros(args.route, usage, blocks.some((b) => b.ttl === '1h') ? 2 : 1.25),
    model,
  };
}

// ---------------------------------------------------------------------------
// Batch — reflection, digests, re-scoring
// ---------------------------------------------------------------------------

export type BatchItem = {
  customId: string;
  cachedPrefix: CachedPrefix;
  volatile: string;
  maxTokens?: number;
};

/**
 * 50% cheaper, up to 100k requests, most complete within an hour. Everything
 * offline goes through here: reflection, away-digests, importance re-scoring.
 */
export async function submitBatch(route: Route, items: BatchItem[]): Promise<string> {
  assertLLMAllowed(`submitBatch/${route}`);
  const caps = capsFor(route);
  const batch = await getClient().messages.batches.create({
    requests: items.map((item) => ({
      custom_id: item.customId,
      params: {
        model: MODELS[route],
        max_tokens: item.maxTokens ?? 4_000,
        system: [
          {
            type: 'text',
            text: item.cachedPrefix.text,
            ...(caps.cacheControl
              ? { cache_control: { type: 'ephemeral', ttl: item.cachedPrefix.ttl ?? '5m' } }
              : {}),
          },
        ],
        messages: [{ role: 'user', content: item.volatile }],
        ...(caps.effort ? { output_config: { effort: 'high' } } : {}),
      } as never,
    })),
  });
  return batch.id;
}

export async function batchReady(batchId: string): Promise<boolean> {
  assertLLMAllowed('batchReady');
  const batch = await getClient().messages.batches.retrieve(batchId);
  return batch.processing_status === 'ended';
}

/**
 * Results come back in ARBITRARY order — always key by custom_id, never by
 * position. Silent mis-attribution here would assign one twin's reflections to
 * another, which is both a correctness and a privacy failure.
 */
export async function collectBatch(batchId: string): Promise<Map<string, string>> {
  assertLLMAllowed('collectBatch');
  const out = new Map<string, string>();
  for await (const result of await getClient().messages.batches.results(batchId)) {
    if (result.result.type !== 'succeeded') continue;
    const text = result.result.message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    out.set(result.custom_id, text);
  }
  return out;
}
