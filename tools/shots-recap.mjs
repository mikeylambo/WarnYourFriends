// Recap evidence: the 11 O'Clock Recap after a bot-played broadcast (one through the real replay, so the
// picture is tonight's top moment), single segment and a run segment, desktop and phone. ONLY=, SEED=. Usage: npm run build && node tools/shots-recap.mjs  (writes docs/evidence/recap/*.png)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = process.env.OUT ?? 'docs/evidence/recap';
mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4186', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
for (const [mode, seed] of (process.env.ONLY ? [[process.env.ONLY, Number(process.env.SEED ?? 2)]] : [['replay', 2], ['single', 2], ['run', 11]])) for (const [w, h, name] of [[1280, 720, 'desktop'], [844, 390, 'phone-landscape'], [390, 844, 'phone-portrait']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  // 'replay' plays in real time (×4) so the recap's picture comes from the replay, as a player sees it;
  // the stepped ones end with no replay, so the picture is the last shot.
  const realtime = mode === 'replay';
  await page.goto(`http://localhost:4186/?seed=${seed}&bot=1&autostart=1&cuts=0&debug=0&time=night${realtime ? '&timescale=4' : '&step=1'}${mode === 'run' ? '&mode=run' : ''}`);
  await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
  // Realtime: fast-forward to near the end, then let the ending, the replay and the recap play out.
  await page.evaluate((rt) => window.__GAME.step(60 * (rt ? 150 : 170)), realtime);
  await page.waitForFunction(() => window.__GAME.recap(), null, { timeout: realtime ? 300000 : 30000, polling: 500 });
  await page.waitForTimeout(900);
  if (realtime) await page.waitForFunction(() => window.__GAME.recap()?.clip, null, { timeout: 8000 }).catch(() => console.log("  (no clip: still shown)"));
  if (realtime) { await page.waitForTimeout(1500); console.log("  clip:", await page.evaluate(() => { const v = document.querySelector("#recap .rc-shot video"); return v ? { playing: !v.paused, t: v.currentTime.toFixed(2), dur: v.duration } : null; })); }
  await page.screenshot({ path: `${OUT}/${mode}-${name}.png` });
  console.log(mode, name, JSON.stringify(await page.evaluate(() => window.__GAME.recap())));
  await page.close();
}
await browser.close();
server.kill();
