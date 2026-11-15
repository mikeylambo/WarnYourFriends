// Producer's asks evidence: the asks at the top of a broadcast, an ask landing, the recap list.
// Usage: npm run build && node tools/shots-chain.mjs  (writes docs/evidence/asks/*.png)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import { spawn } from 'node:child_process';

const OUT = 'docs/evidence/asks';
mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4179', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
await page.goto('http://localhost:4179/?seed=6&step=1&autostart=1&cuts=0&debug=0&time=night&seg=2');
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
await until('G.sim.time > 6', 'asks-open');
await until("fresh.some((e) => e.type === 'ask' && e.done)", 'ask-landed', 6);
await page.evaluate(() => { const G = window.__GAME; for (let i = 0; i < 400 && G.sim.live; i++) G.step(30); });
await page.waitForFunction(() => window.__GAME.recap(), null, { timeout: 30000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/recap.png` });
console.log('recap', JSON.stringify(await page.evaluate(() => window.__GAME.sim.asks.list.map((a) => [a.id, a.done]))));
await browser.close();
server.kill();
