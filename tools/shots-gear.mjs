// Gear-tell evidence: the build-up (last second), the gear-up moment (shockwave, tag, lens punch), Rampage dust.
// Usage: npm run build && node tools/shots-gear.mjs  (writes docs/evidence/gear/*.png)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import { spawn } from 'node:child_process';

const OUT = 'docs/evidence/gear';
mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4176', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
await page.goto('http://localhost:4176/?seed=4&step=1&autostart=1&cuts=0&debug=0&time=night');
await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
await page.waitForFunction(() => !window.__GAME.coverage().cold, null, { timeout: 15000 });
const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
await page.evaluate(() => window.__GAME.setBot(true));
/** Fast-forward (no frames) until `near` holds, then step with frames until `cond`, plus `extra` ticks. */
async function until(near, cond, file, extra = 0) {
  await page.evaluate((c) => { const G = window.__GAME; const f = new Function('G', `return ${c}`); for (let i = 0; i < 60 * 120 && !f(G); i++) G.step(1); }, near);
  for (let i = 0; i < 240; i++) {
    const ok = await page.evaluate((c) => { window.__GAME.step(1); return new Function('G', `return ${c}`)(window.__GAME); }, cond);
    await frame();
    if (ok) break;
  }
  for (let i = 0; i < extra; i++) {
    await page.evaluate(() => window.__GAME.step(1));
    await frame();
  }
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${OUT}/${file}.png` });
  console.log(file, JSON.stringify(await page.evaluate(() => ({ tier: window.__GAME.sim.giant.tier, in: window.__GAME.sim.tierUpIn, t: window.__GAME.sim.time }))));
}
// Stride → Rampage takes 3s at top speed: the clearest build-up.
await until('G.sim.giant.tier === 1 && G.sim.tierUpIn < 1.2', 'G.sim.giant.tier === 1 && G.sim.tierUpIn < 0.3', 'buildup-to-rampage');
await until('G.sim.giant.tier === 1 && G.sim.tierUpIn < 0.1', 'G.sim.giant.tier === 2', 'gearup-rampage', 16);
await until('G.sim.giant.tier === 2 && G.sim.giant.tierTimer > 3', 'true', 'rampage-dust', 40);
await browser.close();
server.kill();
