// Landmark evidence: each set piece (toll plaza, food-truck night, roadworks, rush-hour jam) on approach
// in the chase shot. The bot drives; the run steps until the giant is a few metres short of the first row.
// Usage: npm run build && node tools/shots-landmarks.mjs  (writes docs/evidence/landmarks/*.png)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import { spawn } from 'node:child_process';

const OUT = 'docs/evidence/landmarks';
mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4181', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const want = (process.env.ONLY ?? 'toll,foodtrucks,works,jam').split(',');
const found = {};
for (let seed = Number(process.env.SEED_FROM ?? 1); seed <= 30 && Object.keys(found).length < want.length; seed++) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  await page.goto(`http://localhost:4181/?seed=${seed}&step=1&autostart=1&cuts=0&debug=0&time=night`);
  await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
  await page.waitForFunction(() => !window.__GAME.coverage().cold, null, { timeout: 15000 });
  for (;;) {
    // Step until the first row of a landmark we still need is 14–20m ahead of him.
    const hit = await page.evaluate((need) => {
      const G = window.__GAME;
      G.setBot(true);
      for (let i = 0; i < 60 * 150 && G.sim.live; i++) {
        G.step(1);
        const s = G.sim.giant.s;
        const first = { toll: 22, foodtrucks: 10, works: 6, jam: 6 };
        const seg = G.sim.track.segments.find((x) => x.landmark && need.includes(x.landmark) && x.s0 + first[x.landmark] - s > 14 && x.s0 + first[x.landmark] - s < 20);
        if (seg) return { kind: seg.landmark, name: seg.landmarkName, t: G.sim.time };
      }
      return null;
    }, want.filter((k) => !found[k]));
    if (!hit) break;
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${hit.kind}.png` });
    found[hit.kind] = hit;
    console.log(`${hit.kind}: "${hit.name}" seed ${seed} t=${hit.t.toFixed(1)}s`);
    if (Object.keys(found).length === want.length) break;
  }
  await page.close();
}
await browser.close();
server.kill();
const missing = want.filter((k) => !found[k]);
if (missing.length) {
  console.error('missing', missing.join(', '));
  process.exit(1);
}
