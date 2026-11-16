// Sign-off outro evidence: he takes the ramp's road (not the grass) while the chopper swivels to Head-On, then the replay cuts in.
// Usage: npm run build && node tools/shots-signoff.mjs  (writes docs/evidence/signoff/*.png)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = 'docs/evidence/signoff';
require('fs').mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4188', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:4188/?seed=2&bot=1&autostart=1&cuts=0&debug=0&time=night&timescale=4');
await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
await page.waitForFunction(() => !!window.__GAME.show().exit, null, { timeout: 300000, polling: 100 });
await page.evaluate(() => window.__GAME.setTimescale(1));
await page.waitForFunction(() => window.__GAME.show().state === 'cleared', null, { timeout: 60000, polling: 20 });
await page.evaluate(() => window.__GAME.setTimescale(0.25));
for (const [i, ms] of [[0, 300], [1, 1500], [2, 2000], [3, 2500]]) {
  await page.waitForTimeout(ms);
  await page.screenshot({ path: `${OUT}/signoff-${i}.png` });
}
await browser.close();
server.kill();
