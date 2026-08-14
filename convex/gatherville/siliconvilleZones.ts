// What a resident knows about the city they live in.
//
// This is the shared world block in every decision prompt — identical for every
// resident, so it is the first cached block and the whole population shares one
// cache entry for it. Any accidental per-call variation here would invalidate
// that entry for everybody at once, which is why it is a module constant and
// not built per call.
//
// The coordinates come from data/siliconville/author.py, which generates the
// collision map. If you move a district there, move it here — a resident being
// told the Mission is somewhere it is not produces confident, wrong navigation
// rather than an obvious error.

import type { Zone } from './worldContext';

export const PLACE_NAME = 'Siliconville';

export const LABEL =
  'a compressed San Francisco Bay Area — five districts, one bay, one bridge';

/** One map tile is roughly this many feet, so distances read as walking steps. */
export const TILE_FEET = 12;

/**
 * Districts as zones, with the rectangles the generator actually uses.
 *
 * `approach` is the walkable edge a resident heads for. Districts are large and
 * open rather than served counters, so `service` is null throughout — nobody
 * queues for a neighbourhood.
 */
export const ZONES: Zone[] = [
  {
    id: 'FiDI',
    role: 'district_towers',
    rect: [26, 8, 104, 90],
    approach: [[104, 48]],
    service: null,
    note: 'The financial district in the north — the tallest towers. Perplexity is here.',
  },
  {
    id: 'Dogpatch',
    role: 'district_industrial',
    rect: [26, 102, 104, 176],
    approach: [[104, 140]],
    service: null,
    note: 'The old shipyard south of the bridge, cranes still standing. OpenAI and Anthropic are here.',
  },
  {
    id: 'SOMA',
    role: 'district_midrise',
    rect: [104, 12, 172, 78],
    approach: [[104, 45]],
    service: null,
    note: 'Mid-rise blocks east of downtown. a16z and Cloudflare are here, and Y Combinator.',
  },
  {
    id: 'Mission',
    role: 'district_dense',
    rect: [108, 122, 176, 180],
    approach: [[142, 122]],
    service: null,
    note: 'Dense and low-rise in the south-west. Philz Coffee is here.',
  },
  {
    id: 'Palo Alto',
    role: 'district_leafy',
    rect: [180, 122, 248, 180],
    approach: [[180, 150]],
    service: null,
    note: "Leafy and further out. Stanford R&D, Khosla Ventures, Pied Piper and Zareen's.",
  },
  {
    id: 'Chase Center',
    role: 'venue',
    rect: [176, 84, 208, 116],
    approach: [[176, 100]],
    service: null,
    note: 'The round arena. Open to walk into — this is where events happen.',
  },
  {
    id: 'the bridge',
    role: 'crossing',
    rect: [0, 92, 26, 100],
    approach: [[26, 96]],
    service: null,
    note: 'The red bridge over the bay, the only crossing between north and south.',
  },
];

/**
 * Staff counts by role. Empty: nobody in this city is staff.
 *
 * The residents are all residents. Keeping the key present rather than removing
 * the concept means a fork that adds baristas or receptionists has somewhere to
 * put them without touching the renderer.
 */
export const STAFF: Record<string, number> = {};
