// Bridge furniture evidence (Mike, 2026-11-17: "signs outside the bridge are above the empty water"): a merge sign
// and lamps on a bridge stand on the parapet. Usage: npm run build && node tools/shots-bridge.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const OUT = 'docs/evidence/polish';
mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4189', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
try {
  // Seed 5: a bridge run ending in a merge at s=720 (its warning sign stands on the bridge).
  await page.goto('http://localhost:4189/?seed=5&bot=1&autostart=1&cuts=0&time=dusk&timescale=3&god=1');
  await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
  await page.waitForFunction(() => window.__GAME.sim.giant.s > 690, null, { timeout: 180000, polling: 50 });
  await page.screenshot({ path: `${OUT}/bridge-merge-sign.png` });
  console.log('bridge shot at s', await page.evaluate(() => window.__GAME.sim.giant.s.toFixed(0)));
} finally {
  await browser.close();
  server.kill();
}
