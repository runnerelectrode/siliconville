#!/usr/bin/env python3
"""Author Siliconville — a top-down valley of tech campuses.

    python3 data/siliconville/author.py

A fork of the front page's world: same renderer, same tile format, same 32px
grid. The park is replaced by an office park.

WHY THIS IS NOT THE REFERENCE IMAGE. The show's title sequence is isometric
low-poly 3D. This engine draws orthogonal top-down tiles. Matching the
projection would mean new projection math, a pathfinding remap, and every
character sprite redrawn in eight isometric directions -- a renderer project,
not a tileset purchase. What ports is the CONTENT: campus blocks, parking
aprons, solar roofs, tree-lined arterials, a freeway down one edge.

WHY THE ART IS PROCEDURAL. The atlas here is a blockout generated in code, so
the layout can be built and judged before any art is bought. LimeZu's Modern
Exteriors (32x32, same artist as the Modern Interiors already used for the
stadium concourse) drops in later as a TILE INDEX REMAP -- see TILES below.
Nothing about the city's structure depends on which pixels fill the tiles.

Names are the show's fictional companies. Pixel recreations of live trademarks
on a public page are a risk that buys nothing; Hooli is funnier anyway.
"""

import json
import math
import random
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
TILE = 32
W, H = 256, 192   # doubled on both axes; the city grows outward from centre

rng = random.Random(20260811)   # fixed: the map must be identical every run

# --- tile vocabulary --------------------------------------------------------
# Index is position in the atlas, row-major, 8 per row -- PixiStaticMap reads
# tiles as `x + y * numxtiles`. To adopt a real tileset, keep these NAMES and
# repoint the indices; the generator never hardcodes a number.
NAMES = [
    "grass", "grass_dry", "asphalt", "lane_h", "lane_v", "crosswalk_h",
    "crosswalk_v", "sidewalk",
    "lot", "lot_stripe", "roof_pale", "roof_slate", "roof_sand", "glass",
    "solar", "tree",
    "hedge", "water", "plaza", "roof_edge", "collide", "roof_white",
    "roof_teal", "roof_red", "roof_brick", "roof_rust",
]
T = {n: i for i, n in enumerate(NAMES)}
ATLAS_COLS = 8
ATLAS_ROWS = (len(NAMES) + ATLAS_COLS - 1) // ATLAS_COLS

SOLID = {"roof_pale", "roof_slate", "roof_sand", "glass", "solar", "tree",
         "hedge", "water", "roof_edge", "roof_white", "roof_teal", "roof_red",
         "roof_brick", "roof_rust"}

# --- layers -----------------------------------------------------------------
ground = [[T["grass"]] * H for _ in range(W)]
detail = [[-1] * H for _ in range(W)]
objects = [[-1] * H for _ in range(W)]
solid = [[False] * H for _ in range(W)]


def put(layer, x, y, t):
    if 0 <= x < W and 0 <= y < H:
        layer[x][y] = t


def fill(layer, x0, y0, x1, y1, t):
    for x in range(max(0, x0), min(W, x1)):
        for y in range(max(0, y0), min(H, y1)):
            layer[x][y] = t


def mark_solid(x0, y0, x1, y1):
    for x in range(max(0, x0), min(W, x1)):
        for y in range(max(0, y0), min(H, y1)):
            solid[x][y] = True


# --- street network ---------------------------------------------------------
# Arterials first, campuses fitted into whatever they leave over. Doing it the
# other way round is how you end up with a campus with no road frontage.
# Spacing is deliberately UNEVEN. An evenly-spaced grid reads as a spreadsheet,
# not a valley -- the first blockout looked like graph paper and that is a
# layout problem, not something a tileset can fix later.
# Generated from the map size rather than listed, so doubling W/H extends the
# grid instead of leaving the new land empty. Spacing still alternates -- an
# evenly-spaced grid reads as a spreadsheet, which was the first blockout's
# whole problem.
def _streets(start, end, gaps=(22, 26, 24)):
    out, x, i = [], start, 0
    while x < end:
        out.append((x, 4 if i % 2 == 0 else 3))
        x += gaps[i % len(gaps)]
        i += 1
    return out


FREEWAY_Y, FREEWAY_H = H - 8, 7                             # "the 101"
VSTREETS = _streets(24, W - 12)
HSTREETS = _streets(14, FREEWAY_Y - 14, (24, 20, 26))


def lay_roads():
    for x, w in VSTREETS:
        fill(ground, x, 0, x + w, FREEWAY_Y, T["asphalt"])
        for y in range(0, FREEWAY_Y, 4):          # dashed centre line
            put(detail, x + w // 2, y, T["lane_v"])
    for y, h in HSTREETS:
        fill(ground, 0, y, W, y + h, T["asphalt"])
        for x in range(0, W, 4):
            put(detail, x, y + h // 2, T["lane_h"])
    # Freeway: wider, unbroken, and nothing fronts onto it.
    fill(ground, 0, FREEWAY_Y, W, FREEWAY_Y + FREEWAY_H, T["asphalt"])
    for x in range(0, W, 3):
        put(detail, x, FREEWAY_Y + 2, T["lane_h"])
        put(detail, x, FREEWAY_Y + 4, T["lane_h"])
    # Crosswalks where arterials meet.
    for x, w in VSTREETS:
        for y, h in HSTREETS:
            for i in range(w):
                put(detail, x + i, y - 1, T["crosswalk_v"])
                put(detail, x + i, y + h, T["crosswalk_v"])
            for j in range(h):
                put(detail, x - 1, y + j, T["crosswalk_h"])
                put(detail, x + w, y + j, T["crosswalk_h"])


def carve_boulevard():
    """One curving arterial across the grid.

    Real valley arterials follow the bay and the hills, not a T-square. The
    campuses are fitted AFTER this is carved and simply refuse to build on
    anything that is no longer grass, so the curve clips blocks into irregular
    shapes for free instead of needing a second layout pass.
    """
    import math
    for x in range(W):
        cy = int(52 + 20 * math.sin((x / W) * 2.1 * math.pi + 0.6))
        for j in range(-2, 2):
            y = cy + j
            if 0 <= y < FREEWAY_Y:
                ground[x][y] = T["asphalt"]
                detail[x][y] = -1
                objects[x][y] = -1
                solid[x][y] = False
        if x % 4 == 0 and 0 <= cy < FREEWAY_Y:
            put(detail, x, cy, T["lane_h"])


def is_clear(x0, y0, x1, y1):
    """True when every tile is untouched grass — no road, no water, no build."""
    if x0 < 0 or y0 < 0 or x1 > W or y1 > FREEWAY_Y:
        return False
    for x in range(x0, x1):
        for y in range(y0, y1):
            if ground[x][y] != T["grass"] or objects[x][y] != -1:
                return False
    return True


def lay_sidewalks():
    """One tile of sidewalk wherever grass touches asphalt."""
    for x in range(W):
        for y in range(H):
            if ground[x][y] != T["grass"]:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                a, b = x + dx, y + dy
                if 0 <= a < W and 0 <= b < H and ground[a][b] == T["asphalt"]:
                    ground[x][y] = T["sidewalk"]
                    break


# --- blocks -----------------------------------------------------------------
def blocks():
    """Rectangles of developable land between the arterials."""
    xs = [0] + [x + w for x, w in VSTREETS] + [W]
    xe = [x for x, _ in VSTREETS] + [W, W]
    ys = [0] + [y + h for y, h in HSTREETS] + [FREEWAY_Y]
    ye = [y for y, _ in HSTREETS] + [FREEWAY_Y, FREEWAY_Y]
    out = []
    for i in range(len(xs) - 1):
        for j in range(len(ys) - 1):
            x0, x1 = xs[i] + 2, xe[i] - 2
            y0, y1 = ys[j] + 2, ye[j] - 2
            if x1 - x0 >= 8 and y1 - y0 >= 7:
                out.append((x0, y0, x1, y1))
    return out


ROOFS = ["roof_pale", "roof_slate", "roof_sand", "roof_white", "roof_teal"]

# The named campuses. Footprint is a hint in tiles; the fitter clamps it to the
# block. Order matters -- earlier names claim the larger central blocks.
# Silhouette matters more than roof colour: a valley of identical boxes reads
# as a business park anywhere on earth. The ring is doing the most work here --
# a doughnut campus is the single most recognisable building in the valley.
# The valley's current occupants. These are real companies, named in text
# rather than by recreating their logo artwork -- a wordmark on a hoarding is
# how a building is actually labelled, and it does not reproduce anyone's mark.
LANDMARKS = [
    ("OpenAI",           "roof_white", 26, 22, "ring"),
    ("Anthropic",        "roof_white", 14, 14, "tower"),
    ("NVIDIA",           "roof_slate", 16, 11, "terrace"),
    ("Google DeepMind",  "roof_teal",  18, 11, "slab"),
    ("Meta AI",          "roof_pale",  13, 9,  "garage"),
    ("Microsoft Copilot", "roof_slate", 15, 10, "terrace"),
    ("Perplexity",       "roof_sand",  10, 7,  "slab"),
    ("Hugging Face",     "roof_sand",  15, 10, "garage"),
    ("xAI",              "roof_teal",  13, 9,  "slab"),
    ("Mistral",          "roof_pale",  17, 11, "terrace"),
    ("a16z",             "roof_slate", 15, 10, "terrace"),
    ("Cloudflare",       "roof_pale",  16, 11, "terrace"),
    ("Stanford R&D",     "roof_sand",  18, 12, "terrace"),
    ("Pied Piper",       "roof_teal",  11, 8,  "slab"),
    ("Khosla Ventures",  "roof_white", 15, 10, "terrace"),
    ("Y Combinator",     "roof_sand",  22, 18, "terrace"),
    ("Philz Coffee",     "roof_red",   10, 7,  "slab"),
    ("Zareen's",        "roof_sand",  12, 8,  "slab"),
]


# Every roof mass, with a floor count. The 2D map never needed this -- a
# top-down tile has no z -- but it is the whole difference between a floorplan
# and a city, so the generator records it whether or not the 2D view uses it.
MASSES = []

# Every mass gets a door on the side that faces the nearest street, plus a
# lobby tile just outside it. This is the hook the simulation needs: an agent
# cannot "enter a building" without an agreed tile to walk to and a threshold
# to cross. Recording it in the GENERATOR rather than the renderer means the
# 2D map, the 3D view and the sim all agree on where the door is.
def _door_for(bx, by, w, h):
    best = None
    for side, (dx, dy, cx, cy) in {
        "S": (0, 1, bx + w // 2, by + h),
        "N": (0, -1, bx + w // 2, by - 1),
        "E": (1, 0, bx + w, by + h // 2),
        "W": (-1, 0, bx - 1, by + h // 2),
    }.items():
        # Walk outward until we hit asphalt; the shortest walk wins.
        for step in range(1, 14):
            x, y = cx + dx * step, cy + dy * step
            if not (0 <= x < W and 0 <= y < H):
                break
            if ground[x][y] == T["asphalt"]:
                if best is None or step < best[0]:
                    best = (step, side, cx, cy)
                break
    if best is None:
        return None
    _, side, cx, cy = best
    return {"side": side, "x": max(0, min(W - 1, cx)), "y": max(0, min(H - 1, cy))}


def slab(bx, by, w, h, roof, floors=2, style="slab", arches=None):
    """One roof mass: parapet rim, rooftop solar, and an atrium if it fits."""
    MASSES.append({"x": bx, "y": by, "w": w, "h": h, "roof": roof,
                   "floors": floors, "style": style,
                   "door": _door_for(bx, by, w, h),
                   "arches": arches or []})
    fill(objects, bx, by, bx + w, by + h, T[roof])
    # Darker rim reads as parapet + shadow and stops roofs merging into slabs.
    for x in range(bx, bx + w):
        put(objects, x, by + h - 1, T["roof_edge"])
    for y in range(by, by + h):
        put(objects, bx + w - 1, y, T["roof_edge"])
    for x in range(bx + 1, bx + w - 2, 2):
        for y in range(by + 1, by + h - 2, 2):
            if rng.random() < 0.6:
                put(objects, x, y, T["solar"])
    if w >= 9 and h >= 7:
        gx, gy = bx + w // 2 - 1, by + h // 2 - 1
        fill(objects, gx, gy, gx + 2, gy + 2, T["glass"])
    mark_solid(bx, by, bx + w, by + h)


def build_campus(b, name=None, roof=None, want=None, style=None):
    """A building, its parking apron, and landscaping — with road frontage.

    Footprints are L-shaped or courtyard as often as they are rectangles.
    A valley of identical rectangles was the other half of the graph-paper
    problem; varying the MASS matters more than varying the roof colour.
    """
    x0, y0, x1, y1 = b
    bw, bh = x1 - x0, y1 - y0

    if want:
        w, h = min(want[0], bw - 2), min(want[1], bh - 3)
    else:
        w = rng.randint(max(7, int(bw * 0.45)), max(8, int(bw * 0.75)))
        h = rng.randint(max(5, int(bh * 0.40)), max(6, int(bh * 0.62)))
    w, h = max(5, w), max(4, h)

    bx = x0 + (bw - w) // 2 if want else rng.choice([x0, x1 - w, x0 + (bw - w) // 2])
    by = y0 + 1
    bx = max(x0, min(bx, x1 - w))

    # The curved boulevard may have eaten this block. Shrink before giving up.
    while not is_clear(bx, by, bx + w, by + h):
        w, h = w - 1, h - 1
        if w < 5 or h < 4:
            return None
        bx = max(x0, min(bx, x1 - w))

    roof = roof or rng.choice(ROOFS)
    shape = "rect" if (style in ("ring", "tower", "garage") or (want and want[0] < 12)) \
        else rng.choice(["rect", "L", "L", "court", "twin"])
    # Named HQs stand taller so the skyline has anchors; the valley is
    # otherwise deliberately low-rise, which is what it actually looks like.
    floors = rng.randint(3, 6) if name else rng.randint(1, 3)
    # Unnamed blocks get variety too, weighted low-rise — the valley really is
    # mostly two storeys, with a few towers punctuating it.
    if style is None:
        style = rng.choice(["slab", "slab", "terrace", "garage", "tower"])
    if style == "tower":
        floors = rng.randint(7, 13)
    elif style == "garage":
        floors = rng.randint(3, 5)
    elif style == "ring":
        floors = 4

    if shape == "L" and w >= 8 and h >= 6:
        cut_w, cut_h = w // 3, h // 2
        slab(bx, by, w, h - cut_h, roof, floors, style)
        slab(bx, by + h - cut_h, w - cut_w, cut_h, roof, max(1, floors - 1), style)
    elif shape == "court" and w >= 11 and h >= 8:
        slab(bx, by, w, h, roof, floors, style)
        # Punch a landscaped courtyard out of the middle.
        cx, cy = bx + w // 3, by + h // 3
        for x in range(cx, min(cx + w // 3, bx + w - 1)):
            for y in range(cy, min(cy + h // 3, by + h - 1)):
                objects[x][y] = T["hedge"] if (x + y) % 3 else T["plaza"]
                solid[x][y] = True
    elif shape == "twin" and w >= 12:
        gap = 2
        half = (w - gap) // 2
        slab(bx, by, half, h, roof, floors, style)
        slab(bx + half + gap, by, w - half - gap, h, roof, max(1, floors - 1), style)
    else:
        slab(bx, by, w, h, roof, floors, style)

    # Parking apron on the leftover land, striped.
    py = by + h + 1
    if y1 - py >= 3:
        for x in range(x0, x1):
            for y in range(py, y1):
                if ground[x][y] == T["grass"] and objects[x][y] == -1:
                    ground[x][y] = T["lot"]
                    if x % 2 == 0:
                        detail[x][y] = T["lot_stripe"]

    return {"name": name, "x": bx, "y": by, "w": w, "h": h} if name else None


def street_trees():
    """Trees on the sidewalk, evenly spaced — avenues, not scatter."""
    for x in range(W):
        for y in range(FREEWAY_Y):
            if ground[x][y] != T["sidewalk"] or objects[x][y] != -1:
                continue
            if (x + y) % 5 == 0 and rng.random() < 0.55:
                objects[x][y] = T["tree"]
                solid[x][y] = True


# The two San Francisco districts, one either side of the crossing. They are
# placed by BOUNDS rather than by naming particular blocks, so they survive any
# change to the street spacing -- a block simply asks which district it is in.
BAY_X = 26          # everything west of this is water
BRIDGE_Y = H // 2   # the crossing, in tiles

# Who sits where. The district builders run before the general campus loop, so
# these names are pulled out of the main queue first and handed to the district
# that claims them — otherwise they would land on whatever block happened to be
# biggest, which is how they all ended up in the suburbs.
DISTRICT_TENANTS = {
    "Dogpatch": ["OpenAI", "Anthropic"],
    "FiDI": ["Perplexity"],
    "SOMA": ["a16z", "Cloudflare"],
    "Mission": ["Y Combinator", "Philz Coffee"],
    "Palo Alto": ["Zareen's", "Stanford R&D", "Pied Piper", "Khosla Ventures"],
}

DISTRICTS = [
    # name        x0      y0             x1   y1
    ("FiDI",      BAY_X,  8,             104, BRIDGE_Y - 6),   # north: towers
    ("Dogpatch",  BAY_X,  BRIDGE_Y + 6,  104, H - 16),         # south: shipyard
    ("SOMA",      104,    12,            172, 78),             # east: mid-rise
    ("Mission",   108,    H - 70,        176, H - 12),         # south-west: dense
    ("Palo Alto", 180,    H - 70,        248, H - 12),         # south-east: leafy
]


def carve_bay():
    """Open water along the west edge, with one causeway left for the bridge.

    Geographically the Golden Gate is nowhere near the valley, but the
    reference is a stylised collage -- it has a stadium and hot-air balloons --
    and a red suspension bridge is the most legible landmark on the west coast.
    Carved BEFORE the campuses so nothing is ever built into the water.
    """
    for x in range(BAY_X):
        for y in range(H):
            ground[x][y] = T["grass"]
            detail[x][y] = -1
            objects[x][y] = T["water"]
            solid[x][y] = True
    # The bridge deck lands on a causeway, so the street grid still reaches it.
    for x in range(BAY_X):
        for y in range(BRIDGE_Y - 2, BRIDGE_Y + 2):
            objects[x][y] = -1
            ground[x][y] = T["asphalt"]
            solid[x][y] = False


def district_of(b):
    cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    for name, x0, y0, x1, y1 in DISTRICTS:
        if x0 <= cx < x1 and y0 <= cy < y1:
            return name
    return None


def build_fidi(b, names=None):
    """Downtown: several narrow towers per block, built right to the lot line.

    The valley's typology is the opposite of this -- low, wide, set back behind
    parking. Putting them next to each other is the whole point of the two
    districts; the contrast is what makes either one read.
    """
    x0, y0, x1, y1 = b
    out = []
    n = rng.randint(2, 3)
    step = (x1 - x0) // n
    for k in range(n):
        w = max(5, step - 2)
        h = max(5, min(y1 - y0 - 2, 10))
        bx, by = x0 + k * step + 1, y0 + 1
        if not is_clear(bx, by, bx + w, by + h):
            continue
        pyramid = k == 0 and rng.random() < 0.55
        slab(bx, by, w, h,
             rng.choice(["roof_pale", "roof_slate", "roof_white"]),
             rng.randint(9, 12) if pyramid else rng.randint(8, 18),
             "pyramid" if pyramid else "tower")
        if names:
            out.append({"name": names.pop(0), "x": bx, "y": by, "w": w, "h": h})
    return out


def build_dogpatch(b, names=None):
    """Shipyard: long low brick sheds, a gantry crane, no lawns."""
    x0, y0, x1, y1 = b
    out = []
    w, h = x1 - x0 - 2, min(y1 - y0 - 3, 9)
    if is_clear(x0 + 1, y0 + 1, x0 + 1 + w, y0 + 1 + h):
        # A named tenant gets a proper office block, not a shed — the shipyard
        # is the setting, not the architecture of everyone in it.
        named = names.pop(0) if names else None
        slab(x0 + 1, y0 + 1, w, h,
             "roof_pale" if named else rng.choice(["roof_brick", "roof_rust", "roof_brick"]),
             rng.randint(4, 6) if named else rng.randint(1, 2),
             "terrace" if named else "warehouse")
        if named:
            out.append({"name": named, "x": x0 + 1, "y": y0 + 1, "w": w, "h": h})
    # A crane on the waterfront edge only — inland gantries look like a mistake.
    cy = y0 + h + 3
    if x0 < BAY_X + 24 and y1 - cy >= 4 and is_clear(x0 + 1, cy, x0 + 6, cy + 4):
        slab(x0 + 1, cy, 5, 4, "roof_rust", 1, "crane")
    return out


SIGN_FLOORS = 5     # every slab under the sign is exactly this tall


# The words are rasterised from a REAL typeface rather than a hand-drawn
# bitmap. The reference uses a heavy grotesque with proper curves and counters;
# a 5x7 grid cannot make the bowl of an S or the diagonal of an N, and it
# looked like a spreadsheet font because it was one.
#
# Rendering the glyphs and reading back their pixels gives true letterforms at
# whatever coarseness we want, and it happens in the GENERATOR so the shapes
# exist in the authored tile map, not only in the renderer.
FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Black.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/HelveticaNeue.ttc",
]
LETTER_CELL = 1           # tiles per rasterised pixel — 1 follows the curve
LETTER_FLOORS = 6
WORD_CELLS = 132          # width of the longer word, in raster cells


def _font(size):
    from PIL import ImageFont
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _raster(words):
    """Rasterise each word to a 0/1 grid, all at one common scale."""
    from PIL import Image, ImageDraw
    f = _font(240)
    boxes = {w: f.getbbox(w) for w in words}
    scale = WORD_CELLS / (boxes[words[0]][2] - boxes[words[0]][0])
    out = {}
    for w in words:
        x0, y0, x1, y1 = boxes[w]
        img = Image.new("L", (x1 - x0 + 8, y1 - y0 + 8), 0)
        ImageDraw.Draw(img).text((4 - x0, 4 - y0), w, fill=255, font=f)
        cw = max(1, round(img.width * scale))
        ch = max(1, round(img.height * scale))
        small = img.resize((cw, ch), Image.LANCZOS)
        px = small.load()
        # 110 rather than 128: a slightly generous threshold keeps thin joins
        # (the waist of an S, the crossbar of an E) from breaking into islands.
        out[w] = [[1 if px[x, y] > 110 else 0 for x in range(cw)] for y in range(ch)]
    return out


def _crossings(bx, by, bw, bh):
    """Bands of road that pass clean through this footprint.

    Only a FULL crossing counts — asphalt on every tile across the short axis.
    A partial overlap is a building that clips a kerb, which wants moving, not
    an archway punched through it.
    """
    out = []
    run = None
    for k in range(bw):
        full = all(0 <= bx + k < W and 0 <= by + j < H
                   and ground[bx + k][by + j] == T["asphalt"] for j in range(bh))
        if full and run is None:
            run = k
        elif not full and run is not None:
            out.append(("x", run, k))
            run = None
    if run is not None:
        out.append(("x", run, bw))
    run = None
    for k in range(bh):
        full = all(0 <= bx + j < W and 0 <= by + k < H
                   and ground[bx + j][by + k] == T["asphalt"] for j in range(bw))
        if full and run is None:
            run = k
        elif not full and run is not None:
            out.append(("z", run, k))
            run = None
    if run is not None:
        out.append(("z", run, bh))
    return out


def _outlines(word, rect):
    """True glyph CONTOURS for a word, mapped onto `rect` in tile space.

    The buildings under the words come from a rasterised grid, and a grid can
    only make staircases -- every curve in an S or an O became a flight of
    steps. The red letter form on top is therefore built from the font's actual
    outline instead, flattened to polygons, so the part you read is smooth
    while the massing underneath stays on the tile grid where it belongs.

    Mapped by BOUNDING BOX onto the same rect the raster occupies, so the smooth
    cap lands exactly on the buildings rather than near them.
    """
    from matplotlib.font_manager import FontProperties
    from matplotlib.path import Path
    from matplotlib.textpath import TextPath

    fp = None
    for cand in FONT_CANDIDATES:
        try:
            fp = FontProperties(fname=cand)
            TextPath((0, 0), "X", size=64, prop=fp)
            break
        except Exception:
            fp = None
    if fp is None:
        return []

    tp = TextPath((0, 0), word, size=256, prop=fp)
    polys = [p for p in tp.to_polygons() if len(p) >= 3]
    if not polys:
        return []
    xs = [pt[0] for p in polys for pt in p]
    ys = [pt[1] for p in polys for pt in p]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    rx, ry, rw, rh = rect
    sx = rw / (x1 - x0) if x1 > x0 else 1.0
    sy = rh / (y1 - y0) if y1 > y0 else 1.0

    def to_tiles(pt):
        # Font y runs up, tiles run down, hence the flip.
        return [rx + (pt[0] - x0) * sx, ry + (y1 - pt[1]) * sy]

    shaped = [[to_tiles(pt) for pt in p] for p in polys]

    # Which contours are counters (the hole in an O, the bowl of a B)? Any
    # contour whose first point lies inside another contour.
    mpl = [Path(p) for p in polys]
    out, used = [], set()
    for i, p in enumerate(polys):
        if i in used:
            continue
        holes = []
        for j, q in enumerate(polys):
            if j == i or j in used:
                continue
            if mpl[i].contains_point(q[0]):
                holes.append(shaped[j])
                used.add(j)
        out.append({"outer": shaped[i], "holes": holes})
        used.add(i)
    return out


def _rects(grid):
    """Cover a 0/1 grid with as few axis-aligned rectangles as it takes.

    Per-ROW strips were the previous approach and they are why the buildings
    stepped so coarsely: at one row per slab the only way to keep the mesh
    count sane was a fat row, and a fat row cannot follow a curve. Greedy
    maximal rectangles let the raster run at twice the resolution while
    producing FEWER masses than before, because the straight parts of a letter
    collapse into single large blocks and only the curved edges stay fine.
    """
    h, w = len(grid), len(grid[0])
    used = [[False] * w for _ in range(h)]
    out = []
    for r in range(h):
        for c in range(w):
            if not grid[r][c] or used[r][c]:
                continue
            # Widest run on this row...
            cw = 0
            while c + cw < w and grid[r][c + cw] and not used[r][c + cw]:
                cw += 1
            # ...then as far down as that full width holds.
            ch = 1
            while r + ch < h:
                if all(grid[r + ch][c + k] and not used[r + ch][c + k] for k in range(cw)):
                    ch += 1
                else:
                    break
            for rr in range(r, r + ch):
                for cc in range(c, c + cw):
                    used[rr][cc] = True
            out.append((c, r, cw, ch))
    return out


def build_letter_city():
    """Build SILICON VILLE as buildings shaped like the letters themselves.

    The reference does not lay type over a block; the massing spells the words,
    with ordinary windowed facades below and the red letter form on top. Every
    version that overlaid a banner read as a decal, whatever its size.

    Each horizontal run of set pixels becomes one building, so a letter is a
    few long slabs rather than a swarm of cubes.
    """
    words = ["SILICON", "VILLE"]
    grids = _raster(words)
    rows_h = max(len(g) for g in grids.values())
    total_w = max(len(g[0]) for g in grids.values()) * LETTER_CELL
    x_start = (W - total_w) // 2
    y_start = int(H * 0.38)
    placed = 0
    for ri, word in enumerate(words):
        g = grids[word]
        oy = y_start + ri * (rows_h + 2) * LETTER_CELL
        ox = x_start + ri * 6                        # stagger, as in the poster
        for (rc, rr, rw, rh) in _rects(g):
                bx, by = ox + rc * LETTER_CELL, oy + rr * LETTER_CELL
                bw, bh = rw * LETTER_CELL, rh * LETTER_CELL
                # Streets SURVIVE under the words. Erasing them left roads
                # dead-ending into a wall with cars driving through it; the
                # buildings now bridge over the carriageway on an archway
                # instead, which is both honest and better looking.
                arches = _crossings(bx, by, bw, bh)
                keep = set()
                for ax, a0, a1 in arches:
                    for k in range(a0, a1):
                        for j in range(bh):
                            keep.add((bx + k, by + j) if ax == "x" else (bx + j, by + k))
                for x in range(max(0, bx), min(W, bx + bw)):
                    for y in range(max(0, by), min(H, by + bh)):
                        if (x, y) in keep:
                            continue
                        ground[x][y] = T["grass"]
                        detail[x][y] = -1
                        objects[x][y] = -1
                slab(bx, by, bw, bh, "roof_red", LETTER_FLOORS, "letter", arches)
                # The road under an arch stays ASPHALT — the cars are placed
                # from the ground surface, so they still drive through it — but
                # it stays SOLID for anything that pathfinds. Agents were
                # routing under the letters and standing inside the archways,
                # which reads as people trying to walk into a building.
                #
                # Collision and surface are different questions here, and this
                # is the one place they disagree on purpose.
                placed += 1
    outlines = []
    rects_out = []
    for ri, word in enumerate(words):
        g = grids[word]
        rect = (x_start + ri * 6,
                y_start + ri * (rows_h + 2) * LETTER_CELL,
                len(g[0]) * LETTER_CELL, len(g) * LETTER_CELL)
        outlines.append({"word": word, "rect": list(rect),
                         "shapes": _outlines(word, rect)})
        rects_out.append(rect)
    return {"x": x_start, "y": y_start, "w": total_w,
            "h": (2 * rows_h + 2) * LETTER_CELL,
            "floors": LETTER_FLOORS, "blocks": placed,
            "outlines": outlines, "rects": rects_out}


def build_soma(b, names=None):
    """South of Market: mid-rise infill, denser than the valley, lower than
    downtown. Two or three blocks to a lot, built to the pavement, no lawns."""
    x0, y0, x1, y1 = b
    out = []
    cols = 2 if (x1 - x0) < 24 else 3
    step = (x1 - x0) // cols
    for k in range(cols):
        w = max(6, step - 2)
        h = max(6, min(y1 - y0 - 2, 13))
        bx, by = x0 + k * step + 1, y0 + 1
        if not is_clear(bx, by, bx + w, by + h):
            continue
        named = names.pop(0) if names else None
        slab(bx, by, w, h,
             "roof_pale" if named else rng.choice(["roof_brick", "roof_slate", "roof_sand"]),
             rng.randint(5, 7) if named else rng.randint(3, 6),
             "terrace" if named else rng.choice(["slab", "terrace"]))
        if named:
            out.append({"name": named, "x": bx, "y": by, "w": w, "h": h})
    return out


def build_mission(b, names=None):
    """Low-rise, dense, built to the pavement, and the only district with
    colour on its roofs. Mission's whole character is that it is NOT set back
    behind a lawn like the peninsula six blocks south of it."""
    x0, y0, x1, y1 = b
    out = []
    cols = 2 if (x1 - x0) < 26 else 3
    step = (x1 - x0) // cols
    for k in range(cols):
        w = max(6, step - 2)
        h = max(6, min(y1 - y0 - 2, 12))
        bx, by = x0 + k * step + 1, y0 + 1
        if not is_clear(bx, by, bx + w, by + h):
            continue
        named = names.pop(0) if names else None
        # A named tenant in the Mission gets the whole lot and a taller mass —
        # at three storeys on a shared block Y Combinator was a shed with a
        # sign on it, which is not what it is.
        if named:
            w, h = x1 - x0 - 2, min(y1 - y0 - 2, 18)
            bx, by = x0 + 1, y0 + 1
            if not is_clear(bx, by, bx + w, by + h):
                w, h = max(6, step - 2), max(6, min(y1 - y0 - 2, 12))
        slab(bx, by, w, h,
             "roof_white" if named else rng.choice(["roof_teal", "roof_sand", "roof_red", "roof_brick"]),
             rng.randint(5, 7) if named else rng.randint(2, 4),
             "terrace" if named else rng.choice(["slab", "terrace"]))
        if named:
            out.append({"name": named, "x": bx, "y": by, "w": w, "h": h})
    return out


def build_palo_alto(b, names=None):
    """Low, leafy, generously set back — the opposite of SOMA's street wall.

    Two storeys and a lot of lawn is what the peninsula actually looks like,
    and it is the contrast with downtown that makes either district legible.
    """
    x0, y0, x1, y1 = b
    out = []
    w = max(8, int((x1 - x0) * 0.62))
    h = max(6, int((y1 - y0) * 0.5))
    bx, by = x0 + ((x1 - x0) - w) // 2, y0 + 2
    if not is_clear(bx, by, bx + w, by + h):
        return out
    named = names.pop(0) if names else None
    slab(bx, by, w, h,
         "roof_sand" if named else rng.choice(["roof_pale", "roof_sand", "roof_white"]),
         rng.randint(2, 3) if named else rng.randint(1, 2),
         "terrace")
    if named:
        out.append({"name": named, "x": bx, "y": by, "w": w, "h": h})
    # Oaks along the frontage; the setback is the point.
    for x in range(x0, x1, 3):
        yy = y1 - 2
        if 0 <= x < W and 0 <= yy < H and ground[x][yy] == T["grass"] and objects[x][yy] == -1:
            objects[x][yy] = T["tree"]
            solid[x][yy] = True
    return out


def fence_letter_grounds(rects):
    """Close the ground inside the words to pedestrians.

    The letter FOOTPRINTS were already solid, but the gaps between strokes —
    the counter of an O, the notch of a C, the space between two letters — are
    grass, and grass is walkable, so agents stood in them. Enclosed on three
    sides by twenty-foot red letters, that reads as standing inside the
    building rather than beside it.

    Streets keep their surface: a road crossing the word is a road, and this
    only takes the greenery. Anything left unreachable afterwards is filled by
    seal_islands, which runs next.
    """
    n = 0
    for (rx, ry, rw, rh) in rects:
        for x in range(max(0, rx - 1), min(W, rx + rw + 1)):
            for y in range(max(0, ry - 1), min(H, ry + rh + 1)):
                if solid[x][y] or ground[x][y] == T["asphalt"]:
                    continue
                solid[x][y] = True
                if objects[x][y] == -1:
                    objects[x][y] = T["hedge"]
                n += 1
    return n


def seal_islands():
    """Make every walkable tile reachable, by filling the ones that are not.

    Closing the archways to pedestrians left small pockets whose only way out
    was under a letter. A pocket is worse than a wall: an agent that spawns or
    wanders into one is stuck there for the rest of the run, doing nothing,
    and nothing in the engine will ever notice. Filling them means the walkable
    area is a single connected region by construction.
    """
    from collections import deque
    seed = next(((x, y) for x in range(W) for y in range(H)
                 if ground[x][y] == T["asphalt"] and not solid[x][y]), None)
    if not seed:
        return 0
    seen = [[False] * H for _ in range(W)]
    q = deque([seed])
    while q:
        x, y = q.popleft()
        if not (0 <= x < W and 0 <= y < H) or seen[x][y] or solid[x][y]:
            continue
        seen[x][y] = True
        q.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    n = 0
    for x in range(W):
        for y in range(H):
            if not solid[x][y] and not seen[x][y]:
                solid[x][y] = True
                if objects[x][y] == -1:
                    objects[x][y] = T["hedge"]     # something is there, visibly
                n += 1
    return n


def build_chase_center(bs):
    """An arena, open to the street, where agents can actually go inside.

    Replaces the retention pond. A pond is scenery — nothing can enter it and
    nothing happens there. An arena with a courtyard and four entrances is a
    PLACE: the ring is solid so it reads as a building, the middle is walkable
    so a crowd can gather, and the gaps mean the pathfinder can get them in and
    out without special-casing anything.
    """
    # The BIGGEST block, not the middle one. An arena that ends up smaller than
    # the offices around it is not an arena, and its sign was the smallest
    # thing on the street as a result.
    # ON LAND, and big. blocks() covers the bay too — the campus builders never
    # noticed because is_clear() rejects water, but this one clears its own site
    # first, so it happily built an arena in the harbour. Surrounded by water it
    # was unreachable, and seal_islands then filled the courtyard in, which is
    # how a stadium ends up as a solid block of concrete.
    fit = [
        b for b in bs
        if (b[2] - b[0]) >= 14 and (b[3] - b[1]) >= 12
        and b[0] >= BAY_X + 2
        and is_clear(b[0] + 1, b[1] + 1, b[2] - 1, b[3] - 1)
    ]
    if not fit:
        return None, None
    b = max(fit, key=lambda r: (r[2] - r[0]) * (r[3] - r[1]))
    x0, y0, x1, y1 = b
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    R = max(6, min((x1 - x0) // 2 - 1, (y1 - y0) // 2 - 1))
    inner = max(3, int(R * 0.6))

    for x in range(cx - R, cx + R + 1):
        for y in range(cy - R, cy + R + 1):
            if not (0 <= x < W and 0 <= y < H):
                continue
            d = math.hypot(x - cx, y - cy)
            if d > R:
                continue
            ground[x][y] = T["plaza"]
            detail[x][y] = -1
            objects[x][y] = -1
            solid[x][y] = False
            # The concourse ring is solid, except on the four axes where the
            # entrances are. Two tiles either side of centre is wide enough for
            # the pathfinder and reads as a doorway rather than a crack.
            if inner <= d <= R and abs(x - cx) > 2 and abs(y - cy) > 2:
                objects[x][y] = T["roof_pale"]
                solid[x][y] = True

    mass = {"x": cx - R, "y": cy - R, "w": 2 * R, "h": 2 * R,
            "roof": "roof_pale", "floors": 4, "style": "ring",
            "door": {"side": "S", "x": cx, "y": cy + R + 1}, "arches": []}
    MASSES.append(mass)
    return b, {"name": "Chase Center", "x": cx - R, "y": cy - R, "w": 2 * R, "h": 2 * R}


def greenery():
    for _ in range(560):
        x, y = rng.randrange(W), rng.randrange(FREEWAY_Y)
        if ground[x][y] == T["grass"] and objects[x][y] == -1:
            put(objects, x, y, T["tree"])
            solid[x][y] = True
    for x in range(W):
        for y in range(H):
            if ground[x][y] == T["grass"] and rng.random() < 0.10:
                put(detail, x, y, T["grass_dry"])


def main():
    lay_roads()
    carve_boulevard()
    carve_bay()
    lay_sidewalks()
    bs = blocks()
    # Claim the sign's ground before anything else competes for it.
    sign = build_letter_city()
    outline_rects = sign.get("rects", [])
    sx0, sy0 = sign["x"], sign["y"]
    sx1, sy1 = sx0 + sign["w"], sy0 + sign["h"]
    bs = [b for b in bs
          if not (sx0 <= (b[0] + b[2]) / 2 < sx1 and sy0 <= (b[1] + b[3]) / 2 < sy1)]
    arena_block, arena = build_chase_center(bs)
    bs = [b for b in bs if b != arena_block]

    # Biggest blocks first so Hooli lands somewhere that fits it.
    order = sorted(range(len(bs)), key=lambda i: -((bs[i][2] - bs[i][0]) * (bs[i][3] - bs[i][1])))
    tenants = {k: list(v) for k, v in DISTRICT_TENANTS.items()}
    claimed = {n for v in tenants.values() for n in v}
    placed = []
    nameq = [l for l in LANDMARKS if l[0] not in claimed]
    for i in order:
        d = district_of(bs[i])
        if d == "FiDI":
            placed += build_fidi(bs[i], tenants["FiDI"])
            continue
        if d == "Dogpatch":
            placed += build_dogpatch(bs[i], tenants["Dogpatch"])
            continue
        if d == "SOMA":
            placed += build_soma(bs[i], tenants["SOMA"])
            continue
        if d == "Mission":
            placed += build_mission(bs[i], tenants["Mission"])
            continue
        if d == "Palo Alto":
            placed += build_palo_alto(bs[i], tenants["Palo Alto"])
            continue
        if nameq:
            name, roof, w, h, style = nameq[0]
            got = build_campus(bs[i], name, roof, (w, h), style)
            if got:                       # a clipped block can refuse to build;
                placed.append(got)        # the name waits for one that fits
                nameq.pop(0)
        else:
            build_campus(bs[i])
    if arena:
        placed.append(arena)
    street_trees()
    greenery()
    fenced = fence_letter_grounds(outline_rects)
    sealed = seal_islands()
    if nameq:
        print(f"  ! no block fit: {[n[0] for n in nameq]}")

    make_atlas()
    out = {
        "width": W, "height": H, "tile": TILE,
        "atlasCols": ATLAS_COLS, "atlasRows": ATLAS_ROWS,
        "layers": {"ground": ground, "detail": detail, "objects": objects},
        "solid": solid,
        "landmarks": placed,
        # The street grid, so the renderer can put crossings and signals at the
        # real intersections instead of guessing at a spacing that has already
        # changed once.
        "vstreets": VSTREETS, "hstreets": HSTREETS,
        "bayX": BAY_X, "bridgeY": BRIDGE_Y, "freewayY": FREEWAY_Y,
        "sign": sign,
        # District bounds, so the renderer and the sidebar both read them from
        # here instead of keeping their own copies that drift.
        "districts": [
            {"name": n, "x0": x0, "y0": y0, "x1": x1, "y1": y1}
            for n, x0, y0, x1, y1 in DISTRICTS
        ],
        "masses": MASSES,
        "names": NAMES,
    }
    (HERE / "authored.json").write_text(json.dumps(out))
    free = sum(1 for x in range(W) for y in range(H) if not solid[x][y])
    print(f"  fenced {fenced} tiles inside the words, sealed {sealed} stranded")
    print(f"authored {W}x{H} tiles ({W*TILE}x{H*TILE} px)")
    print(f"  {len(bs)} blocks, {len(placed)} named campuses")
    print(f"  walkable {free} tiles ({free/(W*H):.0%})")


# --- procedural atlas -------------------------------------------------------
def make_atlas():
    """Flat-shaded blockout tiles. Deliberately plain: this is structure, not art."""
    img = Image.new("RGBA", (ATLAS_COLS * TILE, ATLAS_ROWS * TILE), (0, 0, 0, 0))
    px = img.load()
    base = {
        "grass": (104, 142, 84), "grass_dry": (124, 152, 88),
        "asphalt": (74, 76, 82), "lane_h": (74, 76, 82), "lane_v": (74, 76, 82),
        "crosswalk_h": (74, 76, 82), "crosswalk_v": (74, 76, 82),
        "sidewalk": (168, 166, 158), "lot": (88, 90, 96), "lot_stripe": (88, 90, 96),
        "roof_brick": (141, 90, 73), "roof_rust": (124, 82, 62),
        "roof_pale": (198, 198, 192), "roof_slate": (120, 128, 142),
        "roof_sand": (196, 176, 142), "glass": (126, 180, 200),
        "solar": (44, 52, 76), "tree": (58, 96, 58), "hedge": (72, 108, 66),
        "water": (78, 132, 164), "plaza": (176, 170, 160), "roof_edge": (96, 98, 104),
        "collide": (0, 0, 0), "roof_white": (222, 222, 218),
        "roof_teal": (108, 154, 150), "roof_red": (176, 108, 96),
    }
    for name, i in T.items():
        ox, oy = (i % ATLAS_COLS) * TILE, (i // ATLAS_COLS) * TILE
        r, g, b = base[name]
        for x in range(TILE):
            for y in range(TILE):
                if name == "collide":
                    px[ox + x, oy + y] = (0, 0, 0, 1 if (x == 0 and y == 0) else 0)
                    continue
                n = rng.randint(-6, 6)           # dither so flats aren't dead
                px[ox + x, oy + y] = (max(0, min(255, r + n)),
                                      max(0, min(255, g + n)),
                                      max(0, min(255, b + n)), 255)
        # Overlays that make the blockout legible at a glance.
        if name == "lane_h":
            for x in range(6, 26):
                for y in (15, 16):
                    px[ox + x, oy + y] = (226, 216, 140, 255)
        elif name == "lane_v":
            for y in range(6, 26):
                for x in (15, 16):
                    px[ox + x, oy + y] = (226, 216, 140, 255)
        elif name in ("crosswalk_h", "crosswalk_v"):
            for k in range(2, 30, 7):
                for d in range(4):
                    for e in range(TILE):
                        a, bb = (k + d, e) if name == "crosswalk_v" else (e, k + d)
                        px[ox + a, oy + bb] = (216, 216, 210, 255)
        elif name == "lot_stripe":
            for y in range(4, 28):
                px[ox + 1, oy + y] = (210, 208, 190, 255)
        elif name == "solar":
            for x in range(2, 30):
                for y in range(2, 30):
                    if (x - 2) % 7 in (0, 1) or (y - 2) % 7 in (0, 1):
                        px[ox + x, oy + y] = (70, 82, 112, 255)
        elif name == "tree":
            for x in range(TILE):
                for y in range(TILE):
                    dx, dy = x - 15.5, y - 15.5
                    d = (dx * dx + dy * dy) ** 0.5
                    if d < 13:
                        sh = 22 if d > 10 else 0
                        px[ox + x, oy + y] = (58 - sh // 2, 96 - sh, 58 - sh // 2, 255)
                    else:
                        px[ox + x, oy + y] = (0, 0, 0, 0)
        elif name == "glass":
            for x in range(TILE):
                for y in range(TILE):
                    if (x + y) % 9 < 2:
                        px[ox + x, oy + y] = (162, 208, 224, 255)
        elif name == "roof_edge":
            for x in range(TILE):
                for y in range(TILE):
                    px[ox + x, oy + y] = (78, 80, 86, 255)
    img.save(REPO / "public" / "assets" / "siliconville.png")


if __name__ == "__main__":
    main()
