// Fork evidence: the exit sign and ramp on the approach, and the avenue just after the broadcast cuts away.
// Usage: npm run build && node tools/shots-fork.mjs  (writes docs/evidence/fork/*.png)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import { spawn } from 'node:child_process';

const OUT = 'docs/evidence/fork';
mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4180', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
await page.goto(`http://localhost:4180/?seed=${process.env.SEED ?? 3}&step=1&autostart=1&cuts=0&debug=0&time=night`);
await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
await page.waitForFunction(() => !window.__GAME.coverage().cold, null, { timeout: 15000 });
const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
// The bot drives until a fork opens; then the "player" steers into the right lane and holds it.
const opened = await page.evaluate(() => {
  const G = window.__GAME;
  G.setBot(true);
  for (let i = 0; i < 60 * 120 && G.sim.live; i++) {
    G.step(1);
    if (G.sim.fork) return { t: G.sim.time, gore: G.sim.fork.gore - G.sim.giant.s, name: G.sim.fork.name };
  }
  return null;
});
console.log('fork open', JSON.stringify(opened));
if (!opened) process.exit(1);
await page.evaluate(() => window.__GAME.setBot(false));
const steer = () => page.evaluate(() => {
  const G = window.__GAME;
  const g = G.sim.giant;
  const right = G.sim.track.lanesAt(G.sim.fork ? G.sim.fork.gore : g.s) - 1;
  G.step(1, { lane: g.lane < right && !G.sim.laneBusy ? 1 : 0, brake: false, shoulder: false, ability: false });
  return { gap: G.sim.fork ? G.sim.fork.gore - g.s : null, lane: g.lane };
});
let st;
do {
  st = await steer();
  if (st.gap !== null && st.gap > 45) continue;
  await frame();
} while (st.gap !== null && st.gap > 28);
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/approach.png` });
console.log('approach', JSON.stringify(st));
for (let i = 0; i < 600 && (await page.evaluate(() => !!window.__GAME.sim.fork)); i++) {
  await steer();
  await frame();
}
for (let i = 0; i < 40; i++) {
  await page.evaluate(() => window.__GAME.step(1));
  await frame();
}
await page.waitForTimeout(250);
await page.screenshot({ path: `${OUT}/after-cut.png` });
console.log('after', JSON.stringify(await page.evaluate(() => ({ zone: window.__GAME.sim.track.segmentAt(window.__GAME.sim.giant.s).zone, chyron: window.__GAME.chyron(), last: window.__GAME.headlines().slice(-3).map((h) => h.t.toFixed(1) + ' ' + h.text), lanes: window.__GAME.sim.track.lanesAt(window.__GAME.sim.giant.s) }))));
await browser.close();
server.kill();
