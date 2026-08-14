import { chromium } from 'playwright';
const url = process.argv[2], out = process.argv[3];
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
// domcontentloaded, not networkidle: the scene now builds thousands of meshes
// and software WebGL takes long enough that networkidle blew its 30s default
// and threw. The fixed settle below is what actually waits for frames.
p.setDefaultTimeout(120000);
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForTimeout(9000);
// Optional 4th arg: wheel clicks to zoom in, for checking surface detail that
// is invisible in the wide shot.
const zoom = Number(process.argv[4] || 0);
if (zoom) {
  await p.mouse.move(720, 460);
  for (let i = 0; i < zoom; i++) { await p.mouse.wheel(0, -240); await p.waitForTimeout(120); }
  await p.waitForTimeout(1200);
}
// Optional 5th arg: orbit by N pixels before shooting. Z-fighting is only
// visible under camera motion — a static frame is deterministic and looks
// clean even when the surface flickers the moment you move.
const orbit = Number(process.argv[5] || 0);
if (orbit) {
  await p.mouse.move(720, 460);
  await p.mouse.down();
  for (let i = 1; i <= 10; i++) { await p.mouse.move(720 + (orbit * i) / 10, 460); await p.waitForTimeout(40); }
  await p.mouse.up();
  await p.waitForTimeout(900);
}
await p.screenshot({ path: out });
console.log(errs.length ? 'CONSOLE ERRORS:\n' + errs.slice(0,6).join('\n') : 'no console errors');
await b.close();
