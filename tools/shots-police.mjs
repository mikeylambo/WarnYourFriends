// Police evidence: the chopper spotlight mid-sweep (tell) and locked on, and a police crash just after impact.
// Usage: npm run build && node tools/shots-police.mjs  (writes docs/evidence/phase3/police-*.png)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import { spawn } from 'node:child_process';

const OUT = 'docs/evidence/phase3';
const server = spawn('npx', ['vite', 'preview', '--port', '4175', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const URL = 'http://localhost:4175/';

/** Play the bot until an event matches, then step `after` ticks and screenshot. */
async function shoot(file, seeds, match, after) {
  for (const seed of seeds) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
    await page.goto(`${URL}?seed=${seed}&step=1&autostart=1&seg=3&cuts=0&debug=0`);
    await page.waitForFunction(() => window.__GAME && window.__GAME.started, null, { timeout: 15000 });
    await page.waitForFunction(() => !window.__GAME.coverage().cold, null, { timeout: 15000 }); // cold open runs on wall-clock time
    const res = await page.evaluate(([match, after]) => {
      const G = window.__GAME;
      G.setBot(true);
      const test = new Function('e', `return ${match}`);
      for (let i = 0; i < 160 * 60; i++) {
        // G.events is a rolling window: take what came after the last event we saw.
        const last = G.events[G.events.length - 1];
        G.step(1);
        const fresh = G.events.slice(G.events.lastIndexOf(last) + 1);
        const hit = fresh.find((e) => test(e));
        if (hit) {
          G.step(after);
          return { hit, t: G.state().time, chyron: G.chyron() };
        }
        if (!G.sim.live) break;
      }
      return null;
    }, [match, after]);
    if (res) {
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${OUT}/${file}.png` });
      console.log(file, `seed ${seed}`, JSON.stringify(res));
      await page.close();
      return;
    }
    await page.close();
  }
  console.log(file, 'NOT FOUND');
}

await shoot('police-chopper-sweep', [4, 7, 11], "e.type === 'tell' && e.kind === 'chopper'", 50);
await shoot('police-chopper-locked', [4, 7, 11], "e.type === 'spotlight'", 40);
await shoot('police-crash', [3, 5, 8, 13, 21, 34, 55, 89, 144], "e.type === 'policeCrash'", 9);
await browser.close();
server.kill();
