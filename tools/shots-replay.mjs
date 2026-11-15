// Recap REPLAY evidence: the bot plays a broadcast at 8×, then the replay plays at 1× (badge, letterbox,
// slow motion at the moment), then the recap. Usage: npm run build && node tools/shots-replay.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import { spawn } from 'node:child_process';

const OUT = 'docs/evidence/replay';
mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4177', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:4177/?seed=${process.env.SEED ?? 8}&autostart=1&bot=1&cuts=0&debug=0&time=night`);
await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
// Fast-forward the broadcast (direct steps run the same sim and record the same inputs), then let the
// ending, the replay and the recap play in real time.
await page.evaluate(() => { const G = window.__GAME; for (let i = 0; i < 400 && G.sim.live; i++) G.step(30); });
await page.waitForFunction(() => window.__GAME.replay().playing, null, { timeout: 60000, polling: 100 });
const info = await page.evaluate(() => window.__GAME.replay());
console.log('replay', JSON.stringify(info));
let n = 0;
let sawSlow = false;
while (n < 6) {
  const r = await page.evaluate(() => window.__GAME.replay());
  if (!r.playing) break;
  if (r.rate < 1) sawSlow = true;
  // One frame at the lead-in, the rest through the slow motion around the moment.
  if (n === 0 || (r.rate < 1 && n < 5) || (n === 5 && r.t > r.moment.t + 0.6)) {
    await page.screenshot({ path: `${OUT}/replay-${n}.png` });
    console.log('shot', n, JSON.stringify(r));
    n++;
  }
  await page.waitForTimeout(150);
}
await page.waitForFunction(() => !window.__GAME.replay().playing && window.__GAME.recap(), null, { timeout: 60000 });
await page.screenshot({ path: `${OUT}/recap-after.png` });
console.log('recap', JSON.stringify(await page.evaluate(() => window.__GAME.recap())), 'slow-mo seen', sawSlow, 'errors', errors.length);
await browser.close();
server.kill();
