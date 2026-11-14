// Phase 3 evidence: each ability mid-action from the chopper, the meeting, and the HUD chip.
// Usage: npm run build && node tools/shots-phase3.mjs  (writes docs/evidence/phase3/*.png)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import { spawn } from 'node:child_process';

const OUT = 'docs/evidence/phase3';
const server = spawn('npx', ['vite', 'preview', '--port', '4174', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch();
const URL = 'http://localhost:4174/';
const shots = [
  // [ability, warm-up ticks with the bot, ticks after pressing, file]
  ['leap', 900, 26, 'leap-airborne'],
  ['hijack', 900, 40, 'hijack-ride'],
  ['stare', 900, 14, 'stare'],
  ['pose', 900, 20, 'pose'],
];
for (const [ab, warm, after, file] of shots) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  await page.goto(`${URL}?seed=4&step=1&autostart=1&ability=${ab}&seg=2&cuts=0`);
  await page.waitForFunction(() => window.__GAME && window.__GAME.started, null, { timeout: 15000 });
  const res = await page.evaluate(([warm, after]) => {
    const G = window.__GAME;
    G.setBot(true);
    G.step(warm);
    // Press until it fires (hijack needs a car in reach).
    let fired = false;
    for (let i = 0; i < 600 && !fired; i++) {
      G.step(1, { lane: 0, brake: false, shoulder: false, ability: true });
      fired = G.events.slice(-12).some((e) => e.type === 'ability' && e.ok);
      if (!fired) G.step(4);
    }
    G.setBot(false);
    for (let i = 0; i < after; i++) G.step(1, { lane: 0, brake: false, shoulder: false, ability: false });
    return { fired, ability: G.ability(), t: G.state().time };
  }, [warm, after]);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${file}.png` });
  console.log(file, JSON.stringify(res));
  await page.close();
}
await browser.close();
server.kill();
