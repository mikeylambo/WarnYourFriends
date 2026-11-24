// Draw-call budget: counts every WebGL draw per frame (all passes) through a Story run with the bot, phone landscape.
// Usage: npm run build && node tools/perf-draws.mjs  (SEED=; prints median / p95 / max draws and the worst moment)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SEED = process.env.SEED ?? '4';
const server = spawn('npx', ['vite', 'preview', '--port', '4186', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 844, height: 390 } });
await page.addInitScript(() => {
  window.__draws = 0;
  for (const C of [WebGL2RenderingContext, WebGLRenderingContext]) {
    for (const f of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
      const o = C.prototype[f];
      if (o) C.prototype[f] = function (...a) { window.__draws++; return o.apply(this, a); };
    }
  }
});
await page.goto(`http://localhost:4186/?seed=${SEED}&bot=1&step=1&mode=run&debug=0`);
await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
const rows = [];
for (let k = 0; k < 80; k++) {
  const r = await page.evaluate(async () => {
    const G = window.__GAME;
    if (!G.sim.live) return null;
    G.step(60 * 4);
    await new Promise((res) => requestAnimationFrame(res));
    window.__draws = 0;
    await new Promise((res) => requestAnimationFrame(res));
    return { t: G.sim.time | 0, draws: window.__draws, pip: !document.getElementById('pip')?.hidden, district: G.sim.track.segmentAt(G.sim.giant.s).district, ramp: G.sim.inRampage };
  });
  if (!r) break;
  rows.push(r);
}
const d = rows.map((r) => r.draws).sort((a, b) => a - b);
const worst = rows.reduce((a, b) => (b.draws > a.draws ? b : a));
console.log(`draws/frame over ${rows.length} samples: median ${d[d.length >> 1]}, p95 ${d[Math.floor(d.length * 0.95)]}, max ${d.at(-1)}; worst ${JSON.stringify(worst)}`);
const pipOn = rows.filter((r) => r.pip).map((r) => r.draws), pipOff = rows.filter((r) => !r.pip).map((r) => r.draws);
console.log(`viewer video on: ${pipOn.length} samples, max ${Math.max(0, ...pipOn)}; off: max ${Math.max(0, ...pipOff)}`);
const by = {};
for (const r of rows) (by[r.district] ??= []).push(r.draws);
console.log('by district (median):', Object.entries(by).map(([k, v]) => `${k}: ${v.sort((a, b) => a - b)[v.length >> 1]}`).join('  '));
await browser.close();
server.kill();
