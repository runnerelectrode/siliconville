# Fidelity to `genagents` — what we copy, what we adapt, what's ours

**The question:** using the genagents *API* is fine — but how much can we lean on it as a reference without drifting away from the research?

**The answer:** the reference surface is small enough to match almost exactly. Total logic in `genagents` is ~920 lines across three files, plus nine prompt templates:

| File | LOC | Role |
|---|---:|---|
| `genagents/modules/memory_stream.py` | 527 | Retrieval scoring, importance, reflection |
| `genagents/modules/interaction.py` | 255 | The three response modes + `ask` |
| `genagents/genagents.py` | 138 | Agent object, scratch, save/load |
| `simulation_engine/prompt_template/generative_agent/**` | 9 files | **The actual research IP** |

That's small enough that "port it faithfully" is a realistic commitment rather than an aspiration. Language is not the axis that matters — the scoring function and the prompts are.

---

## Tier 1 — MUST MATCH (bit-for-bit where possible)

Deviating here means we are no longer running the paper's architecture, and our holdout scores stop being comparable to the published ~85% benchmark.

### 1. The prompt templates

Vendored verbatim to `prompts/genagents/` (MIT, `LICENSE.genagents` retained). Upstream paths preserved exactly — **including the `interaction/utternace/` typo** — so a future `diff -r` against upstream is trivial.

These are the highest-value, lowest-cost thing to copy. Rewriting them "cleaner" is the single easiest way to silently deviate. Treat them as data, not code: if we want to change one, it becomes a versioned variant (`utterance_v2.txt`) with an A/B against holdout accuracy, never an in-place edit.

### 2. The retrieval scoring function

```python
# genagents/modules/memory_stream.py :346
def retrieve(self, focal_points, time_step, n_count=120, curr_filter="all",
             hp=[0, 1, 0.5], stateless=True, verbose=False):
```

Reproduced exactly:

- `hp = [recency_w, relevance_w, importance_w] = [0, 1, 0.5]` — **recency weighted to zero**
- `recency_decay = 0.99`, exponential over chronological index
- Each component independently normalized to `[0, 1]` across the candidate set *before* the weighted sum
- Relevance is cosine similarity against the focal-point embedding
- `n_count = 120`

> ⚠️ **Recency being zero is deliberate upstream, and it departs from the original Smallville paper (1/1/1).** For predicting a person's attitudes, *when* they said something matters far less than whether it's relevant. I had already drifted to 1/1/1 in the first draft of `constants.ts` and corrected it. This is precisely the kind of drift the fidelity harness below exists to catch.

### 3. The three response modes

`categorical_resp(questions)`, `numerical_resp(questions, float_resp=False)`, `utterance(curr_dialogue, context="")` — same signatures, same semantics, same templates, same JSON output contracts.

### 4. The agent description

`interaction.py` defines `_main_agent_desc` (prediction) and `_utterance_agent_desc` (dialogue). **They are byte-identical** — verified by diff; see `GENAGENTS-ANALYSIS.md` §3.1. Presumably intended to diverge upstream and never did.

So there is one description format, not two, and matching it means matching one function. Splitting them for dialogue-specific framing is a legitimate future *option*, not a fidelity requirement — and it would be a deviation needing a register row.

### 4b. Importance scale — 0 to 100

`memory_stream/importance_score/singular_v1.txt` scores **0–100**. ai-town's `calculateImportance` scores **0–9**. Mixing both in one stream ranks every ai-town-scored memory at the bottom of every retrieval, silently. We standardize on 0–100 and rescale ai-town's scorer. This is the highest-severity finding from the line-by-line read.

### 5. Reflection

`reflect(anchor, time_step)` — anchored, with `reflection_count`, using the vendored reflection templates.

---

## Tier 2 — ADAPT (different mechanism, same behavior)

Deviation here is forced by our environment and carries no research risk, provided behavior is preserved.

| genagents | Gatherville | Why |
|---|---|---|
| JSON files on disk (`save()`/`load()`) | Convex tables | Multi-tenant, live, queryable |
| In-process embedding list + `cos_sim` | Convex `vectorIndex` | Same cosine ranking, indexed |
| Python | TypeScript | Runtime is one language; see §Runtime below |
| OpenAI via `gpt_structure.py` | Claude via `anthropic.ts` | Prompt-cache economics, model routing |
| Synchronous single agent | Cadence-tiered, many agents | 24/7 operation |

The rule for Tier 2: **the mechanism may change, the numbers may not.** A retrieval call on the same fixture must return the same ranked node ids.

---

## Tier 3 — OURS (genagents has no opinion)

`genagents` **has no world simulation and no action selection.** Its `environment/` directory is an interview and survey harness, not a world. It answers questions and produces utterances; it never decides where to walk or what to do next.

So these are ours to design, and there is no upstream to deviate from:

- Action selection in a spatial world → comes from **ai-town / Smallville**, not genagents
- Decision cadence and the 24/7 economics
- God mode / interventions
- Trace capture and the RL corpus
- Provenance tagging on the memory stream

**This is where real risk lives** — not in the port, but in the bridge between a question-answering behavior model and a world that needs continuous action selection. Neither reference covers it. Anything invented here gets written down in the deviation register below.

---

## The runtime question

Using the Python `genagents` API directly is not a bad option, and it isn't off the table — it's just not needed in the *hot path*. What it's genuinely good for is being the **reference oracle**.

So Python stays, in one place and one role:

```
training/
  oracle/            ← genagents, unmodified, pinned commit
  conformance/       ← runs both implementations on the same fixtures, diffs
  export/            ← reads trace JSONL, builds RL datasets
```

That gets us fidelity as a **test result** rather than an assertion, without a Python service on the request path.

### The conformance harness

For a fixed twin fixture and a fixed question set, with embeddings stubbed to a recorded fixture (so nothing depends on a live embedding provider):

| Check | Assertion |
|---|---|
| Retrieval | identical ranked node ids, scores within `1e-6` |
| Importance scoring | identical parsed integer for the same record |
| Response modes | identical JSON structure; categorical/numeric answers identical |
| Reflection | same anchor selection, same node count |
| Prompt bytes | rendered prompt is byte-identical to the Python renderer |

The last one is the strongest check and the cheapest to run — it catches template drift, whitespace changes, and input-ordering bugs before they ever reach a model. Run it in CI on every change to `prompts/` or the memory module.

Note the harness can run entirely offline against recorded fixtures — no API keys, no cost, no flakiness. There's no reason not to gate merges on it.

---

## Deviation register

Every intentional departure gets a row. Default posture: **match upstream, deviate behind a flag with a measurement.**

| # | Deviation | Default | Rationale | How we'd validate |
|---|---|---|---|---|
| 1 | `PROVENANCE_BONUS` — boost interview/intervention memories in retrieval | **OFF** (0.0) | genagents' stream is pure interview, so it never faces simulated memories crowding out identity. Ours is mixed — a genuinely new condition. | A/B on holdout accuracy. Ship only if it wins. |
| 2 | `importanceFloor` on interview memories | ON | Same root cause as #1; a cheaper mechanism. | Same A/B. |
| 3 | Claude instead of GPT | ON | Prompt caching economics, model routing. Templates unchanged. | Conformance on parsed outputs, not raw strings. |
| 4 | Action selection in a spatial world | ON | Not present upstream at all — from ai-town/Smallville. | No upstream to compare; validate against Smallville behavior instead. |
| 5 | Vector prefilter capped at 256 candidates | FORCED | Convex hard limit. genagents scores relevance over the whole stream; we can only over-fetch to 256. For a twin with ≤256 memories our candidate set is a superset and ranking matches. Beyond that we are **approximating**, permanently. | Conformance fixtures stay under the cap. Above it, compare rank correlation rather than exact equality. |
| 6 | `get_fullname()` fallback | ON | Upstream returns `""` unless both names exist, which renders `"[]: [Fill in]"` in the dialogue prompt and hides who is speaking. We fall back to first name. | Cosmetic; no eval needed. |
| 7 | Dialogue prompt is single-tier (uncached) | ON | The utterance anchor IS the running dialogue, so the agent description is anchor-dependent by construction and cannot sit above a cache breakpoint without the two-tier split. | Resolve together with deviation #1's A/B. |

If a change isn't in this table, it isn't intentional — it's a bug.

---

## Practical rules

1. **Never edit `prompts/genagents/` in place.** New behavior is a new versioned file.
2. **Re-run conformance before merging** anything touching retrieval, importance, or prompts.
3. **Pin the upstream commit** for the oracle; upgrading it is a deliberate, reviewed act.
4. **New deviation ⇒ new register row**, with a default and a validation plan.
5. **When in doubt, match upstream.** Our differentiation is the consumer product, the corpus and the RL loop — not a better retrieval constant.
