# Provenance

Siliconville builds on the two projects below, taking a specific, documented
piece from each — so both need naming, and both licences travel with this
repository.

## ai-town — the simulation engine

MIT, copyright (c) 2023 a16z-infra. <https://github.com/a16z-infra/ai-town>

What is used: the Convex simulation engine and the game loop around it —
`convex/aiTown/`, `convex/engine/`, the input queue, pathfinding, historical
location buffers, and the tile/collision map format in `data/`.

What is **not** used: ai-town's own agents, its Smallville-derived personas, its
Pixi front end, and its default world. Those were removed. Siliconville draws
its own city in three.js and populates it only from real interviews.

## generative agents — the memory and response architecture

MIT, copyright (c) 2024 Joon Sung Park. Paper: *Generative Agent Simulations of
1,000 People* (Park et al., 2024).

What is used: the nine prompt templates, vendored verbatim to
`prompts/genagents/` with their original licence and directory layout preserved
(including an upstream typo in a path, kept so a diff against upstream stays
trivial); the retrieval scoring function; and the three response modes.

`docs/FIDELITY.md` records exactly what is copied bit-for-bit, what is adapted,
and what is ours — because the published ~85% accuracy figure only means
something if the retrieval function matches. Deviating there silently is the
easiest way to keep a number that no longer describes what the code does.

## Assets

Sprite sheets and tile art under `data/` and `public/assets/` are inherited from
ai-town and carry its licence.

Company names and marks rendered in the city (rooftop signage, hoardings,
balloons) are the trademarks of their respective owners. They appear as
depiction of a recognisable place, not as endorsement, affiliation, or a claim
of ownership. If you are one of those owners and would rather not appear, open
an issue.
