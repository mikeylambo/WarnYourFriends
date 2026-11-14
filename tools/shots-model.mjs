// Model pass evidence: the giant in game at each tier from Chase High, a lane change at
// Rampage (cape swing), and the HUD with a PS4 pad (L1 chip, controls strip, card hints).
// Usage: npm run build && node tools/shots-model.mjs  (writes docs/evidence/model/*.png)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const OUT = 'docs/evidence/model';
const server = spawn('npx', ['vite', 'preview', '--port', '4175', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const URL = 'http://localhost:4175/';
// A DualShock 4 as Chrome reports it; R2 held so the game takes it as the active device.
const ds4 = () => {
  const btn = (p) => ({ pressed: p, touched: p, value: p ? 1 : 0 });
  const pad = { id: 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => btn(i === 7)) };
  navigator.getGamepads = () => [pad, null, null, null];
};

async function shot(file, query, ticks, { pad = false, lane = 0 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  if (pad) await page.addInitScript(ds4);
  await page.goto(`${URL}?seed=4&step=1&autostart=1&cuts=0&debug=0&time=night&${query}`);
  await page.waitForFunction(() => window.__GAME && window.__GAME.started, null, { timeout: 15000 });
  const st = await page.evaluate(([ticks, lane]) => {
    const G = window.__GAME;
    if (ticks) {
      G.setBot(true);
      G.step(ticks);
      G.setBot(false);
    }
    G.step(lane ? 1 : 2, { lane, brake: false, shoulder: false, ability: false });
    if (lane) G.step(12, { lane: 0, brake: false, shoulder: false, ability: false });
    return G.state();
  }, [ticks, lane]);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${file}.png` });
  console.log(file, 'tier', st.tier, 'speed', st.speed.toFixed(1), 't', st.time.toFixed(1));
  await page.close();
}

await shot('jog-chase-high', '', 30);
await shot('stride-chase-high', '', 200);
await shot('rampage-chase-high', '', 1150);
await shot('rampage-lane-change', '', 1150, { lane: 1 });
await shot('ps4-hud', 'ability=leap', 60, { pad: true });
// Recap card hints with the pad: run a broadcast out with the bot.
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  await page.addInitScript(ds4);
  await page.goto(`${URL}?seed=4&step=1&autostart=1&cuts=0&time=night`);
  await page.waitForFunction(() => window.__GAME && window.__GAME.started, null, { timeout: 15000 });
  await page.evaluate(() => {
    const G = window.__GAME;
    G.setBot(true);
    for (let i = 0; i < 400 && !G.recap(); i++) G.step(60);
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/ps4-recap.png` });
  console.log('ps4-recap', await page.evaluate(() => document.querySelector('#recap .padhint')?.textContent));
  await page.close();
}
await browser.close();
server.kill();
