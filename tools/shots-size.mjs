// Giant size evidence: Growth mode at Jog, Stride and Rampage, then the Fixed and Big modes at Rampage,
// all in the Chase High shot at night. Usage: npm run build && node tools/shots-size.mjs  (docs/evidence/size/*.png)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import { spawn } from 'node:child_process';

const OUT = 'docs/evidence/size';
mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4182', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
async function shoot(size, tiers) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  await page.goto(`http://localhost:4182/?seed=4&step=1&autostart=1&cuts=0&debug=0&time=night&size=${size}`);
  await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
  await page.waitForFunction(() => !window.__GAME.coverage().cold, null, { timeout: 15000 });
  for (const tier of tiers) {
    const t = await page.evaluate((want) => {
      const G = window.__GAME;
      G.setBot(true);
      // Reach the gear, then hold it a second so the size has settled.
      let held = 0;
      for (let i = 0; i < 60 * 90 && G.sim.live && held < 60; i++) {
        G.step(1);
        held = G.sim.giant.tier === want ? held + 1 : 0;
      }
      return { tier: G.sim.giant.tier, t: +G.sim.time.toFixed(1), r: G.sim.radius() };
    }, tier);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForTimeout(300);
    const name = `${size}-${['jog', 'stride', 'rampage'][tier]}`;
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(name, JSON.stringify(t));
  }
  await page.close();
}
await shoot('growth', [0, 1, 2]);
await shoot('fixed', [2]);
await shoot('big', [2]);
await browser.close();
server.kill();
