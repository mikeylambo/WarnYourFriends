// Spectacle chain evidence: the combo counter mid-chain (multiplier up), a chain banking, a chain dropped.
// Usage: npm run build && node tools/shots-chain.mjs  (writes docs/evidence/chain/*.png)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import { spawn } from 'node:child_process';

const OUT = 'docs/evidence/chain';
mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4178', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
await page.goto('http://localhost:4178/?seed=6&step=1&autostart=1&cuts=0&debug=0&time=night&seg=2');
await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
await page.waitForFunction(() => !window.__GAME.coverage().cold, null, { timeout: 15000 });
await page.evaluate(() => window.__GAME.setBot(true));
/** Step until the in-page condition holds (checked on each tick's fresh events), then screenshot. */
async function until(cond, file, after = 0) {
  const r = await page.evaluate(([c, after]) => {
    const G = window.__GAME;
    const f = new Function('G', 'fresh', `return ${c}`);
    for (let i = 0; i < 60 * 150 && G.sim.live; i++) {
      const last = G.events[G.events.length - 1];
      G.step(1);
      const fresh = G.events.slice(G.events.lastIndexOf(last) + 1);
      if (f(G, fresh)) {
        G.step(after);
        return { t: G.sim.time, chain: { ...G.sim.show.chain }, banked: G.sim.show.banked, ev: fresh.filter((e) => e.type.startsWith('chain')) };
      }
    }
    return null;
  }, [cond, after]);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${file}.png` });
  console.log(file, JSON.stringify(r));
}
await until('G.sim.show.chain.count >= 5', 'mid-chain');
await until("fresh.some((e) => e.type === 'chainEnd' && !e.dropped && e.mult >= 2)", 'banked', 4);
await until("fresh.some((e) => e.type === 'chainEnd' && e.dropped)", 'dropped', 4);
await browser.close();
server.kill();
