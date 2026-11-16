// HUD evidence (Direction D in both palettes): desktop mid-chain, and phones, per HUD Colours setting.
// Usage: npm run build && node tools/shots-hud.mjs  (writes docs/evidence/hud/*.png)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import { spawn } from 'node:child_process';

const OUT = 'docs/evidence/hud';
mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4185', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
for (const palette of ['wyf', 'network']) for (const [w, h, dsf, name] of [[1280, 720, 2, 'desktop'], [844, 390, 2, 'phone-landscape'], [390, 844, 2, 'phone-portrait']]) {
  const file = `${palette}-${name}`;
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dsf });
  await page.addInitScript((p) => localStorage.setItem('wyf.settings.v1', JSON.stringify({ hudColors: p, cameraCuts: false })), palette);
  await page.goto('http://localhost:4185/?seed=6&step=1&autostart=1&cuts=0&debug=0&time=night&seg=2');
  await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
  await page.waitForFunction(() => !window.__GAME.coverage().cold, null, { timeout: 15000 });
  const r = await page.evaluate(() => {
    const G = window.__GAME;
    G.setBot(true);
    for (let i = 0; i < 60 * 120 && G.sim.live; i++) {
      G.step(1);
      if (G.sim.time > 30 && G.sim.show.chain.count >= 4) break;
    }
    return { t: G.sim.time, chain: G.sim.show.chain.count };
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${file}.png` });
  console.log(file, JSON.stringify(r));
  await page.close();
}
await browser.close();
server.kill();
