# scripts/shot.mjs

    npx vite preview --port 4321 &
    node scripts/shot.mjs http://localhost:4321/siliconville out.png

Loads a route in headless Chromium, waits for the first frames, screenshots it
and prints any console/page errors.

This exists because `tsc` and `vite build` both pass on a page that renders
nothing. It has already caught two defects that shipped clean builds:

  - the 3D camera framed ~3 world units of a 128-unit city, so the view was
    the underside of three ground tiles;
  - `vertexColors: true` on an InstancedMesh driven by `setColorAt`, which
    makes the shader read a per-vertex colour attribute BoxGeometry does not
    have and renders every instance black.

Neither is visible without looking at the pixels.
