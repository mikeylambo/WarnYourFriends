// Shoulder Check evidence: a filmstrip of the charge from the side (wind-up, drive, recover).
// Usage: npm run build && node tools/shots-shoulder.mjs  (writes docs/evidence/shoulder/*.png)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import { spawn } from 'node:child_process';

const OUT = 'docs/evidence/shoulder';
mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4183', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
await page.goto('http://localhost:4183/?seed=5&step=1&autostart=1&cuts=0&debug=0&time=dusk&angle=1');
await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
await page.waitForFunction(() => !window.__GAME.coverage().cold, null, { timeout: 15000 });
const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
await page.evaluate(() => { const G = window.__GAME; G.setBot(true); G.step(60 * 6); G.setBot(false); });
for (let i = 0; i < 6; i++) { await page.evaluate(() => window.__GAME.step(1)); await frame(); }
const NI = { lane: 0, brake: false, shoulder: false, ability: false };
// Frames at these ticks after the press (60 Hz): before, wind-up, drive, held, recovering, done.
const at = [-1, 3, 8, 14, 22, 32];
let tick = -1;
for (const want of at) {
  while (tick < want) {
    await page.evaluate((s) => window.__GAME.step(1, { lane: 0, brake: false, shoulder: s, ability: false }), tick === -1);
    tick++;
    await frame();
  }
  await page.waitForTimeout(80);
  await page.screenshot({ path: `${OUT}/t${String(Math.max(0, want)).padStart(2, '0')}.png` });
}
void NI;
await browser.close();
server.kill();
