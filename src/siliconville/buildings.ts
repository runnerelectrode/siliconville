// Building silhouettes, signage and landmarks for /siliconville.
//
// Split out of the viewer because this is the part that decides whether the
// city reads as a valley or as a business park in Ohio. A grid of identical
// boxes is the failure mode, and no amount of lighting rescues it -- the fix
// is in the MASSING: a ring campus, towers with setbacks, terraced low-rise,
// open parking decks.
//
// These are individual meshes, not instances. There are ~23 buildings; at that
// count draw calls are free and per-building geometry is worth far more than
// the batching. Trees, cars and ground stay instanced, where the counts are in
// the hundreds or thousands.

import * as THREE from 'three';
import {
  siAnthropic, siCloudflare, siDeepmind, siGithubcopilot, siHuggingface, siMetaai,
  siMistralai, siNvidia, siPerplexity, siX, siYcombinator,
} from 'simple-icons';

// Official brand glyphs, as path data with the brand's own hex, from the
// simple-icons package. Drawing the real outline beats approximating it with
// circles and bars, and it comes with the correct colour rather than my guess.
//
// OpenAI and Microsoft are deliberately absent from that package at the
// owners' request, so those two keep hand-drawn marks below. Anything with no
// icon anywhere — a16z, Philz, Stanford, Khosla, Pied Piper — does too.
const ICONS: Record<string, { path: string; hex: string }> = {
  Anthropic: siAnthropic,
  Cloudflare: siCloudflare,
  'Google DeepMind': siDeepmind,
  'Microsoft Copilot': siGithubcopilot,
  'Hugging Face': siHuggingface,
  'Meta AI': siMetaai,
  Mistral: siMistralai,
  NVIDIA: siNvidia,
  Perplexity: siPerplexity,
  xAI: siX,
  'Y Combinator': siYcombinator,
};

export type Door = { x: number; y: number; side: 'N' | 'S' | 'E' | 'W' };
export type Room = { id: string; floor: number; kind: string; capacity: number };

export type Mass = {
  x: number; y: number; w: number; h: number;
  floors: number; color: string; style: string; name: string | null;
  // Affordances the simulation needs. A building an agent can enter has to
  // name a tile to walk to and rooms to be inside of; without both, "go to a
  // meeting" has nowhere to resolve to.
  door: Door | null;
  rooms: Room[];
  // Bands of road passing clean through this footprint, as [axis, from, to]
  // in local tile units. The building bridges them on an archway.
  arches?: [string, number, number][];
};

export const FLOOR_H = 1.6;

// Stacked masses OVERLAP by this much instead of meeting exactly.
//
// A tier whose base sits precisely on the top of the tier below makes those
// two faces coplanar, and coplanar faces have equal depth: the GPU has no
// consistent way to order them, so which one wins flips per pixel and per
// frame as the camera moves. That is the flutter — it is z-fighting, not
// shadow acne, and no bias tuning fixes it because the depths are genuinely
// identical. Intersecting solids have no such tie, so sinking each element a
// hair into the one below removes the ambiguity entirely.
const OVERLAP = 0.06;

const lam = (hex: THREE.ColorRepresentation) =>
  typeof hex === 'number' ? lamShared(hex) : new THREE.MeshLambertMaterial({ color: hex });

/**
 * Facade with window banding, drawn to a canvas and tiled.
 *
 * This is the difference between "boxes" and "buildings". A flat-coloured box
 * has no scale cues, so a 3-storey office and a 12-storey tower read as the
 * same object at different sizes; window rows tell the eye how tall it is.
 *
 * Cached by colour+floors — 23 buildings share a handful of combinations, and
 * a canvas per mesh is a waste of texture memory for identical pixels.
 */
const facadeCache = new Map<string, THREE.Texture>();
function facadeTexture(hex: string): THREE.Texture {
  const hit = facadeCache.get(hex);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = hex;
  g.fillRect(0, 0, 64, 64);
  const glass = new THREE.Color(hex).offsetHSL(0, 0.05, -0.34);
  g.fillStyle = `#${glass.getHexString()}`;
  for (let r = 0; r < 4; r++) g.fillRect(3, r * 16 + 5, 58, 8);
  // Mullions in the wall colour, punched back through the glazing band.
  g.fillStyle = hex;
  for (let x = 3; x < 62; x += 8) g.fillRect(x, 0, 2, 64);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 16;   // window rows minify hard at distance and shimmer without it
  facadeCache.set(hex, t);
  return t;
}

/**
 * Wall material whose window rows line up with the building's storeys.
 *
 * CACHED by colour and repeat. Every building used to clone its own texture and
 * material, so no two buildings could ever share one — which is the same thing
 * as saying nothing could be batched. There are only a handful of distinct
 * (colour, repeat) pairs across two hundred buildings.
 */
const facadeMats = new Map<string, THREE.MeshLambertMaterial>();
function facade(hex: string, w: number, hgt: number) {
  // Quantised to a short ladder of repeats. Keying on the exact value gave a
  // distinct material for almost every building width, and two buildings with
  // different materials can never share a draw call — 661 buckets for 209
  // buildings. Snapping to the nearest rung costs nothing visible and collapses
  // them to a couple of dozen.
  const snap = (v: number, rungs: number[]) =>
    rungs.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
  const rx = snap(Math.max(1, w / 4), [1, 2, 3, 4, 6, 8]);
  const ry = snap(Math.max(1, hgt / FLOOR_H / 4), [1, 2, 3]);
  const key = `${hex}|${rx}|${ry}`;
  const hit = facadeMats.get(key);
  if (hit) return hit;
  const tex = facadeTexture(hex).clone();
  tex.needsUpdate = true;
  tex.repeat.set(rx, ry);
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  facadeMats.set(key, mat);
  return mat;
}

/**
 * Glass, shared. This was a fresh MeshPhongMaterial inside every buildMass
 * call — two hundred identical materials, each of which forced its own draw
 * call and blocked its mesh from batching with any other. It was the single
 * largest source of the 661 material buckets.
 */
export const GLASS = new THREE.MeshPhongMaterial({ color: 0x8fb6cc, shininess: 80 });
const GLAZING = new THREE.MeshPhongMaterial({ color: 0x9ec4d6, shininess: 70 });

/** Solid colours, shared. Same reasoning as the facade cache. */
const lamCache = new Map<number, THREE.MeshLambertMaterial>();
function lamShared(hex: number) {
  const hit = lamCache.get(hex);
  if (hit) return hit;
  const m = new THREE.MeshLambertMaterial({ color: hex });
  lamCache.set(hex, m);
  return m;
}

/** Flat-roof panelling: seams and a scatter of vents. */
let _roofPanel: THREE.Texture | null = null;
function roofPanelTexture(): THREE.Texture {
  if (_roofPanel) return _roofPanel.clone();
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#c3c3bd';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(120,120,114,0.55)';
  g.lineWidth = 2;
  for (let k = 0; k <= 128; k += 32) {
    g.beginPath(); g.moveTo(k, 0); g.lineTo(k, 128); g.stroke();
    g.beginPath(); g.moveTo(0, k); g.lineTo(128, k); g.stroke();
  }
  g.fillStyle = 'rgba(150,150,144,0.75)';
  for (const [x, y, w, h] of [[38, 20, 22, 12], [80, 66, 16, 18], [16, 90, 26, 10]]) {
    g.fillRect(x, y, w, h);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 16;
  _roofPanel = t;
  return t.clone();
}

function shade(hex: string, amount: number) {
  // Returned as a NUMBER so it hits the shared-material cache; a Color
  // instance is a fresh object every call and would defeat it.
  return new THREE.Color(hex).offsetHSL(0, 0, amount).getHex();
}

/** A box whose BASE sits at y, not whose centre does — every mass wants this. */
function slab(
  w: number, hgt: number, d: number, y: number, mat: THREE.Material | THREE.Material[],
) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, d), mat);
  m.position.y = y + hgt / 2;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/**
 * One building, centred on the origin in X/Z with its base at y=0.
 * The caller positions it; this only decides what it looks like.
 */
export function buildMass(m: Mass): THREE.Group {
  const g = new THREE.Group();
  const total = m.floors * FLOOR_H;
  const wallMat = facade(m.color, Math.max(m.w, m.h), total);
  const roofMat = lam(shade(m.color, -0.05));
  // ONE material per mesh, not a six-entry array.
  //
  // The array existed to keep window rows off the roof, and it worked — but a
  // multi-material mesh cannot be batched with anything, and 2,245 unbatchable
  // meshes were costing 2,940 draw calls a frame. The roof is a separate quad
  // laid on top instead, which reads identically and leaves every mesh
  // single-material and mergeable.
  const body = wallMat;
  const trim = lam(shade(m.color, -0.17));
  const glass = GLASS;

  switch (m.style) {
    // A doughnut campus. The single most recognisable building in the valley,
    // and the one shape that stops the skyline reading as a warehouse park.
    case 'ring': {
      const outer = Math.min(m.w, m.h) / 2;
      const inner = outer * 0.62;
      // FOUR ARCS, not one annulus: the gaps are the entrances.
      //
      // The generator leaves the four axes walkable so the pathfinder can get
      // agents into the courtyard; drawing an unbroken ring over that would
      // show them walking through a wall. The geometry has to agree with the
      // collision map, and the collision map is the one that decides.
      const GAP = 0.34;   // radians either side of each axis, matching the map
      for (let k = 0; k < 4; k++) {
        const a0 = k * (Math.PI / 2) + GAP;
        const a1 = (k + 1) * (Math.PI / 2) - GAP;
        const shape = new THREE.Shape();
        shape.absarc(0, 0, outer, a0, a1, false);
        shape.absarc(0, 0, inner, a1, a0, true);
        const geo = new THREE.ExtrudeGeometry(shape, {
          depth: total, bevelEnabled: false, curveSegments: 24,
        });
        // Extrude runs along +z; rotate so it runs up. Skipping this lays the
        // whole thing flat on the ground, which looks like a plaza.
        geo.rotateX(-Math.PI / 2);
        const arc = new THREE.Mesh(geo, [roofMat, wallMat]);
        arc.castShadow = true;
        arc.receiveShadow = true;
        g.add(arc);
      }
      // Glazed top band, and a landscaped courtyard in the hole.
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(outer * 0.995, outer * 0.995, 0.5, 64, 1, true), glass);
      band.position.y = total - 0.9;
      g.add(band);
      const yard = new THREE.Mesh(
        new THREE.CylinderGeometry(inner, inner, 0.1, 48), lam(0x6f8d54));
      yard.position.y = 0.12;
      yard.receiveShadow = true;
      g.add(yard);
      break;
    }

    // Stepped setbacks. Cheap, and it is what makes a tall box read as a tower
    // rather than as an extruded rectangle.
    case 'tower': {
      const tiers = 3;
      for (let i = 0; i < tiers; i++) {
        const k = 1 - i * 0.22;
        const hgt = total / tiers;
        const base = i * hgt - (i ? OVERLAP : 0);
        g.add(slab(m.w * k, hgt + (i ? OVERLAP : 0), m.h * k, base,
          i === tiers - 1 ? trim : body));
      }
      const core = slab(m.w * 0.3, 1.2, m.h * 0.3, total - OVERLAP, trim);
      g.add(core);
      break;
    }

    // Wide low-rise wedding cake — the valley's actual dominant typology.
    case 'terrace': {
      const tiers = 2 + (m.floors > 3 ? 1 : 0);
      for (let i = 0; i < tiers; i++) {
        const k = 1 - i * 0.18;
        const hgt = total / tiers;
        g.add(slab(m.w * k, hgt + (i ? OVERLAP : 0), m.h * k,
          i * hgt - (i ? OVERLAP : 0), body));
        if (i < tiers - 1) {
          // Parapet lip on each terrace: catches the sun and reads as a floor
          // line rather than a seam between two boxes.
          g.add(slab(m.w * k + 0.3, 0.24, m.h * k + 0.3, (i + 1) * hgt - 0.18, trim));
        }
      }
      break;
    }

    // Open decks with columns — you can see through it, which is the tell.
    case 'garage': {
      const decks = Math.max(3, m.floors);
      const dh = total / decks;
      for (let i = 0; i < decks; i++) {
        g.add(slab(m.w, 0.3, m.h, i * dh - (i ? OVERLAP : 0), i === 0 ? body : trim));
      }
      const cols = lam(shade(m.color, -0.24));
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const c = slab(0.5, total, 0.5, 0, cols);
          c.position.x = (sx * (m.w - 0.6)) / 2;
          c.position.z = (sz * (m.h - 0.6)) / 2;
          g.add(c);
        }
      }
      // Solid stair core so it does not read as a floating stack of trays.
      const core = slab(1.6, total, m.h * 0.5, 0, wallMat);
      core.position.x = -m.w / 2 + 0.9;
      g.add(core);
      break;
    }

    // Transamerica in silhouette: square plan tapering to a spire, with the
    // two buttress wings that stop it reading as a traffic cone.
    case 'pyramid': {
      const base = Math.min(m.w, m.h);
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(base * 0.14, base * 0.62, total, 4), wallMat);
      shaft.rotation.y = Math.PI / 4;   // faces square to the grid, not corners
      shaft.position.y = total / 2;
      shaft.castShadow = true;
      shaft.receiveShadow = true;
      g.add(shaft);
      for (const sx of [-1, 1]) {
        const wing = slab(base * 0.16, total * 0.42, base * 0.3, total * 0.1, roofMat);
        wing.position.x = sx * base * 0.26;
        g.add(wing);
      }
      const spire = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.05, 2.2, 5), roofMat);
      spire.position.y = total + 1.1;
      g.add(spire);
      break;
    }

    // Dogpatch shed: brick box under a sawtooth roof. The sawtooth is the
    // giveaway — north-light glazing is what says "industrial" from above.
    case 'warehouse': {
      const hgt = Math.max(2.2, total);
      g.add(slab(m.w, hgt, m.h, 0, body));
      const teeth = Math.max(2, Math.floor(m.h / 2.5));
      const tw = m.h / teeth;
      for (let i = 0; i < teeth; i++) {
        const z = -m.h / 2 + tw * (i + 0.5);
        const ridge = new THREE.Mesh(
          new THREE.BoxGeometry(m.w * 0.98, 0.7, tw * 0.55), roofMat);
        ridge.position.set(0, hgt + 0.3, z - tw * 0.15);
        ridge.castShadow = true;
        g.add(ridge);
        const glazing = new THREE.Mesh(
          new THREE.BoxGeometry(m.w * 0.94, 0.62, 0.16),
          GLAZING,
        );
        glazing.position.set(0, hgt + 0.34, z + tw * 0.14);
        g.add(glazing);
      }
      break;
    }

    // The sign mesa: a plain box with a dead-flat roof and NO parapet cap.
    // The cap on a normal slab stands 0.28 proud of the nominal roof height,
    // and the letters are placed at that height — with a cap they sink into
    // it near the middle and float at the edges.
    // A letter STROKE, built as a building: ordinary windowed facade below,
    // the red letter mass on top with a slight overhang for the bevel. This is
    // what the reference actually does — the massing spells the word. A banner
    // laid over a roof reads as a decal no matter how it is sized.
    case 'letter': {
      const skirt = total * 0.62;
      const wallM = facade('#c9c9c3', Math.max(m.w, m.h), skirt);
      const arches = m.arches ?? [];

      if (!arches.length) {
        g.add(slab(m.w, skirt, m.h, 0, wallM));
      } else {
        // Mark the tiles a road runs through, then build the skirt out of the
        // runs BETWEEN them, with a lintel carrying the wall over the gap.
        // Without this the roads dead-ended into a wall and the cars drove
        // straight through it.
        const ARCH_H = 3.6;                       // clearance over the roadway
        const blocked: boolean[][] = Array.from(
          { length: m.w }, () => new Array(m.h).fill(false));
        for (const [axis, a0, a1] of arches) {
          for (let k = a0; k < a1; k++) {
            if (axis === 'x') {
              for (let j = 0; j < m.h; j++) if (k < m.w) blocked[k][j] = true;
            } else {
              for (let j = 0; j < m.w; j++) if (k < m.h) blocked[j][k] = true;
            }
          }
        }
        // Almost every crossing is a road band spanning the full depth, so the
        // blocked pattern is the same in every row. Detect that and emit one
        // full-depth box per run instead of one per row — it halves the mesh
        // count on 94 buildings, and the scene is already thousands of meshes.
        const uniform = blocked.every((cols) => cols.every((v) => v === cols[0]));
        const rows: [number, number][] = uniform ? [[0, m.h]] : [];
        if (!uniform) for (let j = 0; j < m.h; j++) rows.push([j, 1]);
        for (const [j0, depth] of rows) {
          let k = 0;
          while (k < m.w) {
            if (blocked[k][j0]) {
              k++;
              continue;
            }
            let run = 0;
            while (k + run < m.w && !blocked[k + run][j0]) run++;
            const pier = slab(run, skirt, depth, 0, wallM);
            pier.position.set(
              -m.w / 2 + k + run / 2, pier.position.y, -m.h / 2 + j0 + depth / 2);
            g.add(pier);
            k += run;
          }
        }
        // Lintel over each opening: the wall continues above the arch, so the
        // letter still reads as one solid mass from above.
        for (const [j0, depth] of rows) {
          let k = 0;
          while (k < m.w) {
            if (!blocked[k][j0]) {
              k++;
              continue;
            }
            let run = 0;
            while (k + run < m.w && blocked[k + run][j0]) run++;
            const lintel = slab(run, skirt - ARCH_H, depth, ARCH_H, wallM);
            lintel.position.set(
              -m.w / 2 + k + run / 2, lintel.position.y, -m.h / 2 + j0 + depth / 2);
            g.add(lintel);
            k += run;
          }
        }
      }
      // No red cap here. The letter's red form is extruded ONCE per word from
      // the font's real outline (see letterOutlines) and laid over all of
      // these at skirt height. Capping each box individually is what produced
      // the staircase: a grid of boxes can only approximate a curve.
      break;
    }

    case 'mesa': {
      // Roof gets panel lines. A roof this large in flat colour reads as a
      // concrete apron, and the letters look pasted onto it rather than
      // standing on a building.
      const rp = roofPanelTexture();
      rp.repeat.set(Math.round(m.w / 6), Math.round(m.h / 6));
      const panelled = new THREE.MeshLambertMaterial({ map: rp });
      g.add(slab(m.w, total, m.h, 0, wallMat));
      const top = new THREE.Mesh(new THREE.PlaneGeometry(m.w, m.h), panelled);
      top.rotation.x = -Math.PI / 2;
      top.position.y = total + 0.02;
      top.receiveShadow = true;
      g.add(top);
      break;
    }

    default: {
      g.add(slab(m.w, total, m.h, 0, body));
      g.add(slab(m.w * 0.97, 0.34, m.h * 0.97, total - OVERLAP, trim));
      // A glazed slot down the long face breaks up the blank wall.
      const long = m.w >= m.h;
      const win = new THREE.Mesh(
        new THREE.BoxGeometry(long ? m.w * 0.82 : 0.12, total * 0.5, long ? 0.12 : m.h * 0.82),
        glass,
      );
      win.position.set(long ? 0 : m.w / 2, total * 0.5, long ? m.h / 2 : 0);
      g.add(win);
      break;
    }
  }
  // How much of the base footprint the top tier still covers. Tapered masses
  // shrink as they rise, so the roof quad has to match the tier it sits on.
  const TOP_SCALE: Record<string, number> = {
    tower: 1 - 2 * 0.22, terrace: 1 - 2 * 0.18, garage: 1, slab: 0.97,
  };

  // No rooftop plant anywhere. It was there to give roofs scale, but from a
  // fixed isometric angle the roof is the most visible surface on every
  // building, and scattering grey boxes over all of them added noise to the
  // one plane that reads cleanly — including straight over Y Combinator's
  // logo. Scale comes from the window banding instead.

  // Roof quad, replacing what the per-face material array used to do. Skipped
  // for the shapes that have no flat top or already own one: letters are
  // capped by the extruded red form, garages by their own top deck.
  if (!['letter', 'garage', 'crane', 'pyramid', 'ring'].includes(m.style)) {
    const k = TOP_SCALE[m.style] ?? 0.97;
    const cap = new THREE.Mesh(new THREE.PlaneGeometry(m.w * k, m.h * k), roofMat);
    cap.rotation.x = -Math.PI / 2;
    cap.position.y = total + 0.02;
    cap.receiveShadow = true;
    g.add(cap);
  }
  return g;
}


/**
 * Simplified brand marks, drawn with canvas primitives.
 *
 * These are approximations built from circles, bars and strokes — enough to be
 * recognisable at the size a rooftop hoarding occupies on screen, which is
 * maybe forty pixels. They are not traced from anyone's artwork.
 */
function drawMark(g: CanvasRenderingContext2D, name: string, cx: number, cy: number, r: number) {
  const icon = ICONS[name];
  if (icon && typeof Path2D !== 'undefined') {
    // simple-icons paths are drawn in a 24x24 box; scale that onto the mark's
    // diameter and centre it.
    g.save();
    g.translate(cx - r, cy - r);
    g.scale((r * 2) / 24, (r * 2) / 24);
    g.fillStyle = `#${icon.hex}`;
    g.fill(new Path2D(icon.path));
    g.restore();
    return;
  }
  g.save();
  g.translate(cx, cy);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  switch (name) {
    case 'OpenAI': {
      // Interlocking hexagonal knot: three rotated hex outlines.
      g.strokeStyle = '#10a37f';
      g.lineWidth = r * 0.22;
      for (let k = 0; k < 3; k++) {
        g.save();
        g.rotate((k * Math.PI * 2) / 3);
        g.beginPath();
        for (let i = 0; i <= 6; i++) {
          const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
          const x = Math.cos(a) * r * 0.78;
          const y = Math.sin(a) * r * 0.5;
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
        g.restore();
      }
      break;
    }
    case 'Anthropic': {
      // Three tapered strokes radiating from the centre.
      g.fillStyle = '#d97757';
      for (let k = 0; k < 3; k++) {
        g.save();
        g.rotate((k * Math.PI * 2) / 3 + Math.PI / 6);
        g.beginPath();
        g.moveTo(-r * 0.2, 0);
        g.lineTo(r * 0.2, 0);
        g.lineTo(r * 0.06, -r * 0.95);
        g.lineTo(-r * 0.06, -r * 0.95);
        g.closePath();
        g.fill();
        g.restore();
      }
      break;
    }
    case 'NVIDIA': {
      // The eye: a thick arc closing on itself.
      g.strokeStyle = '#76b900';
      g.lineWidth = r * 0.3;
      g.beginPath();
      g.arc(0, 0, r * 0.62, Math.PI * 0.15, Math.PI * 1.55);
      g.stroke();
      g.beginPath();
      g.arc(r * 0.1, 0, r * 0.26, 0, Math.PI * 2);
      g.stroke();
      break;
    }
    case 'Google DeepMind': {
      g.strokeStyle = '#4285f4';
      g.lineWidth = r * 0.26;
      g.beginPath();
      g.arc(0, 0, r * 0.68, Math.PI * 0.25, Math.PI * 1.85);
      g.stroke();
      g.fillStyle = '#4285f4';
      g.beginPath();
      g.arc(0, 0, r * 0.2, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'Meta AI': {
      // Lemniscate: two arcs meeting in the middle.
      g.strokeStyle = '#0064e0';
      g.lineWidth = r * 0.26;
      for (const sx of [-1, 1]) {
        g.beginPath();
        g.arc(sx * r * 0.4, 0, r * 0.42, 0, Math.PI * 2);
        g.stroke();
      }
      break;
    }
    case 'Microsoft Copilot': {
      const q = r * 0.62;
      const cols = ['#f25022', '#7fba00', '#00a4ef', '#ffb900'];
      cols.forEach((c, i) => {
        g.fillStyle = c;
        g.fillRect(((i % 2) - 1) * q * 1.06, (Math.floor(i / 2) - 1) * q * 1.06, q, q);
      });
      break;
    }
    case 'Perplexity': {
      g.strokeStyle = '#20808d';
      g.lineWidth = r * 0.2;
      for (const k of [0.85, 0.5]) {
        g.strokeRect(-r * k, -r * k * 0.8, r * k * 2, r * k * 1.6);
      }
      g.beginPath();
      g.moveTo(0, -r * 0.95);
      g.lineTo(0, r * 0.95);
      g.stroke();
      break;
    }
    case 'Hugging Face': {
      g.font = `${Math.round(r * 1.9)}px system-ui, "Apple Color Emoji", sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('\u{1F917}', 0, r * 0.06);
      break;
    }
    case 'xAI': {
      g.strokeStyle = '#111318';
      g.lineWidth = r * 0.3;
      g.beginPath();
      g.moveTo(-r * 0.7, -r * 0.7);
      g.lineTo(r * 0.7, r * 0.7);
      g.moveTo(r * 0.7, -r * 0.7);
      g.lineTo(-r * 0.7, r * 0.7);
      g.stroke();
      break;
    }
    case 'a16z': {
      g.fillStyle = '#12141a';
      g.beginPath();
      (g as any).roundRect ? (g as any).roundRect(-r, -r * 0.75, r * 2, r * 1.5, r * 0.28)
        : g.rect(-r, -r * 0.75, r * 2, r * 1.5);
      g.fill();
      g.fillStyle = '#ffffff';
      g.font = `800 ${Math.round(r * 0.92)}px Inter, Arial, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('a16z', 0, r * 0.04);
      break;
    }
    case 'Cloudflare': {
      // Cloud with the sun-streak behind it.
      g.fillStyle = '#fbad41';
      g.beginPath();
      g.arc(r * 0.42, -r * 0.18, r * 0.42, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#f6821f';
      g.beginPath();
      g.arc(-r * 0.34, r * 0.06, r * 0.4, Math.PI, 0);
      g.arc(r * 0.16, r * 0.02, r * 0.5, Math.PI, 0);
      g.rect(-r * 0.74, r * 0.02, r * 1.5, r * 0.42);
      g.fill();
      break;
    }
    case 'Y Combinator': {
      g.fillStyle = '#ff6600';
      g.fillRect(-r * 0.86, -r * 0.86, r * 1.72, r * 1.72);
      g.strokeStyle = '#ffffff';
      g.lineWidth = r * 0.17;
      g.beginPath();
      g.moveTo(-r * 0.34, -r * 0.42);
      g.lineTo(0, r * 0.02);
      g.lineTo(r * 0.34, -r * 0.42);
      g.moveTo(0, r * 0.02);
      g.lineTo(0, r * 0.5);
      g.stroke();
      break;
    }
    case 'Philz Coffee': {
      // Cup and saucer.
      g.fillStyle = '#1f7a4d';
      g.beginPath();
      g.moveTo(-r * 0.52, -r * 0.4);
      g.lineTo(r * 0.42, -r * 0.4);
      g.lineTo(r * 0.28, r * 0.42);
      g.lineTo(-r * 0.38, r * 0.42);
      g.closePath();
      g.fill();
      g.strokeStyle = '#1f7a4d';
      g.lineWidth = r * 0.15;
      g.beginPath();
      g.arc(r * 0.5, -r * 0.05, r * 0.26, -Math.PI / 2, Math.PI / 2);
      g.stroke();
      g.fillRect(-r * 0.7, r * 0.5, r * 1.5, r * 0.16);
      break;
    }
    case 'Stanford R&D': {
      g.fillStyle = '#8c1515';
      g.beginPath();
      g.moveTo(0, -r * 0.95);
      g.lineTo(r * 0.4, r * 0.3);
      g.lineTo(-r * 0.4, r * 0.3);
      g.closePath();
      g.fill();
      g.fillRect(-r * 0.1, r * 0.24, r * 0.2, r * 0.6);
      break;
    }
    case 'Khosla Ventures': {
      g.fillStyle = '#1b4f8a';
      g.font = `800 ${Math.round(r * 1.15)}px Inter, Arial, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('KV', 0, r * 0.05);
      break;
    }
    case 'Pied Piper': {
      g.fillStyle = '#2f6fb5';
      g.beginPath();
      g.arc(0, 0, r * 0.85, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffffff';
      g.font = `800 ${Math.round(r * 1.0)}px Inter, Arial, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('PP', 0, r * 0.05);
      break;
    }
    case "Zareen's": {
      // The heart. Their wordmark is otherwise plain lowercase type, and at
      // forty pixels the only part with any shape to it is the heart over the
      // apostrophe — so the heart IS the mark here.
      g.fillStyle = '#e2342a';
      g.beginPath();
      const t = -r * 0.55;
      g.moveTo(0, r * 0.75);
      g.bezierCurveTo(-r * 1.15, -r * 0.1, -r * 0.62, t - r * 0.42, 0, t * 0.55);
      g.bezierCurveTo(r * 0.62, t - r * 0.42, r * 1.15, -r * 0.1, 0, r * 0.75);
      g.closePath();
      g.fill();
      break;
    }
    case 'Mistral': {
      // Banded grid, warm at the bottom.
      const bands = ['#ffd800', '#ffaf00', '#ff8205', '#fa500f', '#e10500'];
      const q = (r * 1.7) / 5;
      bands.forEach((c, row) => {
        g.fillStyle = c;
        for (let col = 0; col < 5; col++) {
          if ((row === 0 && (col === 1 || col === 3)) || (row === 1 && col === 2)) continue;
          g.fillRect(-r * 0.85 + col * q, -r * 0.85 + row * q, q * 0.92, q * 0.92);
        }
      });
      break;
    }
    default:
      break;
  }
  g.restore();
}

export const BRAND_NAMES = [
  'OpenAI', 'Anthropic', 'NVIDIA', 'Google DeepMind', 'Meta AI',
  'Microsoft Copilot', 'Perplexity', 'Hugging Face', 'xAI', 'Mistral',
];

/** Text drawn to a canvas — the cheapest legible signage without a font file. */
export function signTexture(
  text: string, color = '#1b1b1f', bg = 'transparent', withMark = false,
) {
  const pad = 8;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  // Tall glyphs relative to the canvas: the text was 96px on a 256px sheet,
  // so two thirds of every signboard was empty margin and the word was
  // illegible once the object got small on screen.
  // 900, and tight. Signs are read at forty pixels; a lighter weight loses
  // its strokes entirely at that size.
  const font = `900 150px Inter, Helvetica, Arial, sans-serif`;
  ctx.font = font;
  const markW = withMark ? 210 : 0;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2 + markW;
  c.width = THREE.MathUtils.ceilPowerOfTwo(w);
  c.height = 168;
  const g2 = c.getContext('2d')!;
  if (bg !== 'transparent') {
    g2.fillStyle = bg;
    g2.fillRect(0, 0, c.width, c.height);
  }
  g2.font = font;
  g2.fillStyle = color;
  g2.textBaseline = 'middle';
  if (withMark) {
    drawMark(g2, text, 108, c.height / 2, 62);
    g2.textAlign = 'left';
    g2.fillText(text, 202, c.height / 2 + 4);
  } else {
    g2.textAlign = 'center';
    g2.fillText(text, c.width / 2, c.height / 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return { tex, aspect: c.width / c.height };
}

/** Company wordmark lying flat on a roof, like the reference's rooftop logos. */
export function roofSign(name: string, mass: Mass, topY: number) {
  const { tex, aspect } = signTexture(name, '#1b1b1f', 'transparent', true);
  const wide = Math.min(mass.w, mass.h) >= mass.w * 0.6;
  const w = Math.min(mass.w, mass.h) * (wide ? 0.8 : 0.9);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, w / aspect),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  // Align the text with the building's long axis, or it hangs off the edge.
  if (mass.h > mass.w) mesh.rotation.z = Math.PI / 2;
  mesh.position.y = topY + 0.06;
  return mesh;
}

/**
 * The hillside SILICON VALLEY sign.
 *
 * Standing letters, not a decal: it has to catch the light and cast a shadow
 * or it reads as paint. Built from canvas-textured planes because 3D text
 * needs a typeface JSON this project does not ship.
 */
export function valleySign() {
  const g = new THREE.Group();
  ['SILICON', 'VALLEY'].forEach((word, row) => {
    const { tex, aspect } = signTexture(word, '#e5402c');
    const h = 5.5;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(h * aspect, h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }),
    );
    mesh.position.set(row * 2.4, h * (1.55 - row * 1.02), -row * 1.4);
    g.add(mesh);
    // A thin backing slab so the letters read as solid from a shallow angle.
    const back = new THREE.Mesh(
      new THREE.BoxGeometry(h * aspect * 0.98, h * 0.72, 0.35),
      new THREE.MeshLambertMaterial({ color: 0xa72a21 }),
    );
    back.position.copy(mesh.position);
    back.position.z -= 0.3;
    back.castShadow = true;
    g.add(back);
  });
  return g;
}

/**
 * Golden Gate — two towers, a slung deck, main cables and suspenders.
 *
 * The catenary is sampled from an actual cosh curve rather than eyeballed with
 * a parabola; at this span the difference is visible where the cable meets the
 * tower, which is exactly where the eye checks whether a bridge looks right.
 */
export function goldenGate(span: number, deckY = 3.2) {
  const g = new THREE.Group();
  const RED = 0xc0442e;
  const steel = new THREE.MeshLambertMaterial({ color: RED });

  const towerH = 15;
  const towerX = [-span * 0.28, span * 0.28];

  // Deck.
  const deck = new THREE.Mesh(new THREE.BoxGeometry(span, 0.5, 5.5), steel);
  deck.position.y = deckY;
  deck.castShadow = true;
  deck.receiveShadow = true;
  g.add(deck);
  const road = new THREE.Mesh(
    new THREE.BoxGeometry(span, 0.12, 4.4), new THREE.MeshLambertMaterial({ color: 0x3b3d42 }));
  road.position.y = deckY + 0.3;
  g.add(road);

  // Towers: two legs and two cross-braces each.
  for (const tx of towerX) {
    for (const tz of [-2.1, 2.1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(1.5, towerH, 1.5), steel);
      leg.position.set(tx, deckY - 2 + towerH / 2, tz);
      leg.castShadow = true;
      g.add(leg);
    }
    for (const by of [towerH * 0.52, towerH * 0.86]) {
      const brace = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.0, 5.2), steel);
      brace.position.set(tx, deckY - 2 + by, 0);
      brace.castShadow = true;
      g.add(brace);
    }
  }

  // Main cables, as a catenary between tower tops dipping to the deck.
  const topY = deckY - 2 + towerH;
  const a = 26; // catenary tightness
  const cableY = (x: number) => {
    const t = (x - towerX[0]) / (towerX[1] - towerX[0]) - 0.5; // -0.5..0.5
    const u = t * (towerX[1] - towerX[0]);
    return topY - (a * Math.cosh((towerX[1] - towerX[0]) / 2 / a) - a * Math.cosh(u / a));
  };
  for (const cz of [-2.1, 2.1]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 60; i++) {
      const x = towerX[0] + ((towerX[1] - towerX[0]) * i) / 60;
      pts.push(new THREE.Vector3(x, cableY(x), cz));
    }
    // Sidespans run from each tower top down to the abutments.
    const left = [new THREE.Vector3(-span / 2, deckY + 1, cz), pts[0].clone()];
    const right = [pts[pts.length - 1].clone(), new THREE.Vector3(span / 2, deckY + 1, cz)];
    for (const set of [left, pts, right]) {
      const curve = new THREE.CatmullRomCurve3(set);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.16, 6, false), steel);
      tube.castShadow = true;
      g.add(tube);
    }
    // Suspenders.
    for (let i = 1; i < 22; i++) {
      const x = towerX[0] + ((towerX[1] - towerX[0]) * i) / 22;
      const yTop = cableY(x);
      if (yTop <= deckY + 0.4) continue;
      const rod = new THREE.Mesh(
        new THREE.CylinderGeometry(0.055, 0.055, yTop - deckY, 4), steel);
      rod.position.set(x, (yTop + deckY) / 2, cz);
      g.add(rod);
    }
  }
  return g;
}


/** Shipyard gantry — legs, a boom out over the water, and a hoist. */
export function gantryCrane(): THREE.Group {
  const g = new THREE.Group();
  const steel = lam(0xb4553f);
  const H = 13;
  for (const sx of [-2.6, 2.6]) {
    for (const sz of [-2.2, 2.2]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.55, H, 0.55), steel);
      leg.position.set(sx, H / 2, sz);
      leg.castShadow = true;
      g.add(leg);
    }
  }
  const cross = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.7, 5.2), steel);
  cross.position.y = H;
  cross.castShadow = true;
  g.add(cross);
  // Boom cantilevers toward the water; that overhang is the whole silhouette.
  const boom = new THREE.Mesh(new THREE.BoxGeometry(13, 0.6, 1.3), steel);
  boom.position.set(-4.5, H + 1.4, 0);
  boom.castShadow = true;
  g.add(boom);
  const stay = new THREE.Mesh(new THREE.BoxGeometry(0.3, 4.4, 0.3), steel);
  stay.position.set(1.6, H + 3.2, 0);
  g.add(stay);
  const hoist = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.9, 1.1), lam(0x3a3a3e));
  hoist.position.set(-7.5, H + 0.6, 0);
  g.add(hoist);
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 5.5, 4), lam(0x2a2a2e));
  cable.position.set(-7.5, H - 2.4, 0);
  g.add(cable);
  return g;
}

/**
 * The mobile sauna: a flatbed with a barrel sauna, a chimney and a stovepipe
 * plume. Faces +x, so the caller rotates it to the direction of travel.
 */
export function saunaTruck(): THREE.Group {
  const g = new THREE.Group();
  const bed = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.3, 1.9), lam(0x33363d));
  bed.position.set(-0.3, 0.62, 0);
  bed.castShadow = true;
  g.add(bed);

  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.05, 1.75), lam(0xd94f3d));
  cab.position.set(2.05, 1.15, 0);
  cab.castShadow = true;
  g.add(cab);
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.46, 1.55), new THREE.MeshPhongMaterial({ color: 0x9ec4d6 }));
  glass.position.set(2.72, 1.36, 0);
  g.add(glass);

  // A timber CABIN, not a barrel. A barrel read as a tank at this scale; a
  // box with visible planks and its name on the side is unambiguous, which is
  // the point — an agent has to be able to see what it is.
  const wood = woodTexture();
  wood.repeat.set(3, 1);
  const cabinMat = new THREE.MeshLambertMaterial({ map: wood });
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(3.1, 1.75, 1.85), cabinMat);
  cabin.position.set(-0.7, 1.65, 0);
  cabin.castShadow = true;
  cabin.receiveShadow = true;
  g.add(cabin);

  // Shallow gable so it reads as a hut rather than a shipping container.
  const roof = new THREE.Mesh(new THREE.BoxGeometry(3.3, 0.22, 2.05), lam(0x6f4a25));
  roof.position.set(-0.7, 2.58, 0);
  roof.castShadow = true;
  g.add(roof);

  // A board on each flank AND one on the roof. The flank signs vanish the
  // moment the truck is side-on to the camera, which at a fixed isometric
  // angle is half the circuit — the roof board is the one that always reads.
  for (const sz of [1, -1]) {
    const board = signBoard('SAUNA', 2.85);
    board.position.set(-0.7, 1.68, sz * 0.945);
    if (sz < 0) board.rotation.y = Math.PI;
    g.add(board);
  }
  const roofSignBoard = signBoard('SAUNA', 2.7);
  roofSignBoard.rotation.x = -Math.PI / 2;
  roofSignBoard.position.set(-0.7, 2.71, 0);
  g.add(roofSignBoard);

  const door = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.2, 0.8), lam(0x7d5a36));
  door.position.set(-2.26, 1.5, 0);
  g.add(door);
  const porthole = new THREE.Mesh(new THREE.CircleGeometry(0.22, 14),
    new THREE.MeshPhongMaterial({ color: 0xffd79a }));
  porthole.rotation.y = -Math.PI / 2;
  porthole.position.set(-2.32, 1.75, 0);
  g.add(porthole);

  const flue = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 1.2, 8), lam(0x3a3a3e));
  flue.position.set(-1.7, 3.1, 0.55);
  flue.castShadow = true;
  g.add(flue);
  const smoke = new THREE.Mesh(
    new THREE.SphereGeometry(0.36, 10, 8),
    new THREE.MeshLambertMaterial({ color: 0xe8e8ea, transparent: true, opacity: 0.55 }),
  );
  smoke.position.set(-1.8, 3.9, 0.55);
  smoke.name = 'smoke';
  g.add(smoke);

  const tyre = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 12);
  for (const wx of [2.0, -0.5, -1.6]) {
    for (const wz of [-0.88, 0.88]) {
      const w = new THREE.Mesh(tyre, lam(0x22242a));
      w.rotation.x = Math.PI / 2;
      w.position.set(wx, 0.36, wz);
      g.add(w);
    }
  }
  return g;
}

// --- voxel type --------------------------------------------------------------
// A 5x7 bitmap font extruded into boxes.
//
// three.js can extrude real glyphs, but only from a typeface JSON this project
// does not ship and cannot fetch (the artifact CSP and the offline build both
// rule out a CDN font). Blocky letters are not a compromise here — chunky
// voxel type is the same visual language as the rest of the city, and unlike a
// canvas decal it has thickness, so it catches the sun and casts a shadow.
const GLYPHS: Record<string, string[]> = {
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  N: ['10001', '11001', '10101', '10101', '10011', '10001', '10001'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

/**
 * Extruded word, centred on the origin, standing on the XZ plane.
 * `cell` is the size of one bitmap pixel in world units.
 */
export function voxelText(text: string, cell = 1, color = 0xe5402c): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color });
  const side = new THREE.MeshLambertMaterial({ color: new THREE.Color(color).offsetHSL(0, 0, -0.13) });
  const letters = [...text.toUpperCase()];
  const advance = 6 * cell;                       // 5 wide + 1 of tracking
  const originX = (-(letters.length - 1) * advance) / 2;

  letters.forEach((ch, li) => {
    const rows = GLYPHS[ch];
    if (!rows) return;
    // Merge each letter's runs into as few boxes as possible: a horizontal run
    // of set pixels becomes ONE box, not five. Cuts the mesh count by ~4x on a
    // word this size and removes the coplanar faces between adjacent cubes.
    rows.forEach((row, r) => {
      let c = 0;
      while (c < row.length) {
        if (row[c] !== '1') {
          c++;
          continue;
        }
        let run = 0;
        while (c + run < row.length && row[c + run] === '1') run++;
        const box = new THREE.Mesh(
          new THREE.BoxGeometry(run * cell, cell, cell * 1.15),
          [side, side, mat, side, mat, side],
        );
        box.position.set(
          originX + li * advance + (c + run / 2 - 2.5) * cell,
          (6.5 - r) * cell,
          0,
        );
        box.castShadow = true;
        box.receiveShadow = true;
        g.add(box);
        c += run;
      }
    });
  });
  return g;
}

/** Painted timber: vertical planks with grain, for the sauna body. */
function woodTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#b3873f';
  g.fillRect(0, 0, 128, 128);
  for (let x = 0; x < 128; x += 16) {
    // Plank edges: a dark seam with a light chamfer, which is what makes
    // separate boards read rather than one painted slab.
    g.fillStyle = 'rgba(90,60,26,0.55)';
    g.fillRect(x, 0, 2, 128);
    g.fillStyle = 'rgba(255,232,190,0.20)';
    g.fillRect(x + 2, 0, 1, 128);
    for (let k = 0; k < 22; k++) {
      const y = (k * 37 + x * 11) % 128;
      g.fillStyle = `rgba(120,82,38,${0.05 + ((x + k) % 5) * 0.02})`;
      g.fillRect(x + 3, y, 12, 1 + ((x + k) % 3));
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 16;
  return t;
}

/** A signboard reading `text`, sized to `w`. Used on the sauna's flanks. */
function signBoard(text: string, w: number) {
  const { tex, aspect } = signTexture(text, '#3a2412', '#e9d9b4');
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, w / aspect, 0.08),
    new THREE.MeshLambertMaterial({ map: tex }),
  );
  m.castShadow = true;
  return m;
}

/** A Waymo: white body, black glass, and the roof lidar that gives it away. */
export function waymo(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.55, 1.05),
    new THREE.MeshLambertMaterial({ color: 0xf2f3f5 }));
  body.position.y = 0.5;
  body.castShadow = true;
  g.add(body);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.42, 0.95),
    new THREE.MeshPhongMaterial({ color: 0x2b3038, shininess: 60 }));
  cabin.position.set(-0.1, 0.94, 0);
  cabin.castShadow = true;
  g.add(cabin);
  // The spinning dome is the whole identity of the thing.
  const lidar = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.26, 12),
    new THREE.MeshLambertMaterial({ color: 0x23262b }));
  lidar.position.set(-0.1, 1.28, 0);
  lidar.name = 'lidar';
  g.add(lidar);
  for (const [sx, sz] of [[0.86, 0.56], [0.86, -0.56]] as const) {
    const sensor = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16),
      new THREE.MeshLambertMaterial({ color: 0x3c6ecf }));
    sensor.position.set(sx, 0.62, sz);
    g.add(sensor);
  }
  // Wordmark on the flanks AND on the roof.
  //
  // A 1.15-wide decal on a car this size was a few pixels of text — present
  // and unreadable. The ROOF is the surface a fixed isometric camera sees most
  // of on a vehicle, and it is the only one that never turns away, so that is
  // where the legible copy goes. The flanks keep a smaller version for when
  // you are close.
  // WHITE ON DARK, not dark on white. The plate was white type-on-white sitting
  // on a white car — the letters had nothing to sit against and the strokes
  // thinned to nothing at this distance. Reversing it gives the wordmark a
  // block of contrast to live in, which is what actually makes small type read.
  const { tex, aspect } = signTexture('Waymo', '#ffffff', '#0e2a47');
  const roofPlate = new THREE.Mesh(
    new THREE.PlaneGeometry(2.15, 2.15 / aspect),
    new THREE.MeshBasicMaterial({ map: tex }),
  );
  roofPlate.rotation.x = -Math.PI / 2;
  roofPlate.rotation.z = Math.PI / 2;      // read along the car, not across it
  roofPlate.position.set(-0.1, 1.17, 0);
  g.add(roofPlate);

  for (const sz of [1, -1]) {
    const decal = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 1.6 / aspect),
      new THREE.MeshBasicMaterial({ map: tex }),
    );
    decal.position.set(-0.15, 0.58, sz * 0.53);
    decal.rotation.y = sz > 0 ? 0 : Math.PI;
    g.add(decal);
  }

  const tyre = new THREE.CylinderGeometry(0.26, 0.26, 0.2, 10);
  for (const wx of [0.72, -0.72]) {
    for (const wz of [-0.52, 0.52]) {
      const w = new THREE.Mesh(tyre, new THREE.MeshLambertMaterial({ color: 0x1b1d22 }));
      w.rotation.x = Math.PI / 2;
      w.position.set(wx, 0.28, wz);
      g.add(w);
    }
  }
  return g;
}

/** Traffic signal: mast, arm, and a three-lamp head over the carriageway. */
export function trafficSignal(): THREE.Group {
  const g = new THREE.Group();
  const dark = new THREE.MeshLambertMaterial({ color: 0x2f333a });
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 4.4, 8), dark);
  mast.position.y = 2.2;
  mast.castShadow = true;
  g.add(mast);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.13, 0.13), dark);
  arm.position.set(1.3, 4.3, 0);
  g.add(arm);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.85, 0.32), dark);
  head.position.set(2.4, 3.95, 0);
  head.castShadow = true;
  g.add(head);
  const LAMP = [0xd94f3d, 0xe8c33d, 0x4bbf6b];
  LAMP.forEach((hex, i) => {
    const lamp = new THREE.Mesh(
      new THREE.CircleGeometry(0.1, 10),
      new THREE.MeshBasicMaterial({ color: hex }),
    );
    lamp.position.set(2.57, 4.22 - i * 0.27, 0);
    lamp.rotation.y = Math.PI / 2;
    g.add(lamp);
  });
  return g;
}


// --- brand furniture ---------------------------------------------------------
// Hoardings, balloons and disc signs. In the reference these are most of what
// says "Silicon Valley" — the buildings alone are just an office park. All of
// them carry OUR fictional names; pixel-perfect recreations of live trademarks
// on a public page are a risk that buys nothing.

/**
 * FASCIA SIGN — a panel fixed flat to the building's upper wall.
 *
 * The freestanding hoarding on legs did not work at this scale: to carry a
 * readable name it had to be wider than the campus it stood on, so it hung out
 * over neighbouring blocks and, in one case, over the letters. A fascia sign
 * is bounded by the wall it is mounted to, which is exactly the constraint
 * that was missing — and it is how these buildings are actually signed.
 *
 * Returns a panel lying in the XY plane facing +Z; the caller rotates it onto
 * whichever elevation should carry it.
 */
export function fasciaSign(text: string, hex = '#1d2733', wallW = 8): THREE.Group {
  const g = new THREE.Group();
  const { tex, aspect } = signTexture(text, '#ffffff', '#15181d', true);
  // Nearly the full wall, not 82% of it capped at 11 — a shop sign is meant to
  // dominate the elevation it is on, and at this camera distance anything
  // smaller is a smudge.
  const w = Math.min(wallW * 0.96, 20);
  const h = w / aspect;
  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, 0.26),
    // BASIC, not Lambert. A lit material takes the scene's shading, and half
    // these signs face away from the sun — they were rendering at a third of
    // their brightness and reading as grey smudges. A sign is effectively
    // self-lit; unlit is both correct and free.
    new THREE.MeshBasicMaterial({ map: tex }),
  );
  panel.castShadow = true;
  g.add(panel);
  // Thin brand-coloured reveal around the panel: enough colour to identify the
  // tenant without the sign itself going mid-tone and vanishing into the grass.
  const reveal = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.5, h + 0.5, 0.16),
    new THREE.MeshBasicMaterial({ color: hex }),
  );
  reveal.position.z = -0.08;
  g.add(reveal);
  return g;
}

/** Tethered balloon, as in the reference's Uber and Lyft blimps. */
export function balloon(text: string, hex: number): THREE.Group {
  const g = new THREE.Group();
  // Emissive, not just coloured. A Lambert surface under this scene's low fill
  // light loses most of its saturation on the shaded side, so a "bright" hue
  // renders muddy; feeding a share of the colour back as emission keeps the
  // balloon reading as a bright object rather than a lit grey one.
  const glow = new THREE.Color(hex);
  const skin = new THREE.MeshLambertMaterial({
    color: hex,
    emissive: glow.clone().multiplyScalar(0.45),
  });
  const body = new THREE.Mesh(new THREE.SphereGeometry(3.4, 22, 16), skin);
  body.scale.set(1, 1.16, 1);
  body.position.y = 13;
  body.castShadow = true;
  g.add(body);
  // The taper at the bottom is what separates a balloon from a ball.
  const neck = new THREE.Mesh(new THREE.ConeGeometry(1.5, 2.6, 16), skin);
  neck.rotation.x = Math.PI;
  neck.position.y = 9.4;
  g.add(neck);
  // Text colour is chosen from the balloon's LUMINANCE, not fixed to white.
  // White on cyan or yellow is unreadable, which is exactly what happened.
  const lum = 0.2126 * glow.r + 0.7152 * glow.g + 0.0722 * glow.b;
  const ink = lum > 0.45 ? '#10161c' : '#ffffff';
  const { tex, aspect } = signTexture(text, ink);
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(5.6, 5.6 / aspect),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }),
  );
  label.position.set(0, 13.2, 3.5);
  g.add(label);
  const tether = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 8.2, 5),
    new THREE.MeshLambertMaterial({ color: 0x9aa0a6 }),
  );
  tether.position.y = 4.1;
  g.add(tether);
  return g;
}

/** Round sign on a mast — the reference's Twitter and Android discs. */
export function discSign(text: string, hex: number): THREE.Group {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(2.6, 2.6, 0.32, 28),
    new THREE.MeshLambertMaterial({ color: 0xf4f4f2 }),
  );
  disc.rotation.x = Math.PI / 2;
  disc.position.y = 8.4;
  disc.castShadow = true;
  g.add(disc);
  const { tex, aspect } = signTexture(
    text, `#${new THREE.Color(hex).getHexString()}`, 'transparent', true);
  for (const sz of [1, -1]) {
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(3.5, 3.5 / aspect),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
    );
    face.position.set(0, 8.4, sz * 0.19);
    if (sz < 0) face.rotation.y = Math.PI;
    g.add(face);
  }
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.2, 6.2, 8),
    new THREE.MeshLambertMaterial({ color: 0xc9ccd1 }),
  );
  mast.position.y = 3.1;
  mast.castShadow = true;
  g.add(mast);
  return g;
}

/** Quadcopter with a parcel slung under it. Rotors are named for animation. */
export function deliveryDrone(): THREE.Group {
  const g = new THREE.Group();
  const shell = new THREE.MeshLambertMaterial({ color: 0xf2f3f5 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x30343b });

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.3, 0.7), shell);
  body.castShadow = true;
  g.add(body);
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), dark);
  eye.position.set(0.5, -0.06, 0);
  g.add(eye);

  for (const [ax, az] of [[0.72, 0.62], [0.72, -0.62], [-0.72, 0.62], [-0.72, -0.62]] as const) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.09, 0.09), shell);
    arm.position.set(ax / 1.6, 0, az / 1.6);
    arm.rotation.y = Math.atan2(az, ax);
    g.add(arm);
    // A ring plus a blur disc: at this scale a modelled blade is one pixel, so
    // the disc is what actually reads as "spinning".
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.045, 6, 14), dark);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(ax, 0.1, az);
    g.add(ring);
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.31, 14),
      new THREE.MeshBasicMaterial({ color: 0xdfe3e8, transparent: true, opacity: 0.45 }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(ax, 0.12, az);
    disc.name = 'rotor';
    g.add(disc);
  }

  const parcel = new THREE.Mesh(
    new THREE.BoxGeometry(0.52, 0.44, 0.44),
    new THREE.MeshLambertMaterial({ color: 0xc4a06a }),
  );
  parcel.position.y = -0.62;
  parcel.castShadow = true;
  g.add(parcel);
  const tape = new THREE.Mesh(
    new THREE.BoxGeometry(0.54, 0.06, 0.1),
    new THREE.MeshLambertMaterial({ color: 0xa8845a }),
  );
  tape.position.y = -0.4;
  g.add(tape);
  for (const sx of [-0.2, 0.2]) {
    const line = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, 0.4, 4), dark);
    line.position.set(sx, -0.28, 0);
    g.add(line);
  }
  return g;
}

/**
 * A person.
 *
 * Three stacked boxes read as a chess piece, not a human — and these are the
 * simulation's residents, so the figure has to survive being looked at. What
 * actually makes a small figure read as a person, in rough order of value:
 *
 *   1. PROPORTION. Head about an eighth of the height, shoulders wider than
 *      the waist, legs a little over half the total.
 *   2. LIMB SEPARATION. Two legs with a gap between them, and arms that hang
 *      clear of the torso. A solid block below the waist reads as a plinth.
 *   3. A HEAD THAT IS NOT A CUBE. Hair as a separate colour over the skull is
 *      the cheapest thing that turns a box into a head.
 *
 * Limbs are named so a walk cycle can swing them; nothing here animates by
 * itself.
 */
const SKINS = [0xf0c9a4, 0xe0ab80, 0xc68863, 0x8d5524, 0x6b4326, 0xffdbb4];
const HAIRS = [0x2b1d16, 0x4a2f1b, 0x8a5a2b, 0x1a1a1e, 0x6b6b70, 0xa8532b];
const TROUSERS = [0x2f3540, 0x3b4a63, 0x4a4038, 0x25282e, 0x5a5f6a];

export type Outfit = 'tee' | 'hoodie' | 'jacket' | 'dress' | 'skirt';

export function person(shirt: number, seed = 0, outfit?: Outfit): THREE.Group {
  const g = new THREE.Group();
  const pick = <T,>(arr: T[], k: number) =>
    arr[Math.abs(Math.round(Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453)) % arr.length];
  const skinHex = pick(SKINS, 1);
  const skin = lam(skinHex);
  const hairHex = pick(HAIRS, 2);
  const hair = lam(hairHex);
  const cloth = lam(shirt);
  const legMat = lam(pick(TROUSERS, 3));
  const shoe = lam(0x23252b);
  const fit: Outfit = outfit ?? pick(['tee', 'hoodie', 'jacket', 'dress', 'skirt'] as Outfit[], 4);
  const longHair = fit === 'dress' || fit === 'skirt' || pick([0, 1], 5) === 1;

  const legged = fit !== 'dress';
  if (legged) {
    for (const sx of [-1, 1]) {
      const leg = new THREE.Group();
      const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.2, 3, 6), legMat);
      thigh.position.y = -0.13;
      leg.add(thigh);
      // A skirt covers the thigh, so the shin below it is bare — that contrast
      // is what makes the hem read as a hem rather than as a wide belt.
      const shin = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.048, 0.19, 3, 6), fit === 'skirt' ? skin : legMat);
      shin.position.y = -0.36;
      leg.add(shin);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.05, 0.16), shoe);
      foot.position.set(0, -0.49, 0.03);
      leg.add(foot);
      leg.position.set(sx * 0.075, 0.52, 0);
      leg.name = sx > 0 ? 'legR' : 'legL';
      leg.children.forEach((c) => ((c as THREE.Mesh).castShadow = true));
      g.add(leg);
    }
  } else {
    // A dress still needs NAMED legs. They were bare meshes parented straight
    // to the figure, so anyone in a dress had no legL/legR — and the walk cycle
    // looks those up by name, which meant they slid instead of walking.
    for (const sx of [-1, 1]) {
      const leg = new THREE.Group();
      const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.048, 0.17, 3, 6), skin);
      shin.position.y = -0.36;
      leg.add(shin);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.05, 0.16), shoe);
      foot.position.set(0, -0.49, 0.03);
      leg.add(foot);
      leg.position.set(sx * 0.075, 0.52, 0);
      leg.name = sx > 0 ? 'legR' : 'legL';
      leg.children.forEach((c) => ((c as THREE.Mesh).castShadow = true));
      g.add(leg);
    }
  }

  // --- clothing silhouette -------------------------------------------------
  // The outfit is carried by the OUTLINE, not by a texture. At forty pixels a
  // printed pattern is one grey smudge, but a flared hem or a boxy hood
  // survives — the shape is the only thing that reads.
  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.12, 0.13), legMat);
  hips.position.y = 0.57;
  if (legged && fit !== 'skirt') g.add(hips);

  if (fit === 'skirt' || fit === 'dress') {
    const flare = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.18, fit === 'dress' ? 0.46 : 0.22, 10), cloth);
    flare.position.y = fit === 'dress' ? 0.66 : 0.54;
    flare.castShadow = true;
    g.add(flare);
  }

  const torso = new THREE.Mesh(
    new THREE.CylinderGeometry(fit === 'hoodie' ? 0.13 : 0.115, 0.095, 0.3, 8), cloth);
  torso.position.y = 0.77;
  torso.castShadow = true;
  g.add(torso);
  const shoulders = new THREE.Mesh(
    new THREE.CapsuleGeometry(fit === 'jacket' ? 0.068 : 0.06, 0.19, 3, 6), cloth);
  shoulders.rotation.z = Math.PI / 2;
  shoulders.position.y = 0.9;
  shoulders.castShadow = true;
  g.add(shoulders);

  if (fit === 'hoodie') {
    const hood = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), cloth);
    hood.scale.set(1.1, 0.8, 0.9);
    hood.position.set(0, 0.98, -0.05);
    g.add(hood);
  }
  if (fit === 'jacket') {
    // Open front: two lapel strips in a darker shade of the shirt.
    const lapel = lam(new THREE.Color(shirt).offsetHSL(0, 0, -0.16).getHex());
    for (const sx of [-1, 1]) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.26, 0.03), lapel);
      l.position.set(sx * 0.045, 0.78, 0.105);
      g.add(l);
    }
  }

  for (const sx of [-1, 1]) {
    const arm = new THREE.Group();
    // Short sleeves on a tee, long on everything else — where the cloth stops
    // and skin starts is a real clothing cue at this size.
    const sleeveLong = fit !== 'tee' && fit !== 'dress';
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.037, 0.16, 3, 6), cloth);
    upper.position.y = -0.1;
    arm.add(upper);
    const fore = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.033, 0.15, 3, 6), sleeveLong ? cloth : skin);
    fore.position.y = -0.28;
    arm.add(fore);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 5), skin);
    hand.position.y = -0.39;
    arm.add(hand);
    arm.position.set(sx * 0.135, 0.9, 0);
    arm.name = sx > 0 ? 'armR' : 'armL';
    arm.children.forEach((c) => ((c as THREE.Mesh).castShadow = true));
    g.add(arm);
  }

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.05, 6), skin);
  neck.position.y = 0.95;
  g.add(neck);

  // --- head and face -------------------------------------------------------
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 10), skin);
  head.scale.set(0.92, 1.06, 0.95);
  head.position.y = 1.04;
  head.castShadow = true;
  head.name = 'head';
  g.add(head);

  // Eyes, brows and mouth as tiny flat plates on the face. Geometry rather
  // than a texture: a 40px head gets maybe three pixels of face, and a plate
  // that is definitely dark beats a texel that might be.
  const dark = lam(0x1d1a17);
  const white = lam(0xf4f2ee);
  for (const sx of [-1, 1]) {
    const eyeW = new THREE.Mesh(new THREE.SphereGeometry(0.019, 6, 5), white);
    eyeW.position.set(sx * 0.032, 1.055, 0.073);
    eyeW.scale.set(1, 0.8, 0.5);
    g.add(eyeW);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.0105, 5, 4), dark);
    pupil.position.set(sx * 0.032, 1.053, 0.081);
    pupil.scale.set(1, 1, 0.5);
    g.add(pupil);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.007, 0.008), hair);
    brow.position.set(sx * 0.032, 1.081, 0.077);
    g.add(brow);
  }
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.008, 0.008), dark);
  mouth.position.set(0, 1.005, 0.079);
  g.add(mouth);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.011, 0.022, 5), skin);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 1.031, 0.082);
  g.add(nose);

  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.089, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), hair);
  cap.scale.set(0.94, 1.06, 0.97);
  cap.position.y = 1.045;
  g.add(cap);
  if (longHair) {
    // Falls behind the head and past the neck; the back of the silhouette is
    // where long hair actually shows from this angle.
    const fall = new THREE.Mesh(new THREE.CapsuleGeometry(0.062, 0.1, 4, 8), hair);
    fall.scale.set(1, 1, 0.62);
    fall.position.set(0, 0.985, -0.035);
    fall.castShadow = true;
    g.add(fall);
  }

  return g;
}

/**
 * Rooftop scene: a humanoid mid-dance with people watching round a table.
 * The robot's arms and torso are named so the viewer can animate them.
 */
export function rooftopParty(): THREE.Group {
  const g = new THREE.Group();

  // Pushed to the edge. It used to sit at the origin — which is where the
  // robot stands — so the dancer was inside the furniture.
  const TABLE_X = -3.2;
  const table = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 0.12, 1.1),
    new THREE.MeshLambertMaterial({ color: 0x8b5e34 }),
  );
  table.position.set(TABLE_X, 0.62, 0);
  table.castShadow = true;
  g.add(table);
  for (const sx of [-1.1, 1.1]) {
    for (const sz of [-0.42, 0.42]) {
      const leg = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.62, 0.1),
        new THREE.MeshLambertMaterial({ color: 0x6f4a25 }));
      leg.position.set(TABLE_X + sx, 0.31, sz);
      g.add(leg);
    }
  }

  const SHIRTS = [0x2f6fb5, 0xd94f3d, 0x4b8b5a, 0xc9a227, 0x8a5cc4, 0x20808d];
  SHIRTS.forEach((c, i) => {
    // A horseshoe facing the dancer, open toward the camera, rather than a
    // closed ring — a full circle puts half the crowd's backs to the viewer.
    const a = 0.5 + (i / (SHIRTS.length - 1)) * Math.PI * 1.25;
    const p = person(c, i + 1);
    p.position.set(Math.cos(a) * 2.9, 0, Math.sin(a) * 2.4);
    // Face the centre. Same convention as every other figure: person() looks
    // along +Z, so the angle is atan2(dx, dz) of the direction to the middle.
    // The old form put their backs to the dancer at a = 0.
    p.rotation.y = Math.atan2(-Math.cos(a), -Math.sin(a));
    g.add(p);
  });

  const floor = new THREE.Mesh(
    new THREE.CylinderGeometry(1.9, 1.9, 0.06, 24),
    new THREE.MeshLambertMaterial({ color: 0x9aa3b2 }),
  );
  floor.position.y = 0.05;
  floor.receiveShadow = true;
  g.add(floor);

  const bot = new THREE.Group();
  // A silver articulated humanoid rather than a white box: segmented limbs, a
  // dark visor head and a chest plate. At this scale the read comes from the
  // SILHOUETTE — two-part arms that bend, and a head narrower than the
  // shoulders — not from surface detail.
  const shell = new THREE.MeshPhongMaterial({ color: 0xdfe3e8, shininess: 70 });
  const joint = new THREE.MeshLambertMaterial({ color: 0x4a4f57 });
  const visor = new THREE.MeshPhongMaterial({ color: 0x14181d, shininess: 110 });

  const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.2), joint);
  pelvis.position.y = 0.62;
  bot.add(pelvis);
  for (const sx of [-1, 1]) {
    const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.28, 4, 8), shell);
    thigh.position.set(sx * 0.11, 0.44, 0);
    thigh.castShadow = true;
    bot.add(thigh);
    const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.26, 4, 8), shell);
    shin.position.set(sx * 0.11, 0.16, 0);
    bot.add(shin);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.06, 0.22), joint);
    foot.position.set(sx * 0.11, 0.03, 0.03);
    bot.add(foot);
  }

  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.38, 0.24), shell);
  chest.position.y = 0.9;
  chest.castShadow = true;
  chest.name = 'botChest';
  bot.add(chest);
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.2, 0.03), joint);
  plate.position.set(0, 0.94, 0.13);
  bot.add(plate);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.08, 8), joint);
  neck.position.y = 1.13;
  bot.add(neck);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), shell);
  head.position.y = 1.26;
  head.castShadow = true;
  bot.add(head);
  // The visor wraps the front and both temples — that band is the single most
  // recognisable thing about this class of robot.
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.205, 0.09, 0.205), visor);
  band.position.y = 1.28;
  bot.add(band);
  const eye = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.03, 0.02),
    new THREE.MeshBasicMaterial({ color: 0x37e6ff }),
  );
  eye.position.set(0, 1.29, 0.105);
  bot.add(eye);

  for (const sx of [-1, 1]) {
    // Arms pivot at the shoulder; the forearm hangs off the upper arm so one
    // rotation swings the whole limb and reads as a wave.
    const arm = new THREE.Group();
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.22, 4, 8), shell);
    upper.position.y = -0.13;
    upper.castShadow = true;
    arm.add(upper);
    const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), joint);
    elbow.position.y = -0.26;
    arm.add(elbow);
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.048, 0.2, 4, 8), shell);
    fore.position.y = -0.4;
    arm.add(fore);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.05), joint);
    hand.position.y = -0.54;
    arm.add(hand);
    arm.position.set(sx * 0.25, 1.04, 0);
    arm.name = sx > 0 ? 'botArmR' : 'botArmL';
    bot.add(arm);
  }
  bot.scale.setScalar(1.5);   // a person is ~1.05 units here; the robot reads taller
  bot.name = 'bot';
  bot.userData.pelvis = pelvis;
  g.add(bot);
  return g;
}

/**
 * The Y Combinator mark, big enough to be the building's roof.
 *
 * Traced from the official SVG's own path data rather than approximated: it is
 * one path on an orange field, so it costs nothing to be exact. Drawn to a
 * canvas at 512 so it stays crisp when it covers a whole rooftop.
 */
const YC_PATH =
  'M119.373653,144.745813 L75.43296,62.4315733 L95.5144533,62.4315733 L121.36192,114.52416 C121.759575,115.452022 122.2235,116.413008 122.753707,117.407147 C123.283914,118.401285 123.747838,119.428546 124.145493,120.48896 C124.410597,120.886615 124.609422,121.251127 124.741973,121.582507 C124.874525,121.913886 125.007075,122.212123 125.139627,122.477227 C125.802386,123.802744 126.39886,125.095105 126.929067,126.354347 C127.459274,127.613589 127.923198,128.773399 128.320853,129.833813 C129.381268,127.580433 130.541078,125.1614 131.80032,122.57664 C133.059562,119.99188 134.351922,117.307747 135.67744,114.52416 L161.92256,62.4315733 L180.612267,62.4315733 L136.27392,145.739947 L136.27392,198.826667 L119.373653,198.826667 L119.373653,144.745813 Z';

let _ycTex: THREE.CanvasTexture | null = null;
export function ycLogoTexture(): THREE.CanvasTexture {
  if (_ycTex) return _ycTex;
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#FB651E';
  g.fillRect(0, 0, 512, 512);
  g.save();
  g.scale(2, 2);                 // the source path is in a 256 box
  g.fillStyle = '#ffffff';
  g.fill(new Path2D(YC_PATH));
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 16;
  _ycTex = t;
  return t;
}

/** A logo laid flat on a roof, sized to it. */
export function roofLogo(tex: THREE.Texture, w: number, h: number): THREE.Mesh {
  const side = Math.min(w, h) * 0.86;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(side, side),
    // Unlit, like the fascia signs: a roof facing away from the sun renders a
    // lit texture at a third of its brightness, and a logo has to read.
    new THREE.MeshBasicMaterial({ map: tex }),
  );
  m.rotation.x = -Math.PI / 2;
  return m;
}


/**
 * Chase Center's mark: four blue quadrants pinwheeling around an open centre.
 *
 * Drawn rather than fetched, and rendered UNLIT so it reads as illuminated
 * signage — an arena logo at night is a light source, not a painted surface,
 * and a lit material on a roof facing away from the sun would render it grey.
 */
let _chaseTex: THREE.CanvasTexture | null = null;
export function chaseLogoTexture(): THREE.CanvasTexture {
  if (_chaseTex) return _chaseTex;
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0d1a2b';
  g.fillRect(0, 0, S, S);
  g.translate(S / 2, S / 2);
  // Four identical arms, each rotated a quarter turn. The gap at the centre
  // and the offset of each arm are what make it a pinwheel rather than a cross.
  for (let k = 0; k < 4; k++) {
    g.save();
    g.rotate((k * Math.PI) / 2);
    g.fillStyle = '#2a63ad';
    g.beginPath();
    g.moveTo(-S * 0.2, -S * 0.36);
    g.lineTo(S * 0.09, -S * 0.36);
    g.lineTo(S * 0.2, -S * 0.25);
    g.lineTo(S * 0.2, -S * 0.06);
    g.lineTo(S * 0.06, -S * 0.06);
    g.lineTo(S * 0.06, -S * 0.23);
    g.lineTo(-S * 0.2, -S * 0.23);
    g.closePath();
    g.fill();
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 16;
  _chaseTex = t;
  return t;
}
