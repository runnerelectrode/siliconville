// Embeddings.
//
// Anthropic does not serve an embedding model, so this is the one place in the
// runtime that talks to a different provider.
//
// ── Two hard constraints, both learned the expensive way ───────────────────
//
// 1. CLOUD DEPLOYMENTS CANNOT REACH LOCALHOST. Convex actions execute inside
//    Convex's infrastructure, so `http://127.0.0.1:11434` resolves to their
//    container, not your machine. Local Ollama works ONLY against a local or
//    anonymous deployment. On a cloud deployment you need a publicly reachable
//    endpoint — a hosted API, or your own TEI behind a real hostname.
//
// 2. CHANGING THE MODEL MEANS RE-EMBEDDING EVERY MEMORY. Different models
//    produce different vector spaces; a BGE vector and a Qwen vector are not
//    comparable even at identical dimensions. Changing the *dimension*
//    additionally forces a schema change and index rebuild. Prefer models that
//    can emit EMBEDDING_DIMENSION so migrations stay data-only.

import { EMBEDDING_DIMENSION, fitDimension } from '../util/llm';
import { assertLLMAllowed } from './killswitch';

type ProviderKind = 'ollama' | 'openai-compatible';

type ProviderConfig = {
  kind: ProviderKind;
  url: string;
  model: string;
  apiKey?: string;
  /**
   * Ask the provider for a specific output width. Supported by OpenAI
   * (`dimensions`) and by MRL-trained models served OpenAI-style. When the
   * provider ignores it we truncate client-side — see `fitDimension`.
   */
  requestDimensions?: number;
};

/**
 * Resolution order is deliberate: an explicitly configured endpoint always wins,
 * and bare Ollama is the last resort because it is the one option that silently
 * fails on a cloud deployment.
 */
function config(): ProviderConfig {
  // Generic OpenAI-compatible endpoint. This covers hosted open-weight models
  // (SiliconFlow / Together / DeepInfra serving Qwen3-Embedding, BGE, etc.) and
  // self-hosted TEI, which also speaks the OpenAI embeddings shape.
  if (process.env.EMBEDDING_API_URL) {
    return {
      kind: 'openai-compatible',
      url: process.env.EMBEDDING_API_URL,
      model: process.env.EMBEDDING_MODEL ?? 'Qwen/Qwen3-Embedding-8B',
      apiKey: process.env.EMBEDDING_API_KEY,
      requestDimensions: EMBEDDING_DIMENSION,
    };
  }
  if (process.env.VOYAGE_API_KEY) {
    return {
      kind: 'openai-compatible',
      url: 'https://api.voyageai.com/v1/embeddings',
      model: process.env.VOYAGE_EMBEDDING_MODEL ?? 'voyage-3',
      apiKey: process.env.VOYAGE_API_KEY,
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      kind: 'openai-compatible',
      url: 'https://api.openai.com/v1/embeddings',
      model: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
      apiKey: process.env.OPENAI_API_KEY,
      requestDimensions: EMBEDDING_DIMENSION,
    };
  }
  return {
    kind: 'ollama',
    url: `${process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'}/api/embeddings`,
    model: process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:0.6b',
  };
}

// ---------------------------------------------------------------------------
// Matryoshka truncation
// ---------------------------------------------------------------------------

// fitDimension lives in util/llm.ts, next to the EMBEDDING_DIMENSION it fits
// to. It was here, and ai-town's fetchEmbeddingBatch needs the same rule — but
// importing it from there pulled this whole module into the CLIENT bundle,
// because util/llm.ts is in the client graph (both schemas read the dimension
// constant from it) and Vite follows the import. Moving the function up is the
// fix; re-exporting keeps every existing caller working.
export { fitDimension };


// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function callProvider(cfg: ProviderConfig, input: string | string[]): Promise<number[][]> {
  assertLLMAllowed(`embed/${cfg.kind}`);
  if (cfg.kind === 'ollama') {
    // Ollama's native endpoint is single-input only.
    const inputs = Array.isArray(input) ? input : [input];
    const out: number[][] = [];
    for (const text of inputs) {
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, prompt: text }),
      });
      if (!res.ok) throw new Error(`Embedding failed (ollama/${cfg.model}): ${await res.text()}`);
      out.push((await res.json()).embedding);
    }
    return out;
  }

  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      input,
      ...(cfg.requestDimensions ? { dimensions: cfg.requestDimensions } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Embedding failed (${cfg.url} / ${cfg.model}): ${await res.text()}`);
  }
  const data = (await res.json()).data as { index: number; embedding: number[] }[];
  // Providers do not guarantee response order — realign by index. Getting this
  // wrong attaches each memory to a neighbour's vector, which degrades
  // retrieval subtly enough to look like "the model is just bad".
  return data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function embed(text: string): Promise<number[]> {
  const [vector] = await callProvider(config(), text);
  return fitDimension(vector);
}

export async function embedMany(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const vectors = await callProvider(config(), texts);
  if (vectors.length !== texts.length) {
    throw new Error(`Embedding count mismatch: sent ${texts.length}, got ${vectors.length}.`);
  }
  return vectors.map(fitDimension);
}

/**
 * Startup check. Verifies the configured provider is reachable and returns a
 * vector of the expected width — worth calling once at deploy rather than
 * discovering a misconfiguration on the first memory write.
 */
export async function checkEmbeddingProvider(): Promise<{
  provider: ProviderKind;
  model: string;
  nativeDimension: number;
  truncatedTo: number;
}> {
  const cfg = config();
  const [vector] = await callProvider(cfg, 'connectivity check');
  fitDimension(vector); // throws if incompatible
  return {
    provider: cfg.kind,
    model: cfg.model,
    nativeDimension: vector.length,
    truncatedTo: EMBEDDING_DIMENSION,
  };
}
