// Caught evidence: hold Brake with police behind; the CAUGHT meter fills, he shakes them once, then he's busted.
// Usage: npm run build && node tools/shots-caught.mjs  (writes docs/evidence/caught/*.png)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = 'docs/evidence/caught';
mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4187', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
// Now play it for real, holding Brake from the same point (bot off).
await page.goto('http://localhost:4187/?seed=4&autostart=1&cuts=0&debug=0&time=night&timescale=2');
console.log('loaded');
await page.waitForFunction(() => window.__GAME?.started && window.__GAME.show().units.some((u) => u.unit === 'cruiser'), null, { timeout: 120000, polling: 250 });
console.log('police in the chase');
await page.mouse.click(640, 400).catch(() => {});
await page.keyboard.down('ArrowDown');
let shot = 0;
for (let i = 0; i < 240; i++) {
  await page.waitForTimeout(250);
  const s = await page.evaluate(() => ({ pin: window.__GAME.show().pin, slips: window.__GAME.show().netSlips, state: window.__GAME.show().state, label: document.querySelector('#boxed b')?.textContent, hidden: document.querySelector('#boxed')?.hidden }));
  if (!s.hidden && s.pin > 60 && shot === s.slips) {
    await page.screenshot({ path: `${OUT}/caught-${shot ? 'last-chance' : 'first'}.png` });
    console.log(`shot ${shot}`, s);
    shot++;
  }
  if (s.state !== 'live') { console.log('ended', s); break; }
}
await page.keyboard.up('ArrowDown');
await browser.close();
server.kill();
