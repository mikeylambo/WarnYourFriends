/**
 * Phase 0c evidence: night screenshots from each angle, dusk/day, silhouette
 * numbers, and a cut log from a real-time run. Production build via vite preview
 * (or E2E_URL). Usage: node tools/shots.mjs [outDir]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = process.argv[2] ?? 'docs/evidence/phase0c';
mkdirSync(OUT, { recursive: true });
const REMOTE = process.env.E2E_URL;
const URL = REMOTE ?? 'http://localhost:4174/';
let server = null;
if (!REMOTE) {
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '4174', '--strictPort'], { stdio: 'pipe' });
  await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('4174') && r()));
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const seed = Number(process.env.SEED ?? 5);
await page.goto(`${URL}?seed=${seed}&bot=1&debug=${process.env.DEBUG ?? 0}&reducedmotion=1&cuts=0&at=${process.env.AT ?? 34}`);
await page.waitForFunction(() => window.__GAME?.started);
await page.waitForFunction(() => window.__GAME.state().tier === 2 && window.__GAME.state().time > Number(new URLSearchParams(location.search).get('at') ?? 34), null, { timeout: 90000 });
const shots = [];
const names = ['chase-high', 'wide-side', 'long-lens'];
for (const look of (process.env.LOOKS ?? 'night,dusk,day').split(',')) {
  await page.evaluate((l) => window.__GAME.setLook(l), look);
  for (let a = 0; a < 3; a++) {
    if (look !== 'night' && a > 0 && !process.env.ALL) continue;
    await page.evaluate((i) => window.__GAME.setAngle(i, 1), a);
    await page.waitForTimeout(700);
    const sil = await page.evaluate(() => window.__GAME.silhouette());
    const st = await page.evaluate(() => ({ ...window.__GAME.state(), cam: window.__GAME.camera(), chyron: window.__GAME.chyron() }));
    const file = `${look}-${a + 1}-${names[a]}.png`;
    await page.screenshot({ path: `${OUT}/${file}` });
    shots.push({ file, look, angle: st.cam.angle, tier: st.tier, speed: +st.speed.toFixed(2), screenUp: +st.cam.screenUpDeg.toFixed(2), giantY: +st.cam.giantScreenY.toFixed(3), silhouette: Object.fromEntries(Object.entries(sil).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v])), chyron: st.chyron });
    console.log(file, JSON.stringify(shots.at(-1).silhouette), st.chyron.kicker, '|', st.chyron.text);
  }
}
writeFileSync(`${OUT}/shots.json`, JSON.stringify(shots, null, 2));
if (errors.length) console.log('PAGE ERRORS', errors);
await browser.close();
server?.kill();
