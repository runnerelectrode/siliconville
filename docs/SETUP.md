# Setup

The fork is applied and typechecks clean apart from codegen. The remaining
errors all read `Property 'gatherville' does not exist on type ...` — Convex's
`convex/_generated/api.d.ts` is committed upstream and still describes ai-town's
schema. It regenerates on first `convex dev` and the errors disappear.

## 1. Convex project (interactive — you have to run this)

```sh
npx convex dev
```

Creates/links a deployment, regenerates `convex/_generated/*` from our schema,
and starts the sync daemon. Leave it running.

Verify:

```sh
npx tsc --noEmit -p tsconfig.json    # expect 0 errors
```

## 2. Environment

```sh
npx convex env set ANTHROPIC_API_KEY 'sk-ant-...'
```

### Embeddings

Anthropic doesn't serve an embedding model, so this is the one external
provider in the runtime.

> ⚠️ **A cloud deployment cannot reach your local Ollama.** Convex actions run
> inside Convex's infrastructure, so `127.0.0.1:11434` is *their* container, not
> your machine. Local Ollama works only against a local/anonymous deployment.

#### Free paths (pick by deployment type)

**Local / anonymous deployment — Ollama.** Zero cost, zero keys, nothing to
operate. This is the right choice while there are no users:

```sh
ollama pull qwen3-embedding:0.6b     # native 1024 dims, no truncation
```

If `brew install ollama` fails — this machine hit a Homebrew bug
(`undefined method '[]' for nil` in `Utils::Bottles.load_tab`, breaking on
`ca-certificates`, not on ollama) — use the official binary:

```sh
mkdir -p ~/.local/ollama && cd ~/.local/ollama
curl -sL -o o.tgz https://github.com/ollama/ollama/releases/download/v0.32.6/ollama-darwin.tgz
tar xzf o.tgz && rm o.tgz
./ollama serve &                      # must stay running
./ollama pull qwen3-embedding:0.6b
```

Then point Convex at it and **verify before seeding** — otherwise a provider
misconfiguration only surfaces on the first memory write, several expensive LLM
calls in:

```sh
npx convex env set OLLAMA_HOST 'http://127.0.0.1:11434'
npx convex env set OLLAMA_EMBEDDING_MODEL 'qwen3-embedding:0.6b'
npx convex run gatherville/seed:checkProviders
```

**Cloud deployment — Cloudflare Workers AI.** The best *free hosted* option:
`bge-large-en-v1.5` is natively 1024 dims (exact index match), and the Workers
free plan includes 10,000 neurons/day, shared across models, resetting 00:00 UTC.
OpenAI-compatible, so it needs no code change:

```sh
npx convex env set EMBEDDING_API_URL \
  'https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1/embeddings'
npx convex env set EMBEDDING_API_KEY '<CF_API_TOKEN>'
npx convex env set EMBEDDING_MODEL   '@cf/baai/bge-large-en-v1.5'
```

Caveats: **English-only** (BGE-M3 is the multilingual one and isn't on Workers
AI), and `cls` vs `mean` pooling produce **mutually incompatible** embeddings —
changing pooling later means re-embedding, exactly like changing models. Default
is `mean`; leave it.

**Not viable free:** HuggingFace Inference's free tier is ~$0.10/month of
credits — orders of magnitude short of 24/7 embedding volume. A free-tier HF
**Space** works (publicly reachable, CPU-only, sleeps when idle) but you operate it.

#### Paid, when quality justifies it

Any OpenAI-compatible endpoint. Qwen3-Embedding-8B is Apache-2.0 and MRL-trained,
so it emits 4096 dims and we truncate to 1024 — full model quality on the
existing index, no rebuild:

```sh
npx convex env set EMBEDDING_API_URL 'https://api.siliconflow.com/v1/embeddings'
npx convex env set EMBEDDING_API_KEY '...'
npx convex env set EMBEDDING_MODEL   'Qwen/Qwen3-Embedding-8B'
```

Or `VOYAGE_API_KEY` / `OPENAI_API_KEY` for those presets.

**Dimension rules.** `EMBEDDING_DIMENSION` (`convex/util/llm.ts`, currently
**1024**) defines the vector index. Models wider than that are truncated and
re-normalized — valid **only for MRL-trained models** (Qwen3-Embedding,
`text-embedding-3-*`, Nomic v1.5). Truncating a non-MRL model yields vectors
that are quietly meaningless and detectable only through bad retrieval. Models
narrower than 1024 throw rather than pad.

**Changing the model means re-embedding every memory** — different models
produce different vector spaces even at the same width. Changing the *dimension*
additionally rebuilds the index. Verify config before writing data:

```ts
import { checkEmbeddingProvider } from './convex/gatherville/embeddings';
// → { provider, model, nativeDimension, truncatedTo }
```

## 3. World init

```sh
npx convex run init
npm run dev          # client on :5173
```

## 4. Art (before it looks like the reference images)

Buy [Modern Interiors](https://limezu.itch.io/moderninteriors) and
[Modern Exteriors](https://limezu.itch.io/modernexteriors) ($1.50+ each, or 3
packs for $5). Commercial use is permitted with credit; **redistribution is
not**, so the tilesets are gitignored and must ship from a private bundle.

Maps are authored in Tiled and converted:

```sh
node data/convertMap.js <tiled.json> <assets> <width> <height>
```

---

## Pausing all spend

Two independent switches. Use both — they stop different things.

```sh
# 1. Kill switch: refuses every paid outbound call (decisions, utterances,
#    interviews, reflections, embeddings, batches, and the inherited ai-town
#    chat/moderation paths). Takes effect immediately, no deploy needed.
npx convex env set LLM_PAUSED 1

# 2. Stop the engine, so nothing even tries. `restartDeadWorlds` leaves a
#    developer-stopped world alone, so this survives the cron and page loads.
npx convex run testing:stop
```

Resume in the reverse order — start the engine only after you mean to spend
again:

```sh
npx convex env remove LLM_PAUSED
npx convex run testing:resume
```

The guard lives in `convex/gatherville/killswitch.ts` and is checked *inside*
each network function rather than at the call sites, so a new call site cannot
forget it. It fails closed: any unrecognised value of `LLM_PAUSED` counts as
paused, because a typo should cost nothing rather than silently resume billing.

Verify it is engaged — this should raise `LLMPausedError`, not spend:

```sh
npx convex run gatherville/seed:checkProviders
```

## What the fork changed

| File | Change |
|---|---|
| `convex/schema.ts` | `agentTables` → `gathervilleTables` |
| `convex/agent/memory.ts` | importance rescaled 0–9 → **0–100**; `max_tokens` 1 → 4; provenance required at call sites; reflection threshold rescaled; schema import repointed |
| `convex/aiTown/agentOperations.ts` | the random activity picker (upstream's `// TODO: have LLM choose the activity`) now calls `gatherville/decide`, falling back to random when the cadence gate declines |
| `convex/crons.ts` | `stopInactiveWorlds` **unregistered** (we run 24/7); added tier decay + trace export; `memories`/`memoryEmbeddings` **removed** from the vacuum list |
| `package.json` | `@anthropic-ai/sdk` |

`convex/agent/schema.ts` is now dead — superseded by `convex/gatherville/schema.ts`.
Left in place so upstream diffs stay readable; safe to delete.

### Two changes worth understanding before you touch them

**Importance is 0–100.** genagents scores 0–100, ai-town scored 0–9. In one
unified stream the 0–9 rows sort below every 0–100 row and are effectively never
retrieved — silently, with nothing crashing. If you add another memory writer,
it scores on the 0–100 scale. See `docs/GENAGENTS-ANALYSIS.md` §2.1.

**Memories are no longer vacuumed.** Upstream treated them as disposable cache.
Here they are the twin, and interview-derived rows are user data held under
consent. Embedding growth still needs managing eventually — the answer is
consolidating low-importance *simulated* memories, not deleting by age.

---

## Not built yet

- `interview.ts` — transcript → scratch + interview memories
- `reflect.ts` — batched reflection through the Batch API
- `training/` — genagents oracle, conformance harness, trace export
- Client: interview UI, scorecard, god-mode console
- The **two-tier retrieval A/B** (`docs/FIDELITY.md` register #1). Until it runs,
  the cost figures in `convex/gatherville/constants.ts` are provisional — they
  assume the cached prefix works.

## First thing to watch once it runs

```
convex/gatherville/traces.ts → spendByTwin
```

`cacheHitRate` is the number that tells you whether the caching design holds. If
it sits near zero, the prefix is churning and 24/7 will be ~4× the modelled
cost. `decide.ts` logs a warning on digest changes and on suspected misses.
