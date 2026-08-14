// Convex components used by this app.
//
// Only the workflow component. The AGENT component was considered and rejected:
// it peers on react ^18.3.1 and this app is pinned to 18.2.0 (the same wall
// react-three-fiber v9 hit), and it expects the Vercel AI SDK as its model
// layer — which would sit on top of, or displace, gatherville/anthropic.ts,
// where the LLM kill switch, prompt caching and cost accounting live. Adopting
// it would trade working functionality for plumbing.
//
// The twin memory stream stays ours regardless of any component. FIDELITY.md
// Tier 1 requires retrieval to match genagents bit-for-bit — hp = [recency 0,
// relevance 1, importance 0.5], per-candidate-set normalisation, n_count 120 —
// or holdout scores stop being comparable to the published ~85% benchmark.
// Generic vector RAG would break that silently: the twins would still answer,
// and the number would quietly stop meaning anything.
import { defineApp } from 'convex/server';
import workflow from '@convex-dev/workflow/convex.config.js';

const app = defineApp();
app.use(workflow);
export default app;
