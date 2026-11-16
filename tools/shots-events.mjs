// Traffic event evidence (2026-11-16): the Police Net closing (truck braking ahead, flankers alongside, BOXED IN
// meter), the Rolling Blockade with its armoured truck, and the Car Carrier dropping cars.
// Usage: npm run build && node tools/shots-events.mjs  (writes docs/evidence/events/*.png)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const OUT = 'docs/evidence/events';
mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4183', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const want = Object.fromEntries((process.env.ONLY ?? 'net,rolling,carrier').split(',').map((k) => [k, null]));
for (let seed = 1; seed <= 40 && Object.values(want).some((v) => !v); seed++) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  await page.goto(`http://localhost:4183/?seed=${seed}&seg=3&step=1&autostart=1&cuts=0&debug=0&time=night`);
  await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
  await page.waitForFunction(() => !window.__GAME.coverage().cold, null, { timeout: 15000 });
  for (;;) {
    const hit = await page.evaluate((need) => {
      const G = window.__GAME;
      G.setBot(true);
      for (let i = 0; i < 60 * 160 && G.sim.live; i++) {
        G.step(1);
        const g = G.sim.giant;
        const us = G.sim.pursuit.units.filter((u) => u.alive);
        // Police Net: the box closed (flankers alongside, the truck braking close ahead). Hand over from the bot so it doesn't escape first.
        if (need.includes('net') && us.some((u) => u.unit === 'net' && u.kind === 'armored' && u.phase === 'act' && Math.abs(u.d - g.d) < 1.5 && u.s - g.s < 20) && us.some((u) => u.unit === 'net' && u.ram && Math.abs(u.s - g.s) < 6)) {
          G.setBot(false);
          for (let k = 0; k < 240 && G.sim.show.pin < 45; k++) G.step(1);
          return { kind: 'net', t: G.sim.time, pin: G.sim.show.pin };
        }
        if (need.includes('rolling') && us.some((u) => u.unit === 'rolling' && u.kind === 'armored' && u.phase === 'act' && u.s - g.s < 22 && u.s - g.s > 10)) return { kind: 'rolling', t: G.sim.time };
        if (need.includes('carrier') && us.some((u) => u.unit === 'carrier' && u.phase === 'act' && (u.drops ?? 6) <= 3)) return { kind: 'carrier', t: G.sim.time };
      }
      return null;
    }, Object.keys(want).filter((k) => !want[k]));
    if (!hit) break;
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${hit.kind}.png` });
    want[hit.kind] = hit;
    console.log(`${hit.kind}: seed ${seed} t=${hit.t.toFixed(1)}s${hit.pin !== undefined ? ` pin ${hit.pin.toFixed(0)}` : ''}`);
    if (Object.values(want).every(Boolean)) break;
  }
  await page.close();
}
await browser.close();
server.kill();
const missing = Object.keys(want).filter((k) => !want[k]);
if (missing.length) {
  console.error('missing', missing.join(', '));
  process.exit(1);
}
