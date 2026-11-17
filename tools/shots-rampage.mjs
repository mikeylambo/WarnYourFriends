// Rampage loop evidence (2026-11-17): the opening (High Head-On, then the pivot home), the Rampage meter filling,
// full (the button on it), in Rampage (the tells: hot rim, glowing edges, the swell), and the menus over the cover art. Usage: npm run build && node tools/shots-rampage.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = 'docs/evidence/rampage-loop';
mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4190', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
await page.addInitScript(() => localStorage.setItem('wyf.prompts.v2', '[]'));
await page.goto('http://localhost:4190/?seed=6&step=1&autostart=1&debug=0&time=night');
await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
await page.waitForFunction(() => !window.__GAME.coverage().cold, null, { timeout: 15000 });
const to = (t) => page.evaluate((t) => { const G = window.__GAME; while (G.sim.live && G.sim.time < t) G.step(1, { lane: 0, brake: false, shoulder: false }); }, t);
const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: `${OUT}/${name}.png` }); console.log(name, JSON.stringify(await page.evaluate(() => { const G = window.__GAME; return { t: +G.sim.time.toFixed(2), cam: G.camera().angle, tier: G.sim.giant.tier, meter: Math.round(G.sim.giant.meter), rampT: +G.sim.giant.rampT.toFixed(1) }; }))); };
await to(1.2); await shot('1-opening-high-head-on');
await to(5); await shot('3-opening-home');
await page.evaluate(() => { const G = window.__GAME; G.setBot(true); while (G.sim.live && G.sim.giant.meter < 55) G.step(1); G.setBot(false); });
await shot('4-meter-filling');
await page.evaluate(() => { const G = window.__GAME; G.sim.giant.meter = 100; G.step(1, { lane: 0, brake: false, shoulder: false }); });
await shot('5-meter-ready');
await page.evaluate(() => { const G = window.__GAME; G.step(1, { lane: 0, brake: false, shoulder: true }); G.setBot(true); for (let i = 0; i < 150; i++) G.step(1); });
await page.waitForTimeout(800); // the tells ease in on real frames
await shot('6-in-rampage');
// Menus: the cover art behind the main menu (no live game until Go Live).
await page.close();
const menu = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
await menu.goto('http://localhost:4190/?seed=5');
await menu.waitForSelector('#ui [data-screen-id="title"]', { timeout: 60000 });
await menu.waitForTimeout(800);
await menu.screenshot({ path: `${OUT}/7-title.png` });
await menu.click('[data-choice-id="start"]');
await menu.waitForTimeout(1200);
await menu.screenshot({ path: `${OUT}/8-main-menu-over-art.png` });
console.log('menus done');
await browser.close();
server.kill();
