# `genagents` — line-by-line analysis

Read of `joonspk-research/genagents` @ shallow clone, 2026-08-05. Three source files, 920 lines, plus 9 prompt templates. Line references are to upstream.

The headline: the architecture is smaller and simpler than the paper implies, and it carries **two real bugs, one missing asset, and a scoring-scale conflict with ai-town** that would silently corrupt a naive merge. Findings that change our port are marked **[PORT]**.

---

## 1. `genagents/genagents.py` (138 lines) — the agent object

Thin facade. `__init__` loads three JSON files (`scratch.json`, `memory_stream/nodes.json`, `memory_stream/embeddings.json`); everything else delegates.

| Lines | Observation |
|---|---|
| 27, 32 | `self.id = uuid.uuid4()` on **both** the load and fresh-create paths. Agent identity is regenerated on every load — `meta.json` is written (86-87) but never read back. **There is no stable agent id across sessions.** |
| 37-38 | `update_scratch` is a plain `dict.update` — no schema, no validation. `scratch` is whatever you put in it. |
| 91-94 | `get_fullname()` returns `""` unless *both* `first_name` and `last_name` exist. A single-name twin silently becomes anonymous in dialogue prompts (`utterance` interpolates this at interaction.py:181). |
| 96-97 | `get_self_description()` is `str(self.scratch)` — **a raw Python dict repr** goes into the prompt: `{'first_name': 'Jane', 'age': 34}`. Not prose, not JSON. This is the entire identity half of every prompt. |
| 112, 121 | **BUG.** `def reflect(self, anchor, time_step=0)` calls `self.memory_stream.reflect(anchor, time_step)`. But the callee is `reflect(self, anchor, reflection_count=5, retrieval_count=120, time_step=0)` — so `time_step` binds **positionally to `reflection_count`**. `agent.reflect("work", time_step=3)` generates 3 reflections at time_step 0. The public API's second argument lands in the wrong parameter. |

**[PORT]** Our `scratch` is a typed object (already in `schema.ts`), and we render it deliberately rather than via `str(dict)`. That's a **deviation** — arguably a fix, but it changes prompt bytes, so it needs a register row and a measured A/B, not a silent "improvement."

---

## 2. `genagents/modules/memory_stream.py` (527 lines) — retrieval and reflection

### 2.1 Importance scoring (17-53)

- One LLM call per `remember()` (459-461 calls `generate_importance_score([content])[0]`). A batch template exists (`batch_v1.txt`, selected at 37-40 when `len(records) > 1`) but `remember()` never uses it.
- `_get_fail_safe()` returns `25` (34-35).

**The scale is 0–100.** From `importance_score/singular_v1.txt`:

> *"Rate its importance on a scale from 0 to 100, where 0 represents 'not important' and 100 represents 'very important'"*

**[PORT] — this is the dangerous one.** ai-town's `calculateImportance` (`convex/agent/memory.ts:250`) prompts:

> *"On the scale of 0 to 9, where 0 is purely mundane … and 9 is extremely poignant"*

**0–100 vs 0–9 in one unified memory stream.** Every ai-town-scored memory would rank at the bottom of every retrieval — a twin whose simulated experiences never surface, with no error anywhere. This is exactly the kind of defect that survives to production because nothing crashes. We standardize on genagents' 0–100 and rescale ai-town's scorer. My `constants.ts` floors were written on a 1–10 assumption and have been corrected.

### 2.2 Reflection (56-95, 464-473)

- `reflect()` retrieves against the anchor (466), generates reflections (468), scores them (469), and adds each as a `"reflection"` node whose `pointer_id` is **the list of source node ids** (473) — despite the singular name.
- **`reflection_count` is ignored in singular mode.** `reflection/singular_v1.txt` declares `!<INPUT 1>!: reflection count` in its variable header but **never references `!<INPUT 1>!` in the template body**. The parameter is threaded all the way from the caller and then dropped.
- The singular template says *"Write one reflection"* while its output schema is a JSON **list**.

### 2.3 Scoring helpers (209-272)

```python
# 222-228
max_timestep = max([node.last_retrieved for node in seq_nodes])
recency_decay = 0.99
recency_out[node.node_id] = recency_decay ** (max_timestep - node.last_retrieved)
```

- Recency is computed from **`last_retrieved`, not `created`** — it measures "how recently was this memory *used*", not "how recently did it happen." Not what most people assume.
- **BUG.** `retrieve()` at 421-423 does `n.retrieved_time_step = time_step` under `if not stateless`. `ConceptNode` (280-288) has **no** `retrieved_time_step` attribute — Python happily creates a new one, and **`last_retrieved` is never updated.** So recency is frozen at creation values forever. Combined with `stateless=True` being the default, recency is dead twice over.
- `normalize_dict_floats` (145-180) **mutates its argument in place** and returns it. Contained here because callers pass fresh dicts, but it's a trap for a refactor.
- **Degenerate normalization** (173-175): when `range_val == 0`, every value becomes `(target_max - target_min)/2 = 0.5`. With one memory — or N identically-scored ones — relevance is `0.5` regardless of actual cosine similarity. **[PORT]** Cold-start twins have effectively random retrieval until the stream diversifies. Our first-session twins are exactly this case.
- `extract_relevance` (265, 269) calls `get_text_embedding(focal_pt)` per focal point and keys the embedding table **by content string**, not node id. Two nodes with identical text collide.

### 2.4 `retrieve()` (346-427)

```python
def retrieve(self, focal_points, time_step, n_count=120, curr_filter="all",
             hp=[0, 1, 0.5], stateless=True, verbose=False):
```

- `hp = [recency_w, relevance_w, importance_w] = [0, 1, 0.5]` — **recency weighted to zero**, a deliberate departure from Smallville's 1/1/1.
- Each component is normalized to `[0,1]` **independently over the candidate set** before the weighted sum (383-388). Normalization is per-query, so scores are not comparable across queries.
- O(n) over the entire stream per focal point — no index. Fine for one agent; not for 24/7 many agents. Our Convex `vectorIndex` replaces this and must be proven rank-equivalent.
- **Final ordering** (416-417): after top-N selection, nodes are sorted by `node.created` **ascending** — the comment says "descending" and is wrong. Retrieved memories reach the prompt in **chronological order**. **[PORT]** This ordering is load-bearing for prompt-byte equality; get it wrong and conformance fails.

---

## 3. `genagents/modules/interaction.py` (255 lines) — the response modes

### 3.1 The two agent descriptions are byte-identical

`_main_agent_desc` (17-28) and `_utterance_agent_desc` (31-43) are **the same function** — verified by diff, modulo a blank line. Presumably intended to diverge; never did.

**[PORT] — I got this wrong earlier.** `FIDELITY.md` originally instructed us to keep them separate because they were "different descriptions for prediction versus dialogue." They aren't. Corrected there. Splitting them is a future *option*, not a fidelity requirement.

Both build:

```
Self description: {str(scratch_dict)}
==
Other observations about the subject:

{node.content}     ← × up to 120 nodes, chronological
```

### 3.2 Anchor selection — a real design consequence

| Mode | Anchor (the retrieval query) | Line |
|---|---|---|
| `categorical_resp` | `" ".join(questions.keys())` | 85 |
| `numerical_resp` | `" ".join(questions.keys())` | 141 |
| `utterance` | the entire dialogue string, incl. the `[Fill in]` line | 183 |

**[PORT]** Batching questions concatenates them into one anchor. Twelve holdout questions batched = one long, semantically muddy query = degraded retrieval for every question in the batch. **Our scorecard should ask holdout questions singly** (or in tight topical groups), accepting more LLM calls for materially better retrieval. This is a product-quality decision that falls straight out of reading line 85.

### 3.3 Other

- `time_step` is hardcoded `0` in both desc functions (22, 36). With `recency_w = 0`, time is entirely inert across the whole interaction path.
- `n_count=120` (22, 36): up to 120 full memory contents are concatenated into every prompt. **[PORT] — this is the caching problem.** The block varies with the anchor, so it *cannot* sit in a cached prefix. Only `get_self_description()` is stable. See §5.
- Numeric casting (132-135): bare `float(i)` / `int(i)` with no `try` — malformed model output raises past the fail-safe.
- **`ask()` is broken.** `run_gpt_generate_ask` (189-229) points at `interaction/ask/batch_v1.txt` (220). That directory **does not exist** upstream — only `categorical_resp`, `numerical_resp`, `utternace`. It's also never exposed on `GenerativeAgent`. Dead code referencing a missing asset.
- `utternace` (165) — upstream typo in the template path. We preserve it verbatim so diffs stay clean.

---

## 3b. `simulation_engine/` — the files I first ported by inference

Read after the initial port, and both had already been implemented **wrongly**
from guesswork. This section is the reason "read it line by line" was the right
instruction.

### `gpt_structure.py:29 generate_prompt`

```python
prompt_input = [str(i) for i in prompt_input]
prompt = read(file)
for count, input_text in enumerate(prompt_input):
    prompt = prompt.replace(f"!<INPUT {count}>!", input_text)
if marker in prompt:
    prompt = prompt.split(marker)[1]
return prompt.strip()
```

Substitution runs over the **whole file including the header**, and the header is
discarded *afterwards*. Our first version stripped first, then substituted —
identical bytes for every current template, but it diverges the moment a header
changes or a substituted value contains the marker. Also `split(marker)[1]` takes
the segment *between* the first and second marker, not everything after the
first. Now matched exactly.

Also note `example-settings.py` sets `LLM_VERS = "gpt-4o-mini"` — upstream's real
default model, despite `gpt-4o` appearing as a function-signature default.

### `llm_json_parser.py` — three functions, all previously wrong

`extract_first_json_dict` (also duplicated verbatim at `global_methods.py:240`)
does three things our naive `JSON.parse(text.slice(text.indexOf('{')))` did not:

1. normalizes curly quotes (`“ ” ‘ ’`) — models emit them constantly in prose
2. **brace-counts** to the matching close, so trailing commentary is harmless
3. returns `None` rather than throwing

Measured against our own fixture set: **5 of 8 realistic model outputs would have
crashed the turn** under the old implementation, including the single most common
shape — a valid JSON object followed by "Let me know if you want another option!"

`extract_first_json_dict_categorical` and `_numerical` do **not parse JSON at
all** — they scrape with regex, deliberately, so a truncated or malformed
response still yields answers. And they differ from each other in a way that
matters:

| | pattern | Response shape |
|---|---|---|
| categorical | `"Response":\s*"([^"]+)"` | quoted **string** |
| numerical | `"Response":\s*(\d+\.?\d*)` | bare **number** |

Treating both identically silently fails on one of them. Ours did.

All three are now ported to `convex/gatherville/jsonParser.ts` and diffed against
the Python original in CI (`training/conformance/parser_check.py`, 8 cases, 0
mismatches).

### `environment/interview/interview.py`

Confirms the dialogue shape `utterance()` expects: a list of `[speaker, text]`
pairs, appended turn by turn. Also constructs agents as
`GenerativeAgent(population, agent_id)` — a **two-argument** constructor that does
not exist in `genagents.py`, whose `__init__` takes a single `agent_folder`.
Upstream inconsistency; neither form is load-bearing for us.

---

## 4. What this means for the port

| # | Finding | Action |
|---|---|---|
| 1 | Importance scale conflict 0–100 (genagents) vs 0–9 (ai-town) | **Blocking.** Standardize on 0–100; rescale ai-town's scorer. Constants corrected. |
| 2 | Retrieved-node block is anchor-dependent and dominates the prompt | Restructure prompt for caching (§5) — register as a deviation |
| 3 | Batched anchors degrade retrieval | Ask holdout questions singly |
| 4 | Degenerate normalization at low memory counts | Guard cold-start; don't trust twin output before N distinct memories |
| 5 | Chronological (ascending `created`) ordering of retrieved nodes | Required for conformance |
| 6 | `reflect()` positional-arg bug | Fix in our port; document as upstream divergence |
| 7 | Recency is inert (weight 0 + never-updated `last_retrieved`) | Implement faithfully-inert; do not "fix" without an A/B |
| 8 | `str(dict)` self-description | We render typed — deviation, needs A/B |
| 9 | `ask()` broken, template missing | Don't port. Build our own for holdout scoring. |
| 10 | `generate_prompt` substitutes *then* strips the header | Matched exactly in `renderTemplate` |
| 11 | `extract_first_json_dict` brace-counts + normalizes curly quotes | Ported to `jsonParser.ts`; 5/8 fixtures previously crashed |
| 12 | categorical/numerical scrape by **regex**, with different Response shapes | Ported; conformance-tested |

---

## 5. The caching consequence

The faithful prompt is:

```
Self description: {scratch}        ← stable per twin      ~200 tokens
==
Other observations…
{120 × node.content}               ← varies per anchor    ~3-6k tokens
```

Following genagents exactly means **the large block is volatile and the stable block is tiny** — well under the 512-token minimum cacheable prefix on Opus 5. Cache hit rate would be near zero, and my earlier ~$0.0019/decision estimate assumed the opposite.

Two ways out, both deviations:

- **(a) Two-tier retrieval.** A stable "core identity set" — top-K by importance, anchor-independent, recomputed only when the stream materially changes — placed *above* the cache breakpoint, plus a smaller anchor-specific set below it. Preserves genagents' ranking for the volatile part while making the prefix cacheable.
- **(b) Accept the cost.** Faithful, and roughly 3–4× more expensive per decision.

Recommendation: **(a), behind a flag, validated against holdout accuracy.** If two-tier retrieval measurably hurts prediction quality, we fall back to (b) and re-plan the cadence budget around the higher unit cost. Either way this must be decided before the 24/7 cost model is trustworthy — the current numbers in `constants.ts` assume (a) works.

---

## 6. Overall read

The research contribution is the **prompt templates and the interview-grounding methodology**, not the code. The code is a thin research harness: no stable ids, no schema, no indexing, an unreachable function, and two parameter bugs. That is entirely normal for a paper artifact and not a criticism — but it does mean **"port it faithfully" applies to the templates and the scoring function, not to the implementation.** Reproducing its bugs would be cargo-culting.

The conformance harness in `FIDELITY.md` should therefore assert on **prompt bytes and ranked retrieval output**, not on internal structure — those are the things that must match. Where we fix a bug (#6) or change a representation (#8), the harness needs an explicit expected-difference annotation so the diff stays meaningful rather than permanently red.
