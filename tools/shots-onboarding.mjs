// Onboarding + economy evidence: the recap's producer notes and "added to budget", and the
// meeting's explanation and "need X more". (Producer notes never show over the road.)
// Usage: npm run build && node tools/shots-onboarding.mjs  (writes docs/evidence/onboarding/*.png)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = 'docs/evidence/onboarding';
mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4180', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
await page.goto('http://localhost:4180/?seed=11&step=1&autostart=1&mode=run&cuts=0&debug=0&time=night');
await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
await page.waitForFunction(() => !window.__GAME.coverage().cold, null, { timeout: 15000 });
// Hold Jog in a lane with no input: earns the gear and budget notes for the recap.
await page.evaluate(() => window.__GAME.step(60 * 4.5, { lane: 0, brake: true, shoulder: false, ability: false }));
await page.evaluate(() => window.__GAME.step(30));
// The bot plays the rest of segment 1 → recap → meeting.
await page.evaluate(() => {
  window.__GAME.setBot(true);
  window.__GAME.step(60 * 170);
});
await page.waitForFunction(() => window.__GAME.recap(), null, { timeout: 30000 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/recap.png` });
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/meeting.png` });
console.log(JSON.stringify(await page.evaluate(() => ({ run: window.__GAME.run(), meeting: window.__GAME.meeting() }))).slice(0, 300));
await browser.close();
server.kill();
