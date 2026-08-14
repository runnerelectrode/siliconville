// /siliconville — a fork of the front page's world with the park replaced by
// an office park.
//
// It renders through the SAME path as the front page: PixiStaticMap over a
// WorldMap, inside a pixi-viewport. WorldMap is a plain class over a
// serialized object, so this needs no Convex world, no engine, and no agents —
// which is why it costs nothing to run.
//
// The atlas is a procedural blockout (data/siliconville/author.py). Structure
// first: the layout is the thing worth judging, and it is also the thing a
// tileset cannot fix. Real art drops in as a tile-index remap.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Stage, useApp } from '@pixi/react';
import { Viewport } from 'pixi-viewport';
import { useElementSize } from 'usehooks-ts';
import PixiViewport from '../components/PixiViewport.tsx';
import { PixiStaticMap } from '../components/PixiStaticMap.tsx';
import { WorldMap } from '../../convex/aiTown/worldMap.ts';
import * as city from '../../data/siliconville.js';

type Landmark = { name: string; x: number; y: number; w: number; h: number };
type View = { zoom: number; x: number; y: number };

const TILE = city.tiledim as number;

export default function SiliconvilleViewer() {
  const [wrapRef, { width, height }] = useElementSize();
  const viewportRef = useRef<Viewport | undefined>();
  const [labels, setLabels] = useState(true);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });

  const map = useMemo(
    () =>
      new WorldMap({
        width: city.mapwidth,
        height: city.mapheight,
        tileSetUrl: city.tilesetpath,
        tileSetDimX: city.tilesetpxw,
        tileSetDimY: city.tilesetpxh,
        tileDim: TILE,
        bgTiles: city.bgtiles,
        objectTiles: city.objmap,
        animatedSprites: [],
      }),
    [],
  );

  const worldW = map.width * TILE;
  const worldH = map.height * TILE;
  const landmarks = city.landmarks as Landmark[];
  const fitScale = width && height ? Math.min(width / worldW, height / worldH) : 1;

  const sync = useCallback((vp: Viewport) => {
    setView({ zoom: vp.scale.x, x: vp.left, y: vp.top });
  }, []);

  const fitAll = () => {
    const vp = viewportRef.current;
    if (!vp) return;
    vp.setZoom(fitScale * 0.95, true);
    vp.moveCenter(worldW / 2, worldH / 2);
    sync(vp);
  };

  return (
    <div className="flex h-screen w-full flex-col bg-[#12131a] text-slate-200">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-700 px-5 py-3">
        <h1 className="text-lg font-semibold tracking-tight">Siliconville</h1>
        <span className="text-xs text-slate-400">
          {map.width}×{map.height} tiles · {worldW}×{worldH}px · drag to pan, scroll to zoom
        </span>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <span className="tabular-nums text-slate-500">{(view.zoom * 100).toFixed(0)}%</span>
          <button
            onClick={fitAll}
            className="rounded border border-slate-600 px-2 py-1 hover:bg-slate-800"
          >
            Fit city
          </button>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} />
            Labels
          </label>
        </div>
      </header>

      <div ref={wrapRef} className="relative flex-1 overflow-hidden">
        {width > 0 && height > 0 && (
          <>
            <Stage width={width} height={height} options={{ backgroundColor: 0x2b2f24 }}>
              <CityLayer
                map={map}
                width={width}
                height={height}
                worldW={worldW}
                worldH={worldH}
                fitScale={fitScale}
                viewportRef={viewportRef}
                onView={sync}
              />
            </Stage>

            {/* Labels are DOM, not pixel art: legible at every zoom, and they
                survive the tileset swap. */}
            {labels && <LandmarkLabels landmarks={landmarks} view={view} />}
          </>
        )}
      </div>

      <footer className="border-t border-slate-700 px-5 py-2 text-[11px] leading-relaxed text-slate-400">
        Blockout art — placeholder tiles generated in code, pending a city tileset. Company names
        are the show's fictional ones, not real trademarks. No agents yet: this is the map layer
        only, so it runs no engine and costs nothing.
      </footer>
    </div>
  );
}

function CityLayer(props: {
  map: WorldMap;
  width: number;
  height: number;
  worldW: number;
  worldH: number;
  fitScale: number;
  viewportRef: React.MutableRefObject<Viewport | undefined>;
  onView: (vp: Viewport) => void;
}) {
  // useApp() only resolves inside <Stage>, which is why this is a child
  // component rather than inlined above.
  const app = useApp();
  const { viewportRef, onView, worldW, worldH, fitScale } = props;

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    // PixiViewport bakes a clampZoom sized for ai-town's 64x48 map. On a map
    // this much larger the floor clamps ABOVE "fit the whole city", so you can
    // pan but never see what you are panning around. Recompute for this map.
    vp.clampZoom({ minScale: fitScale * 0.9, maxScale: 4 });
    vp.setZoom(fitScale * 1.8, true);
    vp.moveCenter(worldW / 2, worldH * 0.45);
    const on = () => onView(vp);
    vp.on('moved', on).on('zoomed', on);
    on();
    return () => {
      vp.off('moved', on).off('zoomed', on);
    };
  }, [viewportRef, onView, worldW, worldH, fitScale]);

  return (
    <PixiViewport
      app={app}
      screenWidth={props.width}
      screenHeight={props.height}
      worldWidth={worldW}
      worldHeight={worldH}
      viewportRef={viewportRef}
    >
      <PixiStaticMap map={props.map} />
    </PixiViewport>
  );
}

function LandmarkLabels({ landmarks, view }: { landmarks: Landmark[]; view: View }) {
  // Positioned from the viewport's own top-left and scale rather than by
  // querying it, so a label can never render a frame behind the map.
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {landmarks.map((lm) => {
        const left = ((lm.x + lm.w / 2) * TILE - view.x) * view.zoom;
        const top = ((lm.y + lm.h / 2) * TILE - view.y) * view.zoom;
        return (
          <div
            key={lm.name}
            className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white shadow"
            style={{ left, top, opacity: view.zoom < 0.3 ? 0 : 1 }}
          >
            {lm.name}
          </div>
        );
      })}
    </div>
  );
}
