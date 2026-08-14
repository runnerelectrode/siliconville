// /siliconville — the valley in 3D.
//
// The 2D version is at /siliconville2d and it will never look like the
// reference, because the reference's whole character is HEIGHT: masses that
// occlude each other and a low sun casting long shadows. A top-down tilemap
// has no z-axis, so no tileset closes that gap.
//
// three.js here is not an alternative to OpenGL — it runs on WebGL2, which is
// OpenGL ES 3.0 in the browser. Same pipeline, minus the boilerplate.
//
// Two decisions do most of the visual work:
//
//   ORTHOGRAPHIC camera, not perspective. Parallel lines stay parallel and
//   nothing converges, which is what makes the reference read as a diorama
//   rather than a photograph. A perspective camera at the same angle looks
//   like a drone shot.
//
//   ONE directional light with a shadow map. Flat-lit boxes look like a
//   diagram; the shadows are what make it a city.
//
// Geometry is instanced: 34 masses, 246 trees and ~12k ground cells would be
// thousands of draw calls one mesh at a time. As instances it is a handful.

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import * as city from '../../data/siliconville3d.js';
import {
  balloon, buildMass, deliveryDrone, discSign, fasciaSign, gantryCrane, goldenGate,
  roofSign, rooftopParty, saunaTruck,
  chaseLogoTexture, person, roofLogo, trafficSignal, waymo, ycLogoTexture,
  FLOOR_H, type Mass,
} from './buildings.ts';

// Bay geometry now comes FROM the generator rather than being mirrored here.
// Two copies of the same constant is how the bridge ended up in the wrong
// place the moment the map doubled.

const SURFACE_COLOR = [
  0x6f8d54, // grass
  0x3b3d42, // asphalt
  0x9a9890, // sidewalk
  0x4a4c52, // lot
  0x3f7f9e, // water
  0xa8a29a, // plaza
];


/**
 * `chrome: false` renders the canvas alone, filling whatever box it is given,
 * so the city can sit inside the Gatherville frame instead of taking over the
 * page. The standalone header and footer only make sense on a full-page view.
 */
/** One resident, as the simulation reports them. Positions are in TILES. */
export type Agent = {
  id: string; x: number; y: number; dx: number; dy: number; name: string;
  /** Sampled path between engine steps, packed by the server. */
  history?: ArrayBuffer;
};

export default function Siliconville3D(
  { chrome = true, agentsRef, engineRef, followRef, camYawRef }: {
    chrome?: boolean;
    agentsRef?: React.MutableRefObject<Agent[]>;
    engineRef?: React.MutableRefObject<unknown>;
    /** playerId to follow over the shoulder, or null for the city view. */
    followRef?: React.MutableRefObject<string | null>;
    /**
     * Yaw of the follow camera, published for the movement controls.
     *
     * The camera swings to sit behind whatever way the figure is facing, so a
     * key press has to be interpreted against it — see Steering. NaN means "not
     * following", i.e. no camera frame to be relative to.
     */
    camYawRef?: React.MutableRefObject<number>;
  } = {},
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const BAY_X = city.bayX as number;
    const BRIDGE_Y = city.bridgeY as number;
    const W = city.width as number;
    const H = city.height as number;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x9fc4d8);
    // No fog. With an ORTHOGRAPHIC camera the eye sits ~230 units from the
    // origin, so a range tuned as if it were a perspective camera swallowed
    // the whole city — far side bleached to sky, near side crushed to black.

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);

    // --- camera -------------------------------------------------------------
    // Orthographic, looking down a 45deg diagonal at roughly 35deg elevation.
    // The frustum is driven by `zoom`; the position only sets the ANGLE, so
    // pushing the camera further out never changes the framing.
    // VIEW_HALF is half the visible height IN WORLD UNITS, so the frustum is
    // expressed in the same units as the city (1 unit = 1 tile) and zoom stays
    // a plain multiplier. Deriving it from the map instead of hardcoding is
    // what stops the framing silently breaking when the city changes size.
    const VIEW_HALF = Math.max(W, H) * 0.42;
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
    cam.position.set(140, 120, 140);
    // Opens filling the frame rather than showing the whole island with a
    // margin round it. Fitting everything on screen makes the map look small
    // and leaves nothing to explore; the point is to scroll around it. The
    // bay, bridge and letters are still in the opening shot.
    cam.zoom = 1.75;

    // The shoulder camera. PERSPECTIVE, unlike the city's orthographic one:
    // an ortho camera at head height has no convergence, so the street does not
    // recede and the whole point of being down there is lost.
    const followCam = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
    const followTarget = new THREE.Vector3();
    const followPos = new THREE.Vector3();

    const controls = new OrbitControls(cam, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enableRotate = true;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = false;
    controls.minZoom = 0.45;
    controls.maxZoom = 9;
    // Keep the sun above the horizon — under it the shadows invert and the
    // whole scene reads inside-out.
    controls.maxPolarAngle = Math.PI / 2.2;

    // --- light --------------------------------------------------------------
    // Fill is deliberately LOW. At 1.05 it drowned the directional light and the
    // cast shadows vanished — the scene read as flat-shaded boxes. The shadows
    // are the single biggest reason this looks like a city and not a diagram.
    scene.add(new THREE.HemisphereLight(0xbdd7ee, 0x5a6b4a, 0.5));
    const sun = new THREE.DirectionalLight(0xfff6e6, 2.6);
    sun.position.set(-70, 95, 45);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    // The shadow frustum must cover the whole city; sized to the map, a
    // too-small box silently clips shadows off one side.
    const S = Math.max(W, H) * 0.62;
    Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 400 });
    // Without this the shadow camera keeps its default frustum and the sizing
    // above does nothing — shadows clip off one side and it looks like a bug
    // in the lighting rather than in the projection matrix.
    sun.shadow.camera.updateProjectionMatrix();
    // Shadow acne fix, sized from the shadow TEXEL rather than guessed.
    // The shadow camera spans 2*S world units across `mapSize` texels, so one
    // texel is (2*S)/mapSize across; a surface must be offset by more than
    // that along its normal or it samples its own depth and self-shadows.
    // normalBias was 0.03 against a ~0.077-unit texel — under half a texel —
    // which is why the walls crawled with dark blotches as the camera moved.
    // depthBias stays small: over-biasing detaches shadows from their casters.
    const texel = (2 * S) / 4096;
    sun.shadow.normalBias = texel * 2.2;
    sun.shadow.bias = -0.0004;
    // The city is static and the sun does not move, so the shadow map is the
    // same every frame — yet it was re-rendering thousands of casters into a
    // 4096 map sixty times a second. Render it ONCE. The vehicles and drones
    // give up their shadows for it, which is a fair trade: they are small, and
    // a frozen shadow left behind by a moving object is worse than none.
    sun.shadow.autoUpdate = false;
    sun.shadow.needsUpdate = true;
    scene.add(sun, sun.target);

    // Tiles are authored with +y going DOWN the screen; three.js has +z going
    // toward the viewer. Centre the city on the origin and flip y into z.
    const px = (x: number) => x - W / 2;
    const pz = (y: number) => y - H / 2;

    // --- ground -------------------------------------------------------------
    // ONE merged mesh, not 12,288 instanced boxes.
    //
    // Instanced boxes tile exactly, which sounds fine and is not: every pair
    // of neighbours meets on a shared edge, and under camera motion those
    // hairline seams shimmer across the whole map. That was the rest of the
    // flutter. Merged quads share their edge COORDINATES, so there is no seam
    // to alias — and it collapses to a single draw call besides.
    const rle = city.groundRLE as number[];
    const total = W * H;
    const surf = new Uint8Array(total);
    {
      let c = 0;
      for (let k = 0; k < rle.length; k += 2) surf.fill(rle[k], c, (c += rle[k + 1]));
    }

    const gPos = new Float32Array(total * 12);
    const gCol = new Float32Array(total * 12);
    const gIdx = new Uint32Array(total * 6);
    const c0 = new THREE.Color();
    let vp = 0;
    let cp = 0;
    let ip = 0;
    let vi = 0;
    for (let idx = 0; idx < total; idx++) {
      const x = idx % W;
      const y = (idx / W) | 0;
      const X = px(x) - 0.5;
      const Z = pz(y) - 0.5;
      const Y = 0.1;
      gPos.set([X, Y, Z, X + 1, Y, Z, X + 1, Y, Z + 1, X, Y, Z + 1], vp);
      vp += 12;
      c0.setHex(SURFACE_COLOR[surf[idx]] ?? SURFACE_COLOR[0]);
      // Break up the flats so large areas do not read as one plastic sheet.
      const j = Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
      c0.offsetHSL(0, 0, (j - 0.5) * (surf[idx] === 0 ? 0.05 : 0.02));
      for (let q = 0; q < 4; q++) {
        gCol[cp++] = c0.r;
        gCol[cp++] = c0.g;
        gCol[cp++] = c0.b;
      }
      // Wound [0,2,1] so the normal points UP; the naive [0,1,2] faces down
      // and the entire map renders black under a sky light.
      gIdx.set([vi, vi + 2, vi + 1, vi, vi + 3, vi + 2], ip);
      ip += 6;
      vi += 4;
    }
    const gGeo = new THREE.BufferGeometry();
    gGeo.setAttribute('position', new THREE.BufferAttribute(gPos, 3));
    gGeo.setAttribute('color', new THREE.BufferAttribute(gCol, 3));
    gGeo.setIndex(new THREE.BufferAttribute(gIdx, 1));
    gGeo.computeVertexNormals();
    // vertexColors IS right here — unlike the InstancedMesh case, this
    // geometry genuinely carries a per-vertex colour attribute.
    const ground = new THREE.Mesh(gGeo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    ground.receiveShadow = true;
    scene.add(ground);

    // Water: the same quads a hair proud of the ground, for sheen. 0.02 is far
    // above the ortho depth buffer's resolution, so it cannot z-fight.
    const wIdxList: number[] = [];
    for (let idx = 0; idx < total; idx++) if (surf[idx] === 4) wIdxList.push(idx);
    if (wIdxList.length) {
      const wPos = new Float32Array(wIdxList.length * 12);
      const wIdx = new Uint32Array(wIdxList.length * 6);
      let a2 = 0;
      let b2 = 0;
      let v2 = 0;
      for (const idx of wIdxList) {
        const X = px(idx % W) - 0.5;
        const Z = pz((idx / W) | 0) - 0.5;
        const Y = 0.12;
        wPos.set([X, Y, Z, X + 1, Y, Z, X + 1, Y, Z + 1, X, Y, Z + 1], a2);
        a2 += 12;
        wIdx.set([v2, v2 + 2, v2 + 1, v2, v2 + 3, v2 + 2], b2);
        b2 += 6;
        v2 += 4;
      }
      const wGeo = new THREE.BufferGeometry();
      wGeo.setAttribute('position', new THREE.BufferAttribute(wPos, 3));
      wGeo.setIndex(new THREE.BufferAttribute(wIdx, 1));
      wGeo.computeVertexNormals();
      scene.add(new THREE.Mesh(wGeo, new THREE.MeshPhongMaterial({
        color: 0x3f86a8, shininess: 95, specular: 0x9fd0e6,
      })));
    }

    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();

    // --- buildings ----------------------------------------------------------
    // Per-building geometry, not instances. At ~23 buildings draw calls are
    // free and the silhouette is worth far more than the batching; a grid of
    // identical boxes is the failure mode no lighting rescues.
    const masses = city.masses as Mass[];
    const bGeo = new THREE.BoxGeometry(1, 1, 1);
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();

    masses.forEach((m) => {
      const grp = buildMass(m);
      grp.position.set(px(m.x + m.w / 2 - 0.5), 0, pz(m.y + m.h / 2 - 0.5));
      scene.add(grp);
      if (m.name) grp.add(roofSign(m.name, m, m.floors * FLOOR_H));

      // Doorway + threshold pad. Drawn because invisible affordances get
      // forgotten: if an agent is meant to walk to a door, the door has to be
      // somewhere a person can point at.
      const dr = m.door as { x: number; y: number; side: string } | null;
      if (dr) {
        const lx = dr.x - (m.x + m.w / 2 - 0.5);
        const lz = dr.y - (m.y + m.h / 2 - 0.5);
        const along = dr.side === 'N' || dr.side === 'S';
        const panel = new THREE.Mesh(
          new THREE.BoxGeometry(along ? 1.7 : 0.18, 1.7, along ? 0.18 : 1.7),
          new THREE.MeshPhongMaterial({ color: 0x2c3a44, shininess: 55 }),
        );
        panel.position.set(
          lx * (along ? 1 : 0.62), 0.85, lz * (along ? 0.62 : 1),
        );
        grp.add(panel);
        const pad = new THREE.Mesh(
          new THREE.BoxGeometry(2.1, 0.06, 2.1),
          new THREE.MeshLambertMaterial({ color: 0xbfb9ad }),
        );
        pad.position.set(lx, 0.06, lz);
        grp.add(pad);
      }
    });

    // --- landmarks ----------------------------------------------------------
    // SILICON VILLE, LYING ON the rooftops and extruded upward, as in the
    // reference. Standing the words up like a hoarding was the first attempt
    // and it failed twice over: the two rows occluded each other, and 18-unit
    // letters stood in front of the skyline instead of resting on it.
    //
    // Two nested groups on purpose. The inner one tips each word flat (-90
    // about X, which turns the glyph's "up" into depth and its thickness into
    // height); the outer one swings the whole banner to the camera's azimuth.
    // Setting both angles on one object would compose them in Euler order and
    // shear the layout.
    // Letters sized to the platform and resting exactly on its roofs. Both
    // numbers come from the generator: a hardcoded height is what made them
    // float over roads, and a hardcoded size is what would make them overhang.
    const plat = city.sign as { x: number; y: number; w: number; h: number };
    const roofY = city.signRoofY as number;
    // Letter buildings are 6 storeys; the red form sits on their skirt.
    const LETTER_FLOORS_H = 6 * FLOOR_H;

    const named = masses.filter((m) => m.name);

    // --- brand furniture ----------------------------------------------------
    // Hoardings on the named roofs, balloons over the campuses, disc signs at
    // street level. In the reference this is most of what says "Silicon
    // Valley" — the buildings on their own are just an office park.
    const BRAND: Record<string, number> = {
      OpenAI: 0x10a37f, Anthropic: 0xd97757, NVIDIA: 0x76b900, 'Google DeepMind': 0x4285f4,
      'Meta AI': 0x0064e0, 'Microsoft Copilot': 0x0078d4, Perplexity: 0x20808d,
      'Hugging Face': 0xffcc4d, xAI: 0x33363d, Mistral: 0xff7000,
      a16z: 0xff5c39, Cloudflare: 0xf6821f, 'Y Combinator': 0xff6600,
      'Philz Coffee': 0x1f7a4d, 'Stanford R&D': 0x8c1515, 'Pied Piper': 0x2f6fb5,
      'Khosla Ventures': 0x1b4f8a, "Zareen's": 0xe2342a, 'Chase Center': 0x2a63ad,
    };
    named.forEach((m, i) => {
      const hue = BRAND[m.name!] ?? 0x37414d;
      // Y Combinator gets its actual mark, laid across the whole roof. A
      // fascia sign on a Mission block is a few pixels at the default zoom;
      // the roof is the largest surface any building has from this angle, and
      // an orange square is legible when a wordmark is not.
      // The arena's mark goes in the COURTYARD, not on the ring — the ring is
      // an annulus and a disc laid on it would cover the hole the whole shape
      // is built around.
      if (m.name === 'Chase Center') {
        const inner = (Math.min(m.w, m.h) / 2) * 0.62;
        const logo = roofLogo(chaseLogoTexture(), inner * 1.7, inner * 1.7);
        logo.position.set(px(m.x + m.w / 2 - 0.5), 0.2, pz(m.y + m.h / 2 - 0.5));
        scene.add(logo);
      }

      if (m.name === 'Y Combinator') {
        // Sized to the TOP tier and lifted clear of the roof quad.
        //
        // It was sized to the base footprint and sat 0.04 above the roof. On a
        // terrace the top tier is about 64% of the base, so the logo overhung
        // its own roof — and 0.04 of clearance against a coplanar quad is what
        // made it flicker. Both problems, one cause: it was measured against
        // the wrong tier.
        const k = m.style === 'terrace' || m.style === 'tower' ? 1 - 2 * 0.18 : 0.97;
        const logo = roofLogo(ycLogoTexture(), m.w * k, m.h * k);
        logo.position.set(
          px(m.x + m.w / 2 - 0.5),
          m.floors * FLOOR_H + 0.16,
          pz(m.y + m.h / 2 - 0.5),
        );
        scene.add(logo);
      }

      // Two fascia signs, one on each elevation the camera can see. Bounded by
      // the wall they are mounted to, so they cannot overhang the block.
      const top = m.floors * FLOOR_H;
      const hex = `#${new THREE.Color(hue).getHexString()}`;
      const cxm = px(m.x + m.w / 2 - 0.5);
      const czm = pz(m.y + m.h / 2 - 0.5);
      // Mount the sign on the BASE tier's wall, not at a fixed fraction of the
      // building's total height.
      //
      // Terraces and towers step BACK as they rise, so a sign sized to the base
      // footprint but hung at 74% of the full height floats out past the tier
      // above it and buries itself in the setback — which is exactly what
      // happened to xAI. The base tier is the only wall guaranteed to be as
      // wide as the footprint the sign was sized from.
      const TIERS: Record<string, number> = { terrace: 3, tower: 3, garage: 1 };
      const tiers = TIERS[m.style] ?? 1;
      const baseTierTop = top / tiers;
      const signY = Math.min(top * 0.74, baseTierTop * 0.62);
      // A ring has no flat elevation to sign, and its footprint is a DIAMETER
      // rather than a wall — sizing to it produced a board wider than the
      // building that sliced straight through the courtyard. Half the diameter
      // sits on the curve without spanning it.
      // 0.78 of the diameter, not 0.5. Half was cautious to the point of being
      // apologetic — the arena is the biggest building on the block and had the
      // smallest sign on it. The board is mounted tangent to the outer edge, so
      // it can be most of the width without crossing the courtyard.
      const wallOf = (d: number) => (m.style === 'ring' ? d * 0.78 : d);
      for (const face of ['z', 'x'] as const) {
        const sign = fasciaSign(m.name!, hex, wallOf(face === 'z' ? m.w : m.h));
        sign.position.set(
          cxm + (face === 'x' ? m.w / 2 + 0.16 : 0),
          signY,
          czm + (face === 'z' ? m.h / 2 + 0.16 : 0),
        );
        if (face === 'x') sign.rotation.y = Math.PI / 2;
        scene.add(sign);
      }

      // Balloons on a few of them only. One over every campus reads as bunting.
      // Y Combinator is skipped because it gets its own, larger one above —
      // it was landing in this bucket as well and wearing two.
      if (i % 3 === 0 && m.name !== 'Y Combinator') {
        const bal = balloon(m.name!, hue);
        // Turned to the camera's azimuth: the label sits on the balloon's +z
        // face, which points away from a viewer on the +x/+z diagonal, so
        // unturned they were just coloured spheres.
        bal.rotation.y = Math.PI / 4;
        bal.position.set(px(m.x - 3), m.floors * FLOOR_H, pz(m.y + m.h + 4));
        scene.add(bal);
      }
      if (i % 3 === 1) {
        const ds = discSign(m.name!, hue);
        ds.position.set(px(m.x + m.w + 3), 0.1, pz(m.y + m.h + 2));
        ds.rotation.y = Math.PI / 4;
        scene.add(ds);
      }
    });

    // --- the smooth red letterforms ------------------------------------------
    // One extruded mesh per word, built from the font's real contours. The
    // buildings beneath are rasterised to the tile grid — necessary, since a
    // building occupies whole tiles — and a grid can only approximate a curve,
    // which is why capping each box individually produced a staircase. The
    // part you read is a true outline; the massing under it stays on the grid.
    type Outline = { outer: number[][]; holes: number[][][] };
    const SKIRT = LETTER_FLOORS_H * 0.62;
    for (const word of city.letterOutlines as { shapes: Outline[] }[]) {
      for (const sh of word.shapes) {
        if (sh.outer.length < 3) continue;
        // Shape lives in XY; after the -90 rotation its Y becomes -Z, hence the
        // negated pz() — get this wrong and the words land mirrored in depth.
        const shape = new THREE.Shape(
          sh.outer.map(([tx, ty]) => new THREE.Vector2(px(tx), -pz(ty))));
        for (const hole of sh.holes) {
          if (hole.length < 3) continue;
          shape.holes.push(new THREE.Path(
            hole.map(([tx, ty]) => new THREE.Vector2(px(tx), -pz(ty)))));
        }
        const geo = new THREE.ExtrudeGeometry(shape, {
          depth: LETTER_FLOORS_H - SKIRT, bevelEnabled: false,
        });
        geo.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(geo, [
          new THREE.MeshLambertMaterial({ color: 0xe5402c }),   // caps
          new THREE.MeshLambertMaterial({ color: 0xb02a1b }),   // walls
        ]);
        mesh.position.y = SKIRT;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        scene.add(mesh);
      }
    }

    // No overlay banner any more: the words are BUILDINGS, generated as
    // letter-shaped footprints in author.py and drawn by the 'letter' style.
    // Every version that laid type over a roof read as a decal — the massing
    // has to spell the word.

    const bridge = goldenGate(BAY_X + 6);
    bridge.position.set(px(BAY_X * 0.5), 0, pz(BRIDGE_Y));
    scene.add(bridge);

    // The blimp is gone. It drifted over the letters and, being a big pale
    // ellipsoid against red type, it read as a hole punched in the word.
    // Nothing that moves belongs in the airspace above the sign.

    // Shipyard cranes along the Dogpatch waterfront. Placed here rather than
    // by the generator because they need to sit ON the shoreline, and the
    // block fitter has no concept of which edge faces water.
    for (const cy of [BRIDGE_Y + 20, BRIDGE_Y + 38, BRIDGE_Y + 56, BRIDGE_Y + 74]) {
      const crane = gantryCrane();
      crane.position.set(px(BAY_X + 3.5), 0.1, pz(cy));
      scene.add(crane);
    }

    const vs = city.vstreets as [number, number][];
    const hs = city.hstreets as [number, number][];
    const cl = ([p, w]: [number, number]) => p + w / 2;

    // Place names ride on balloons instead of floating DOM text. A label
    // pinned to the screen sits outside the world and never occludes, which is
    // why it read as a UI chrome rather than part of the city; a balloon is an
    // object, so it sits behind buildings when it should.
    // One balloon per district, at the district's own centre, read from the
    // generator. Hand-placed coordinates put FiDI's balloon on top of the
    // sauna's and left three quarters unlabelled entirely.
    const PLACE_HUE = [0xff1f6d, 0xffc400, 0x00e5ff, 0x7cff3f, 0xff7a00];
    const ycMass = masses.find((m) => m.name === 'Y Combinator');
    if (ycMass) {
      const bal = balloon('Y Combinator', 0xfb651e);
      bal.rotation.y = Math.PI / 4;
      bal.scale.setScalar(1.35);
      bal.position.set(
        px(ycMass.x - 4), ycMass.floors * FLOOR_H, pz(ycMass.y + ycMass.h + 5));
      scene.add(bal);
    }

    (city.districts as { name: string; x0: number; y0: number; x1: number; y1: number }[])
      .forEach((d, i) => {
        const bal = balloon(d.name, PLACE_HUE[i % PLACE_HUE.length]);
        bal.rotation.y = Math.PI / 4;
        bal.scale.setScalar(1.3);
        bal.position.set(px((d.x0 + d.x1) / 2), 6, pz((d.y0 + d.y1) / 2));
        scene.add(bal);
      });

    // --- drones and the rooftop party ----------------------------------------
    const drones = named.slice(0, 6).map((m, i) => {
      const d = deliveryDrone();
      d.scale.setScalar(1.5);
      scene.add(d);
      const nxt = named[(i + 1) % named.length];
      return {
        g: d,
        rotors: d.children.filter((c) => c.name === 'rotor'),
        from: [m.x + m.w / 2, m.y + m.h / 2] as [number, number],
        to: [nxt.x + nxt.w / 2, nxt.y + nxt.h / 2] as [number, number],
        y: 16 + i * 2.2,
        phase: i * 0.37,
      };
    });

    // The gathering is at GROUND level, in the garden beside the last letter.
    //
    // It was on the tallest roof, where the parapet and the HVAC boxes hid it
    // completely — from a fixed isometric angle you see almost none of a roof
    // that has anything standing on its edge. A lawn has nothing to hide
    // behind it.
    //
    // The spot is searched for in the ground data rather than hardcoded: find
    // grass with a clear radius near the end of the second word, so it stays a
    // garden if the letters ever move.
    let party: THREE.Group | null = null;
    let partyTile: [number, number] | null = null;
    let botParts: { chest?: THREE.Object3D; armL?: THREE.Object3D; armR?: THREE.Object3D } = {};
    {
      const row2 = (city.letterOutlines as { rect: number[] }[])[1]?.rect ?? [60, 96, 96, 22];
      const target = [row2[0] + row2[2] + 10, row2[1] + row2[3] / 2];
      const clear = (tx: number, ty: number, r: number) => {
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            const x = tx + dx;
            const y = ty + dy;
            if (x < 0 || y < 0 || x >= W || y >= H) return false;
            if (surf[y * W + x] !== 0) return false;     // 0 = grass
          }
        }
        return true;
      };
      let spot: [number, number] | null = null;
      for (let r = 0; r < 60 && !spot; r++) {
        for (let a2 = 0; a2 < 24 && !spot; a2++) {
          const ang = (a2 / 24) * Math.PI * 2;
          const tx = Math.round(target[0] + Math.cos(ang) * r);
          const ty = Math.round(target[1] + Math.sin(ang) * r);
          if (clear(tx, ty, 5)) spot = [tx, ty];
        }
      }
      if (spot) {
        partyTile = spot;
        party = rooftopParty();
        party.position.set(px(spot[0]), 0.12, pz(spot[1]));
        party.rotation.y = Math.PI / 4;
        party.scale.setScalar(1.35);
        scene.add(party);
        botParts = {
          chest: party.getObjectByName('botChest'),
          armL: party.getObjectByName('botArmL'),
          armR: party.getObjectByName('botArmR'),
        };
      }
    }

    // ?at=party or ?at=x,y centres the camera on something. Added because
    // finding a 3-unit scene inside a 256-tile city by screenshotting and
    // hunting for its colour kept locking on to the wrong feature.
    {
      const at = new URLSearchParams(location.search).get('at');
      if (at) {
        const target = at === 'party'
          ? partyTile
          : (at.split(',').map(Number) as [number, number]);
        if (target && Number.isFinite(target[0]) && Number.isFinite(target[1])) {
          controls.target.set(px(target[0]), 2, pz(target[1]));
          cam.zoom = 11;
          cam.updateProjectionMatrix();
          controls.update();
        }
      }
    }

    // --- crossings and signals ----------------------------------------------
    // Zebra bars are geometry laid a hair over the road, not a texture: at this
    // camera angle a decal on the ground plane fights the road for depth, and
    // 2mm of clearance is cheaper than a polygon-offset material.
    const zebraMat = new THREE.MeshLambertMaterial({ color: 0xe8e9e6 });
    const zebraGeo = new THREE.BoxGeometry(1, 0.04, 0.55);
    const bars: THREE.Matrix4[] = [];
    const signalAt: [number, number][] = [];

    for (const [vx, vw] of vs) {
      for (const [hy, hh] of hs) {
        if (vx < BAY_X) continue;                 // no junctions out in the bay
        const cx = vx + vw / 2;
        const cy2 = hy + hh / 2;
        // Four approaches, each a run of bars across the carriageway.
        for (const [ox, oz, rot] of [
          [0, -(hh / 2 + 1.4), 0], [0, hh / 2 + 1.4, 0],
          [-(vw / 2 + 1.4), 0, Math.PI / 2], [vw / 2 + 1.4, 0, Math.PI / 2],
        ] as const) {
          const span = rot === 0 ? vw : hh;
          for (let k = 0; k < Math.max(2, Math.round(span * 1.4)); k++) {
            const t = (k + 0.5) / Math.max(2, Math.round(span * 1.4)) - 0.5;
            const m = new THREE.Matrix4().compose(
              new THREE.Vector3(
                px(cx + ox + (rot === 0 ? t * span : 0)),
                0.13,
                pz(cy2 + oz + (rot === 0 ? 0 : t * span)),
              ),
              new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rot, 0)),
              new THREE.Vector3(0.42, 1, 1),
            );
            bars.push(m);
          }
        }
        signalAt.push([cx, cy2]);
      }
    }
    if (bars.length) {
      const zebra = new THREE.InstancedMesh(zebraGeo, zebraMat, bars.length);
      zebra.receiveShadow = true;
      bars.forEach((m, n) => zebra.setMatrixAt(n, m));
      zebra.instanceMatrix.needsUpdate = true;
      scene.add(zebra);
    }

    // Signals on two opposite corners of each junction, INSTANCED.
    //
    // 63 junctions x 2 corners x 6 parts is 756 separate meshes, and every one
    // of them was a draw call in the colour pass and another in the shadow
    // pass. Built once as a prototype and instanced per part, the same signals
    // cost six draw calls. This was the single biggest thing making it slow.
    {
      const proto = trafficSignal();
      proto.updateMatrixWorld(true);
      const parts: { geo: THREE.BufferGeometry; mat: THREE.Material; local: THREE.Matrix4 }[] = [];
      proto.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if ((mesh as unknown as { isMesh?: boolean }).isMesh) {
          parts.push({
            geo: mesh.geometry,
            mat: mesh.material as THREE.Material,
            local: mesh.matrixWorld.clone(),
          });
        }
      });
      const xf: THREE.Matrix4[] = [];
      for (const [cx, cy2] of signalAt) {
        for (const [sx, sz, rot] of [[-3.2, -3.2, 0], [3.2, 3.2, Math.PI]] as const) {
          xf.push(new THREE.Matrix4().compose(
            new THREE.Vector3(px(cx + sx), 0.1, pz(cy2 + sz)),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rot, 0)),
            new THREE.Vector3(1, 1, 1)));
        }
      }
      const tmp = new THREE.Matrix4();
      for (const part of parts) {
        const im = new THREE.InstancedMesh(part.geo, part.mat, xf.length);
        im.castShadow = false;   // a signal mast casts a shadow nobody can see
        xf.forEach((x, i) => im.setMatrixAt(i, tmp.multiplyMatrices(x, part.local)));
        im.instanceMatrix.needsUpdate = true;
        scene.add(im);
      }
    }

    // --- waymos -------------------------------------------------------------
    // Four, each on its own loop of the grid, offset in phase so they are not
    // a convoy. They ride the right-hand side of the carriageway.
    const waymos = [0, 1, 2, 3].map((k) => {
      const car = waymo();
      // Scaled up like the sauna truck. These are landmarks in the scene, not
      // background traffic — at 1:1 with a parked car nobody can tell what
      // they are, which defeats putting a wordmark on them at all.
      car.scale.setScalar(1.9);
      scene.add(car);
      const i0 = 1 + k * 2;
      const j0 = 1 + (k % 2) * 2;
      const x1 = cl(vs[Math.min(i0, vs.length - 2)]);
      const x2 = cl(vs[Math.min(i0 + 3, vs.length - 1)]);
      const y1 = cl(hs[Math.min(j0, hs.length - 2)]);
      const y2 = cl(hs[Math.min(j0 + 2, hs.length - 1)]);
      const loop: [number, number][] = [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]];
      const legs = loop.slice(1).map(([x, y], n) => Math.hypot(x - loop[n][0], y - loop[n][1]));
      return {
        car, loop, legs,
        len: legs.reduce((a, b) => a + b, 0),
        // DISTANCE ALONG THE LOOP, advanced each frame — not a function of the
        // clock. A vehicle whose position is computed from elapsed time cannot
        // stop for anything, because stopping means not advancing, and there
        // is nothing to not advance.
        s: k * 37,
        lidar: car.getObjectByName('lidar')!,
      };
    });

    // --- the sauna truck ----------------------------------------------------
    // A circuit of arterials it drives forever. Waypoints are in TILES and
    // taken from the street grid in author.py, so it stays on the asphalt
    // rather than cutting across lawns.
    const truck = saunaTruck();
    // Scaled up: at 1:1 with the cars it was the size of a van and the word on
    // its flank was a handful of pixels. It is a landmark, not traffic.
    truck.scale.setScalar(1.7);
    scene.add(truck);
    const smoke = truck.getObjectByName('smoke')!;
    // Route taken from the emitted grid, so it stays on asphalt when the
    // street spacing changes. Each waypoint is the centreline of an artery.
    // A tight circuit around Y Combinator, snapped to the arteries that
    // bracket it, so the truck stays on asphalt whatever the street spacing
    // does. Falls back to the outer ring if YC did not get placed.
    const yc = masses.find((m) => m.name === 'Y Combinator');
    // Pick the two arteries either side of a point, by INDEX, and guarantee
    // they are different. Picking by filter returned the same street twice
    // whenever the point sat outside the run, which collapses the loop to a
    // line — and a truck on a zero-width loop just shuttles back and forth.
    const bracket = (list: [number, number][], v: number) => {
      let i = 0;
      while (i + 1 < list.length && cl(list[i + 1]) < v) i++;
      let lo = i;
      let hi = Math.min(i + 1, list.length - 1);
      if (lo === hi) lo = Math.max(0, hi - 1);
      if (lo === hi) hi = Math.min(list.length - 1, lo + 1);
      return [cl(list[lo]), cl(list[hi])] as const;
    };
    const [xa, xb] = yc
      ? bracket(vs, yc.x + yc.w / 2)
      : [cl(vs[1]), cl(vs[vs.length - 2])];
    const [ya, yb] = yc
      ? bracket(hs, yc.y + yc.h / 2)
      : [cl(hs[1]), cl(hs[hs.length - 2])];
    const ROUTE: [number, number][] = [
      [xa, ya], [xb, ya], [xb, yb], [xa, yb], [xa, ya],
    ];
    // Stop pads at each corner of the circuit. A vehicle an agent can board
    // needs an agreed place to board it; a moving target does not.
    for (const [sx, sy] of ROUTE.slice(0, -1)) {
      const pad = new THREE.Mesh(
        new THREE.CylinderGeometry(2.2, 2.2, 0.07, 20),
        new THREE.MeshLambertMaterial({ color: 0xc9a227 }),
      );
      pad.position.set(px(sx + 3), 0.14, pz(sy + 3));
      scene.add(pad);
    }
    const legLen = ROUTE.slice(1).map(([x, y], k) =>
      Math.hypot(x - ROUTE[k][0], y - ROUTE[k][1]));
    const routeLen = legLen.reduce((a, b) => a + b, 0);


    // --- cars ---------------------------------------------------------------
    // Rooftop solar arrays used to live here. They were tilted slabs sitting
    // proud of the roof, and at this camera angle they read as dark gashes
    // rather than panels — and their shadows were a large part of the mess on
    // the walls below. The roofs keep their HVAC clutter, which is smaller and
    // sits flat.
    //
    // Cars parked along the kerb — read the ground back out of the RLE.
    // Parked cars are gone. At this camera distance a car is about six pixels
    // and reads as a coloured chip, not a vehicle — thousands of them speckled
    // the roads and parking aprons and fought the buildings for attention. The
    // only vehicles left are the ones that move and mean something: the Waymos
    // and the sauna truck.

    // --- trees --------------------------------------------------------------
    const treeTiles = city.trees as [number, number][];
    const canopyGeo = new THREE.IcosahedronGeometry(0.62, 0);
    const canopyMat = new THREE.MeshLambertMaterial({});
    const canopy = new THREE.InstancedMesh(canopyGeo, canopyMat, treeTiles.length);
    canopy.castShadow = true;
    const trunkGeo = new THREE.CylinderGeometry(0.09, 0.12, 0.7, 5);
    const trunk = new THREE.InstancedMesh(
      trunkGeo, new THREE.MeshLambertMaterial({ color: 0x6b4f36 }), treeTiles.length);
    treeTiles.forEach(([x, y], n) => {
      // Deterministic jitter: trees on a perfect lattice look like an orchard.
      const j = ((x * 374761393) ^ (y * 668265263)) >>> 0;
      const jx = ((j % 100) / 100 - 0.5) * 0.5;
      const jz = (((j >> 7) % 100) / 100 - 0.5) * 0.5;
      const s = 0.85 + ((j >> 13) % 100) / 100 * 0.5;
      pos.set(px(x) + jx, 0.62 + 0.42 * s, pz(y) + jz);
      scl.set(s, s * 1.15, s);
      canopy.setMatrixAt(n, m4.compose(pos, q, scl));
      canopy.setColorAt(n, col.setHSL(0.27, 0.34, 0.24 + ((j >> 3) % 100) / 100 * 0.09));
      pos.set(px(x) + jx, 0.35, pz(y) + jz);
      trunk.setMatrixAt(n, m4.compose(pos, q, scl.set(1, 1, 1)));
    });
    canopy.instanceMatrix.needsUpdate = true;
    trunk.instanceMatrix.needsUpdate = true;
    scene.add(canopy, trunk);

    // --- loop ---------------------------------------------------------------
    // District markers float above their quarter. Same projection as the roof
    // labels, but anchored to a point rather than to a building, so they stay
    // put when the generator reshuffles which blocks got built.
    const v = new THREE.Vector3();
    let raf = 0;

    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      // Ortho frustum is symmetric around the target; aspect goes in the sides.
      const a = w / h;
      cam.left = -a * VIEW_HALF;
      cam.right = a * VIEW_HALF;
      cam.top = VIEW_HALF;
      cam.bottom = -VIEW_HALF;
      cam.updateProjectionMatrix();
      followCam.aspect = a;
      followCam.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    // Elapsed time from the render clock, not Date.now(): it stays in step
    // with the frames actually drawn.
    // --- batch the static city ----------------------------------------------
    // Everything above builds one mesh per wall, roof, deck and sign, which is
    // clear to write and ruinous to draw: 2,245 meshes cost 2,940 draw calls a
    // frame at 212k triangles — a scene that is trivial for the GPU and
    // crippling for the driver. Nothing here moves, so it can be baked.
    //
    // Meshes are grouped by material and merged into one geometry each, with
    // their world transform applied. Anything animated is exempted first, and
    // instanced meshes are already batched by definition.
    {
      const dynamic = new Set<THREE.Object3D>();
      for (const o of [truck, ...waymos.map((w) => w.car), ...drones.map((d) => d.g)]) {
        o.traverse((c) => dynamic.add(c));
      }
      // The gathering animates, so it must not be baked into the static batch.
      party?.traverse((c) => dynamic.add(c));

      scene.updateMatrixWorld(true);
      const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
      const doomed: THREE.Object3D[] = [];
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        const anyMesh = mesh as unknown as { isMesh?: boolean; isInstancedMesh?: boolean };
        if (!anyMesh.isMesh || anyMesh.isInstancedMesh || dynamic.has(o)) return;
        if (Array.isArray(mesh.material)) return;      // multi-material: leave alone
        // Vertex-coloured meshes carry a `color` attribute that the strip
        // below would remove, and without it the material renders black. The
        // ground is the only one, it is already a single mesh, and it has
        // nothing to be merged with — so leave it alone. This turned the whole
        // map black on the first attempt.
        if ((mesh.material as THREE.Material & { vertexColors?: boolean }).vertexColors) return;
        const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
        // Merging needs identical attribute sets; drop anything extra.
        for (const name of Object.keys(geo.attributes)) {
          if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name);
        }
        if (!geo.attributes.uv) {
          const n = geo.attributes.position.count;
          geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
        }
        const list = buckets.get(mesh.material) ?? [];
        list.push(geo);
        buckets.set(mesh.material, list);
        doomed.push(o);
      });
      for (const o of doomed) o.parent?.remove(o);
      let batched = 0;
      for (const [mat, geos] of buckets) {
        const merged = mergeGeometries(geos, false);
        if (!merged) continue;
        const mesh = new THREE.Mesh(merged, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        scene.add(mesh);
        batched++;
        for (const g2 of geos) g2.dispose();
      }
      console.info(`[siliconville] batched ${doomed.length} meshes into ${batched} draws`);
    }

    // Anything that moves must not cast, or its shadow is baked where it
    // happened to be on frame one and stays there forever.
    for (const o of [truck, ...waymos.map((w) => w.car), ...drones.map((d) => d.g)]) {
      o.traverse((c) => {
        (c as THREE.Mesh).castShadow = false;
      });
    }

    // --- residents -----------------------------------------------------------
    // Figures are pooled by agent id and driven from a ref rather than from
    // props, because the scene is built once in this effect and rebuilding it
    // whenever a player takes a step would be absurd. The ref is written by the
    // Convex subscription; this loop just reads whatever is currently in it.
    //
    // Positions arrive per engine step, which is far slower than a frame, so
    // each figure eases toward its target instead of teleporting. The easing is
    // also what makes the walk cycle look like walking rather than sliding.
    const pool = new Map<string, {
      g: THREE.Group;
      cur: THREE.Vector2;
      legL?: THREE.Object3D; legR?: THREE.Object3D;
      armL?: THREE.Object3D; armR?: THREE.Object3D;
    }>();

    const SHIRTS = [0x2f6fb5, 0xd94f3d, 0x4b8b5a, 0xc9a227, 0x8a5cc4, 0x20808d, 0xe07b28];
    const hashOf = (id: string) => {
      let h = 0;
      for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
      return h;
    };

    /**
     * Is anyone standing on the next `range` units of this route?
     *
     * Samples the path forward and asks whether any resident is within `half`
     * tiles of it. Reads the SAME `pool` positions the figures are drawn from,
     * so a vehicle stops for what you can see rather than for where the engine
     * last committed someone — those differ by up to sixteen tiles.
     */
    const pedestrianAhead = (
      from: number,
      at: (d: number) => { x: number; y: number },
      range: number,
      half: number,
    ) => {
      for (let d = 1.5; d <= range; d += 1.5) {
        const p = at(from + d);
        for (const e of pool.values()) {
          if (Math.abs(e.cur.x - p.x) < half && Math.abs(e.cur.y - p.y) < half) return true;
        }
      }
      return false;
    };

    const syncAgents = (dt: number, now: number) => {
      const list = agentsRef?.current ?? [];
      const seen = new Set<string>();
      for (const a of list) {
        seen.add(a.id);
        let e = pool.get(a.id);
        if (!e) {
          const h = hashOf(a.id);
          const hue = SHIRTS[h % SHIRTS.length];
          const g2 = person(hue, h);
          // 1.35 made a resident about six pixels tall at the default zoom —
          // present in the scene, invisible on screen, which is why the city
          // looked empty while 32 of them were walking around it.
          g2.scale.setScalar(2.1);

          // A marker above the head, because scale alone cannot fix this: the
          // whole city is 256 units across and a person is one. The pin is a
          // fixed, unlit, brand-coloured shape that stays findable at any zoom
          // — it is how you spot a resident, and the figure is what you look at
          // once you have.
          const pin = new THREE.Group();
          const cone = new THREE.Mesh(
            new THREE.ConeGeometry(0.42, 0.9, 8),
            new THREE.MeshBasicMaterial({ color: hue }),
          );
          cone.rotation.x = Math.PI;          // point down, at the head
          cone.position.y = 2.5;
          pin.add(cone);
          const ball = new THREE.Mesh(
            new THREE.SphereGeometry(0.3, 10, 8),
            new THREE.MeshBasicMaterial({ color: hue }),
          );
          ball.position.y = 3.15;
          pin.add(ball);
          pin.name = 'pin';
          g2.add(pin);

          scene.add(g2);
          e = {
            g: g2,
            cur: new THREE.Vector2(a.x, a.y),
            legL: g2.getObjectByName('legL'),
            legR: g2.getObjectByName('legR'),
            armL: g2.getObjectByName('armL'),
            armR: g2.getObjectByName('armR'),
          };
          pool.set(a.id, e);
        }
        const prevX = e.cur.x;
        const prevY = e.cur.y;

        // ONE way of moving, always: walk toward the committed position.
        //
        // Interpolating the server's sample buffer was the other half of a
        // two-mode system, and the modes disagreed. HistoryManager.query only
        // prunes when it finds a sample NEWER than the playback clock; once the
        // clock runs past the newest sample it returns the last known value
        // forever. The figure freezes at a stale point while the agent keeps
        // moving, then jumps when fresh samples land — which is exactly
        // "walks normally for a while, then judders". Switching between a
        // lagging interpolated position and a current committed one made every
        // handover a jump in one direction or the other.
        //
        // Only 1 in 20 residents even had a buffer, so this path was carrying
        // almost all the motion anyway. Doing it uniformly costs a little
        // trailing under fast movement and cannot judder, because there is
        // nothing to switch between.
        const dx = a.x - e.cur.x;
        const dy = a.y - e.cur.y;
        const gap = Math.hypot(dx, dy);
        if (gap > 30) {
          // Spawned, or evacuated out of a wall. Not a step.
          e.cur.set(a.x, a.y);
        } else if (gap > 0.02) {
          // Speed rises with the gap so a fast mover is caught rather than
          // trailed further each step, but never so fast that it reads as a
          // teleport. Floored so slow corrections still look like walking.
          const speed = Math.min(12, Math.max(2, gap * 1.5));
          const step = Math.min(gap, speed * dt);
          e.cur.x += (dx / gap) * step;
          e.cur.y += (dy / gap) * step;
        }
        e.g.position.set(px(e.cur.x), 0.12, pz(e.cur.y));

        const moved = Math.hypot(e.cur.x - prevX, e.cur.y - prevY) / Math.max(dt, 1e-4);
        // Face the way it is actually walking. The committed `facing` is where
        // the agent was pointed at the last step, which after a sixteen-tile
        // jump is rarely the direction the figure is now travelling.
        //
        // atan2(x, z), NOT -atan2(z, x). person() is built facing +Z — its eyes
        // are on the +z face and its legs sit either side of the X axis, so the
        // walk cycle swings them about X, which is forward and back in Z. The
        // vehicles are built facing +X and use the other form; applying theirs
        // here turned every figure ninety degrees, so they walked sideways
        // while their legs swung across their body.
        const vx = e.cur.x - prevX;
        const vy = e.cur.y - prevY;
        if (Math.hypot(vx, vy) > 1e-4) e.g.rotation.y = Math.atan2(vx, vy);
        else if (a.dx || a.dy) e.g.rotation.y = Math.atan2(a.dx, a.dy);
        // Swing the limbs only while actually covering ground; a figure
        // marching on the spot is worse than one standing still.
        // The pin bobs and counter-rotates so it stays readable however the
        // figure is turned.
        const pin = e.g.getObjectByName('pin');
        if (pin) {
          pin.position.y = Math.sin(now * 2 + hashOf(a.id) % 7) * 0.12;
          pin.rotation.y = -e.g.rotation.y;
        }
        const swing = moved > 0.08 ? Math.sin(now * 9) * 0.6 : 0;
        if (e.legL) e.legL.rotation.x = swing;
        if (e.legR) e.legR.rotation.x = -swing;
        if (e.armL) e.armL.rotation.x = -swing * 0.7;
        if (e.armR) e.armR.rotation.x = swing * 0.7;
      }
      for (const [id, e] of pool) {
        if (seen.has(id)) continue;
        scene.remove(e.g);
        e.g.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.geometry) m.geometry.dispose();
        });
        pool.delete(id);
      }
    };

    const clock = new THREE.Clock();
    let lastT = 0;
    let truckS = 0;

    const tick = () => {
      controls.update();

      // Frame timing first: everything below moves something by dt, and the
      // truck reads it thirty lines before the old definition site.
      //
      // dt from successive elapsed times, NOT clock.getDelta(). getElapsedTime
      // calls getDelta internally, so a getDelta right after it returns ~0 —
      // the step would be zero and nothing would ever move.
      const t2 = clock.getElapsedTime();
      const dt = Math.min(0.1, t2 - lastT);
      lastT = t2;

      // Same treatment as the Waymos: distance along the circuit, advanced
      // only when the road ahead is clear.
      const truckAt = (dist: number) => {
        const t = ((dist % routeLen) + routeLen) % routeLen;
        let acc = 0;
        let leg = 0;
        while (leg < legLen.length - 1 && acc + legLen[leg] < t) acc += legLen[leg++];
        const f = (t - acc) / legLen[leg];
        const [ax, ay] = ROUTE[leg];
        const [bx2, by2] = ROUTE[leg + 1];
        return {
          x: ax + (bx2 - ax) * f,
          y: ay + (by2 - ay) * f,
          hx: bx2 - ax,
          hy: by2 - ay,
        };
      };
      // A wider berth than the cars: it is a lorry, and it is the slowest
      // thing on the map anyway.
      if (!pedestrianAhead(truckS, truckAt, 14, 2.8)) truckS += 6 * dt;
      const tp = truckAt(truckS);
      truck.position.set(px(tp.x), 0.1, pz(tp.y));
      // atan2(dz, dx) because the model faces +x and z is the screen-down axis.
      truck.rotation.y = -Math.atan2(pz(tp.y + tp.hy) - pz(tp.y), px(tp.x + tp.hx) - px(tp.x));
      smoke.position.y = 3.9 + Math.sin(clock.getElapsedTime() * 2.2) * 0.25;

      syncAgents(dt, t2);
      for (const d of drones) {
        // Ping-pong between two campuses, easing at each end so it reads as a
        // delivery run rather than a looping conveyor.
        const u = (Math.sin(t2 * 0.24 + d.phase) + 1) / 2;
        const e = u * u * (3 - 2 * u);
        const tx2 = d.from[0] + (d.to[0] - d.from[0]) * e;
        const ty2 = d.from[1] + (d.to[1] - d.from[1]) * e;
        d.g.position.set(px(tx2), d.y + Math.sin(t2 * 1.4 + d.phase) * 0.5, pz(ty2));
        d.g.rotation.y = -Math.atan2(
          pz(d.to[1]) - pz(d.from[1]), px(d.to[0]) - px(d.from[0])) + (e > 0.5 ? 0 : Math.PI);
        for (const r of d.rotors) r.rotation.z = t2 * 22;
      }
      // Disco. Four things on the same beat, which is what makes it read as
      // dancing rather than as parts moving independently: the whole body
      // turns, the hips counter-rotate against the chest, one arm points up
      // while the other drops, and the whole thing bobs on the off-beat.
      if (party) {
        const beat = t2 * 3.4;
        // The onlookers move too. A crowd of statues around a dancing robot
        // looks worse than no crowd — they nod and shift weight on the same
        // beat, offset per person so they are not a chorus line.
        party.children.forEach((c, i) => {
          if (c.name === 'bot') return;
          const off = i * 1.7;
          c.position.y = Math.abs(Math.sin(beat * 0.5 + off)) * 0.05;
          c.rotation.z = Math.sin(beat * 0.5 + off) * 0.04;
          const aL = c.getObjectByName('armL');
          const aR = c.getObjectByName('armR');
          if (aL) aL.rotation.x = Math.sin(beat * 0.5 + off) * 0.35;
          if (aR) aR.rotation.x = -Math.sin(beat * 0.5 + off) * 0.35;
        });
        party.children.forEach((c) => {
          if (c.name !== 'bot') return;
          c.rotation.y = Math.sin(beat * 0.33) * 0.9;          // turning on the spot
          c.position.y = Math.abs(Math.sin(beat)) * 0.14;      // bob
        });
        if (botParts.chest) botParts.chest.rotation.y = Math.sin(beat) * 0.45;
        // Counter-swing: hips against chest is the whole trick.
        if (botParts.armL) {
          botParts.armL.rotation.z = 0.35 + Math.sin(beat) * 1.5;
          botParts.armL.rotation.x = Math.cos(beat * 0.5) * 0.5;
        }
        if (botParts.armR) {
          botParts.armR.rotation.z = -0.35 + Math.sin(beat + Math.PI) * 1.5;
          botParts.armR.rotation.x = Math.cos(beat * 0.5 + Math.PI) * 0.5;
        }
      }

      for (const wm of waymos) {
        const at = (dist: number) => {
          const tt = ((dist % wm.len) + wm.len) % wm.len;
          let ac = 0;
          let lg = 0;
          while (lg < wm.legs.length - 1 && ac + wm.legs[lg] < tt) ac += wm.legs[lg++];
          const ff = (tt - ac) / wm.legs[lg];
          const [ax2, ay2] = wm.loop[lg];
          const [bx3, by3] = wm.loop[lg + 1];
          return {
            x: ax2 + (bx3 - ax2) * ff,
            y: ay2 + (by3 - ay2) * ff,
            hx: bx3 - ax2,
            hy: by3 - ay2,
          };
        };

        const here = at(wm.s);
        // Look ahead along the route rather than in a circle around the car:
        // a pedestrian level with the door is not in the way, and one twelve
        // tiles back is not either.
        const yields = pedestrianAhead(wm.s, at, 12, 2.2);
        if (!yields) wm.s += 8.5 * dt;

        wm.car.position.set(px(here.x), 0.1, pz(here.y));
        wm.car.rotation.y = -Math.atan2(pz(here.y + here.hy) - pz(here.y), px(here.x + here.hx) - px(here.x));
        // The dome keeps spinning while stopped — that is the whole point of it.
        wm.lidar.rotation.y = t2 * 5;
      }

      // --- shoulder camera ------------------------------------------------
      // Behind and above the figure, aimed at its head. Both the position and
      // the look-at are EASED rather than snapped: a camera welded to a figure
      // that turns on the spot whips around and is unwatchable, and the same
      // engine jumps that make walking look like teleporting would throw the
      // view across the city.
      const followId = followRef?.current ?? null;
      const followed = followId ? pool.get(followId) : undefined;
      let activeCam: THREE.Camera = cam;
      if (!followed && camYawRef) camYawRef.current = NaN;
      if (followed) {
        const yaw = followed.g.rotation.y;
        if (camYawRef) camYawRef.current = yaw;
        const back = 7.5;
        const up = 3.6;
        // person() faces +Z, so "behind" is -Z in its own frame.
        followPos.set(
          followed.g.position.x - Math.sin(yaw) * back,
          up,
          followed.g.position.z - Math.cos(yaw) * back,
        );
        const k = 1 - Math.exp(-dt * 3.5);
        followCam.position.lerp(followPos, k);
        followTarget.lerp(
          new THREE.Vector3(followed.g.position.x, 1.9, followed.g.position.z),
          k,
        );
        followCam.lookAt(followTarget);
        activeCam = followCam;
      }
      controls.enabled = !followed;

      renderer.render(scene, activeCam);
      // Diagnostic handle: renderer.info is the only honest source for draw
      // calls, and guessing at what is slow has already cost a round trip.
      // followRef is exposed too, so the shoulder camera can be exercised
      // without going through a seven-minute interview first.
      (window as unknown as { __sv?: unknown }).__sv = {
        renderer, scene, followRef, pool,
        // Why a figure is or is not interpolating. histTime undefined means we
        // are snapping to committed positions, which looks like teleporting.
        diag: { agents: agentsRef?.current?.length ?? 0 },
      };
      // Project each named roof to screen space so the HTML labels track it.
      const w = host.clientWidth;
      const h = host.clientHeight;
      // No screen-space labels. They sat outside the world, never occluded,
      // and at this density they covered the city they were describing. Place
      // names ride on balloons and tenants on their own hoardings — both are
      // objects, so they go behind a building when they should.
      raf = requestAnimationFrame(tick);
    };
    tick();
    setReady(true);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      scene.traverse((o) => {
        const any = o as unknown as {
          geometry?: THREE.BufferGeometry;
          // Not `THREE.Material`. A mesh's material is a material OR AN ARRAY of
          // them, and the batching pass above deliberately leaves multi-material
          // meshes alone — so arrays are guaranteed to reach this teardown.
          // Calling .dispose() on the array threw, and because this runs in an
          // effect CLEANUP, the throw aborted the unmount: under StrictMode dev
          // mounts, unmounts and remounts, so the remount never happened and the
          // page rendered as a bare grey #root. Production never double-invokes
          // effects, which is why only dev was affected and the built site
          // looked fine.
          material?: THREE.Material | THREE.Material[];
        };
        any.geometry?.dispose();
        const mat = any.material;
        if (Array.isArray(mat)) mat.forEach((m) => m?.dispose());
        else mat?.dispose();
      });
      // Guarded: by the time a cleanup runs twice, or after React has already
      // replaced the host's children, this node may not be a child any more —
      // and an exception here would abort teardown exactly like the one above.
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
    };
  }, []);

  if (!chrome) {
    return <div ref={hostRef} className="relative h-full w-full overflow-hidden" />;
  }

  return (
    <div className="flex h-screen w-full flex-col bg-[#0f1116] text-slate-200">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-700 px-5 py-3">
        <h1 className="text-lg font-semibold tracking-tight">Siliconville</h1>
        <span className="text-xs text-slate-400">
          drag to orbit · right-drag to pan · scroll to zoom
        </span>
        <a href="/siliconville2d" className="ml-auto text-xs text-slate-400 underline">
          2D map
        </a>
      </header>

      <div ref={hostRef} className="relative flex-1 overflow-hidden">
            </div>

      <footer className="border-t border-slate-700 px-5 py-2 text-[11px] leading-relaxed text-slate-400">
        Procedural geometry — boxes and instanced foliage, no modelled assets. Brand marks are
        drawn from the open-source simple-icons glyph set; trademarks belong to their owners and
        this is an homage, not an endorsement or an official map. No agents: this is the map layer
        only.
      </footer>
    </div>
  );
}
