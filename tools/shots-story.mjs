// Story evidence: Tonight's Rundown card, the two-way tunnel from the chopper, and the run-end dissolve.
// Usage: npm run build && node tools/shots-story.mjs  (writes docs/evidence/story/*.png; SEED= to vary)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = 'docs/evidence/story';
const SEED = process.env.SEED ?? '7';
mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4183', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
const base = 'http://localhost:4183/?proto=1&cuts=0&debug=0&time=night';

// 1. Tonight's Rundown: menu → Story.
{
  const page = await ctx.newPage();
  await page.goto(base);
  await page.waitForTimeout(2500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  if (!(await page.$('.preshow'))) await page.keyboard.press('Enter'); // title → menu (Story is first)
  await page.waitForSelector('.preshow', { timeout: 10000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/rundown.png` });
  await page.close();
}

// 1b. The Rundown with every ask done and every mod unlocked, on phones (portrait and landscape): Go Live stays reachable.
for (const [name, vp] of [['phone-portrait', { width: 390, height: 844 }], ['phone-landscape', { width: 844, height: 390 }]]) {
  const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(base);
  await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.includes('awards')) ?? 'wyf.awards.v1';
    const p = JSON.parse(localStorage.getItem(k) ?? '{}');
    p.asksDone = ['s-scoops', 's-rampage', 's-rivals', 's-near', 's-bridge', 's-crash', 's-chain', 's-rampsmash', 's-finish', 's-tunnel', 's-units', 's-chopper'];
    p.mods = ['heavyLoad', 'glassJaw'];
    localStorage.setItem(k, JSON.stringify(p));
  });
  await page.reload();
  await page.waitForTimeout(2500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  if (!(await page.$('.preshow'))) await page.keyboard.press('Enter');
  await page.waitForSelector('.preshow', { timeout: 10000 });
  await page.waitForTimeout(400);
  const go = await page.$eval('#ps-go', (b) => { const r = b.getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; });
  console.log(name, 'Go Live on screen:', go);
  await page.screenshot({ path: `${OUT}/rundown-${name}.png` });
  await page.close();
}

if (process.env.ONLY === "rundown") { await browser.close(); server.kill(); process.exit(0); }
// 2. The tunnel: the bot drives until the giant is inside one.
{
  const page = await ctx.newPage();
  await page.goto(`${base}&seed=${SEED}&step=1&autostart=1&mode=endless`);
  await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
  const found = await page.evaluate(() => {
    const G = window.__GAME;
    G.setBot(true);
    for (let i = 0; i < 600 && G.sim.live; i++) {
      G.step(30);
      const seg = G.sim.track.segmentAt(G.sim.giant.s);
      if (seg.zone === 'tunnel' && seg.zoneName) {
        G.step(60 * 2);
        return { t: G.sim.time, name: seg.zoneName };
      }
    }
    return null;
  });
  console.log('tunnel', JSON.stringify(found));
  await page.waitForTimeout(400);
  if (found) await page.screenshot({ path: `${OUT}/tunnel.png` });
  await page.close();
}

// 3. Run-end dissolve: real time from just before the end; time is slowed 10x once the dissolve starts so it can be caught.
{
  const page = await ctx.newPage();
  await page.goto(`${base}&seed=${SEED}&step=1&autostart=1&mode=broadcast`);
  await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
  await page.evaluate(() => {
    const G = window.__GAME;
    G.setBot(true);
    // Run until the end is close (the sim stops being live at sign-off or busted), then hand back to real time.
    const snap = () => G.sim.live;
    let last = 0;
    for (let i = 0; i < 4000 && snap(); i++) { last = G.sim.time; G.step(30); }
    return last;
  });
  // Restart and stop 4 s short of that end, then let it play.
  const end = await page.evaluate(() => window.__GAME.sim.time);
  await page.goto(`${base}&seed=${SEED}&step=1&autostart=1&mode=broadcast`);
  await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
  await page.evaluate((end) => {
    const G = window.__GAME;
    G.setBot(true);
    while (G.sim.time < end - 3) G.step(30);
    const real = performance.now.bind(performance);
    let slowFrom = 0, off = 0;
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n instanceof HTMLCanvasElement && n.style.zIndex === '40' && !slowFrom) { slowFrom = real(); off = slowFrom; }
    }).observe(document.body, { childList: true });
    performance.now = () => (slowFrom ? off + (real() - slowFrom) / 10 : real());
    window.__dissolving = () => !!slowFrom;
    G.setStepMode(false);
  }, end);
  for (let i = 0; i < 40 && !(await page.evaluate(() => window.__dissolving())); i++) {
    await page.waitForTimeout(3000);
    console.log('  waiting', await page.evaluate(() => `t ${window.__GAME.sim.time.toFixed(1)} live ${window.__GAME.sim.live} step ${window.__GAME.flags.stepMode}`));
  }
  for (const [i, ms] of [[1, 2500], [2, 2200], [3, 1500]]) {
    await page.waitForTimeout(ms);
    await page.screenshot({ path: `${OUT}/dissolve-${i}.png` });
  }
  console.log('dissolve captured at end', end.toFixed(1));
  await page.close();
}
await browser.close();
server.kill();
