// Measure frames-per-second and draw calls on a route.
//   node scripts/fps.mjs http://localhost:4321/siliconville
import { chromium } from 'playwright';
const url = process.argv[2];
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.setDefaultTimeout(120000);
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForTimeout(12000);           // let the scene build
const r = await p.evaluate(() => new Promise((res) => {
  let n = 0;
  const t0 = performance.now();
  const tick = () => { n++; (performance.now() - t0 < 4000) ? requestAnimationFrame(tick) : res({ n, ms: performance.now() - t0 }); };
  requestAnimationFrame(tick);
}));
console.log(`${(r.n / (r.ms / 1000)).toFixed(1)} fps  (${r.n} frames in ${(r.ms/1000).toFixed(1)}s, software GL)`);
await b.close();
