<p align="center">
  <img src="docs/media/wordmark.png" alt="Siliconville" width="620">
</p>

<p align="center"><em>A city where everyone is AI. One of them can be you.</em></p>

<p align="center">
  <img src="docs/media/city.png" alt="The city, rendered in three.js — district balloons, company signage, and the letterforms the buildings are cut from" width="900">
</p>

Answer an interview, and the transcript becomes a resident: a figure that walks
around a compressed Silicon Valley, forms memories, talks to other residents,
and makes its own decisions. Then it takes a set of questions it has never seen
and tries to answer them the way you did — and you find out how well it knows
you.

That number is the point. A simulated person is easy to make believable and
hard to make *accurate*, and the difference is only visible if you measure it.

## Previous work

Siliconville builds on two projects, taking one specific thing from each:

- **From [ai-town](https://github.com/a16z-infra/ai-town)** (MIT, a16z-infra):
  the Convex simulation engine — the game loop, the input queue, pathfinding,
  and the world/collision-map format. Its own agents, personas, Pixi front end
  and default world are not here.
- **From generative agents** (MIT, Joon Sung Park — *Generative Agent
  Simulations of 1,000 People*, 2024): the memory architecture. The nine prompt
  templates are vendored verbatim, and the retrieval scoring function is
  reproduced exactly — recency weighted to zero, relevance 1.0, importance 0.5,
  normalised per candidate set.

The two solve different halves. ai-town has a world, but its agents are
invented. The generative-agents work has agents grounded in real interviews,
but no world for them to live in. Siliconville puts interview-grounded agents
into a persistent city and keeps the accuracy measurement attached to them.

See [`NOTICE.md`](NOTICE.md) for what is used from where, and
[`docs/FIDELITY.md`](docs/FIDELITY.md) for exactly what is copied bit-for-bit —
the accuracy figure only means something if the retrieval function matches.

## What is in here

```
convex/aiTown/       simulation engine (from ai-town)
convex/gatherville/  twins: interviews, memory, retrieval, decisions, scoring
convex/siliconville.ts   the city's own world, population rules, movement
prompts/genagents/   research prompt templates, vendored verbatim
src/siliconville/    the three.js city and its UI
data/siliconville/   the city generator (Python) and its output
```

## Deploying

Cloudflare Pages, Vercel or any static host — the frontend is a Vite build.

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Output directory | `dist` |
| Environment variables | `VITE_CONVEX_URL` (required), `VITE_GOOGLE_CLIENT_ID` (optional) |

`VITE_CONVEX_URL` must be set in the host's environment, not committed —
there is no `.env.production` in this repo on purpose. Vite inlines it at build
time, so a build without it produces a site that cannot reach a backend.

`public/_redirects` (Cloudflare) and `vercel.json` both rewrite every path to
`index.html`, which is what makes deep links work without a router.

## Running it

```bash
npm install
npx convex dev          # provisions a deployment and pushes the backend
npm run dev:frontend    # vite on :5173
```

Then set a model provider on the deployment. Any OpenAI-compatible endpoint
works; OpenRouter is the cheapest way to start:

```bash
npx convex env set OPENROUTER_API_KEY 'sk-or-...'
npx convex env set EMBEDDING_API_URL 'https://openrouter.ai/api/v1/embeddings'
npx convex env set EMBEDDING_MODEL 'openai/text-embedding-3-small'
```

Nothing costs money until someone completes an interview. There is a global kill
switch (`convex/gatherville/killswitch.ts`) that stops every paid outbound call
in one env var.

Copy `.env.example` to `.env.local` for the frontend. Both values in it are
public by design; your API keys live on the deployment, never in the repo.

## How the population works

The city seeds **nobody**. A resident exists only where a completed sign-up
exists — there is no way to obtain one otherwise, and a cron removes any agent
that appears without one. An empty city on first boot is correct, not broken.

This is deliberate. A city populated with invented characters looks identical to
one populated with real people, and that resemblance is exactly what would make
the accuracy number meaningless.

## Cost

The engine rewrites the world document once a second while it is running, so
cost scales with **uptime**, not population. Unwatched worlds stop themselves;
the page only sends a heartbeat while its tab is actually visible. If you fork
this and your bill surprises you, that loop is the first place to look.

## Licence

MIT. See [`LICENSE`](LICENSE) — it carries the copyright lines of both upstream
projects as well as this one.
