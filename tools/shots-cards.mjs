// In-engine stand-in card art (2026-11-17), for a new upgrade before its painted card exists. The four Rampage cards
// now have Mike's art, so this writes to test-results/cards/ only. Usage: npm run build && node tools/shots-cards.mjs
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const TMP = 'test-results/cards';
mkdirSync(TMP, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4194', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const HIDE = '#hud, #controls, #tip, #prompt, #camtag, #rampslam, #abil, #touch, #btn-pause, #pip, #debug { display: none !important; }';

async function card(name, { ability = '', angle, setup }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => localStorage.setItem('wyf.prompts.v2', JSON.stringify(['blocked', 'concrete', 'meter', 'ready', 'hit', 'ram', 'rampage', 'audience', 'kite', 'boxed', 'caught', 'exit', 'ability'])));
  await page.goto(`http://localhost:4194/?seed=8&step=1&autostart=1&debug=0&time=night${ability ? `&ability=${ability}&level=3` : ''}`);
  await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
  await page.waitForFunction(() => !window.__GAME.coverage().cold, null, { timeout: 15000 });
  await page.addStyleTag({ content: HIDE });
  await page.evaluate(() => { const G = window.__GAME; G.setBot(true); while (G.sim.time < 20) G.step(1); G.setBot(false); });
  await page.evaluate(setup);
  await page.evaluate((a) => window.__GAME.setAngle(a, 1), angle);
  await page.waitForTimeout(700);
  const y = await page.evaluate(() => window.__GAME.camera().giantScreenY);
  const size = 440;
  const cy = Math.max(size / 2, Math.min(720 - size / 2, y * 720 - 90));
  const png = `${TMP}/${name}.png`;
  await page.screenshot({ path: png, clip: { x: 640 - size / 2, y: cy - size / 2, width: size, height: size } });
  execFileSync('python3', ['-c', `from PIL import Image; Image.open('${png}').convert('RGB').resize((256, 256), Image.LANCZOS).save('${TMP}/${name}.webp', quality=88)`]);
  console.log(name, 'giant y', y.toFixed(2));
  await page.close();
}

const step = (n, inp) => `(() => { const G = window.__GAME; for (let i = 0; i < ${n}; i++) G.step(1${inp ? `, ${inp}` : ''}); })`;
// Shoulder Check: the charge, from the side.
await card('shoulder', { ability: 'shoulder', angle: 1, setup: () => { const G = window.__GAME; G.sim.giant.abilityCd = 0; G.step(1, { lane: 0, brake: false, shoulder: false, ability: true }); for (let i = 0; i < 6; i++) G.step(1); } });
// Overdrive: in Rampage, glowing, low and long.
await card('overdrive', { angle: 2, setup: () => { const G = window.__GAME; G.sim.giant.meter = 100; G.step(1, { lane: 0, brake: false, shoulder: true }); G.setBot(true); for (let i = 0; i < 90; i++) G.step(1); G.setBot(false); } });
// Short Fuse: the build-up just before READY (steps swell), from the chase.
await card('shortFuse', { angle: 0, setup: () => { const G = window.__GAME; G.sim.giant.meter = 96; for (let i = 0; i < 20; i++) G.step(1); } });
// Ground Zero: the moment Rampage fires (shockwave rings), from above.
await card('groundZero', { angle: 5, setup: () => { const G = window.__GAME; G.sim.giant.meter = 100; G.step(1, { lane: 0, brake: false, shoulder: true }); for (let i = 0; i < 8; i++) G.step(1); } });
void step;
await browser.close();
server.kill();
