/**
 * E2E smoke against the PRODUCTION build (§41, adapted for Phase 0).
 * By default serves dist/ with `vite preview` (run `npm run build` first; the
 * gates do). Set E2E_URL to run the same checks against a deployed URL:
 *   E2E_URL=https://warn-your-friends.vercel.app/ npm run e2e
 *
 * Checks:
 *   1. Boot: every request succeeds (no 4xx/5xx, no failed loads), no page errors.
 *   2. Start: clicking the real title button (desktop) and tapping it (mobile)
 *      starts the sim; keyboard steering and Esc pause work.
 *   3. Regression (2026-11-10): with WebGL unavailable, the page shows the
 *      "WebGL is switched off" message instead of an inert title.
 *   4. Bot run: reaches Rampage, smashes props, speed floor holds.
 *   5. Phase 0c: night is the default look; event-driven cuts (each cut-away backed
 *      by a Rampage / Heavy / merge trigger, ≥15s apart, none mid-lane-change);
 *      broadcast HUD (LIVE + clock, station bug, chyron from real events);
 *      escort cruisers trailing; silhouette test passes from every angle at
 *      night, dusk and day; Camera cuts: Off holds Chase High; pause menu has the
 *      two new settings.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

// Playwright is resolved from the project or a global install (NODE_PATH), so the
// repo doesn't pin a browser build. Locally: `npm i -D playwright && npx playwright install chromium`.
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('E2E needs Playwright: npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}

const PORT = 4173;
const REMOTE = process.env.E2E_URL;
const URL = REMOTE ?? `http://localhost:${PORT}/`;
mkdirSync('test-results', { recursive: true });

let server = null;
if (!REMOTE) {
  if (!existsSync('dist/index.html')) {
    console.error('E2E runs against the production build: run `npm run build` first.');
    process.exit(1);
  }
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('preview server timeout')), 20000);
    server.stdout.on('data', (d) => {
      if (String(d).includes(String(PORT))) {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

let failed = false;
const fail = (msg) => {
  console.error('E2E FAIL:', msg);
  failed = true;
};
const ok = (msg) => console.log('  ok', msg);

// Software GL so headless Chromium has WebGL (current Chrome no longer falls back to it on its own).
const GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const NO_GL_ARGS = ['--disable-gpu', '--disable-software-rasterizer'];

function watch(page) {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`console.error: ${m.text()}`));
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  page.on('response', (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()}: ${r.url()}`));
  return problems;
}

async function bootAndStart(browser, label, ctxOpts, startAction) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const problems = watch(page);
  await page.goto(`${URL}?seed=5`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.documentElement.dataset.boot, null, { timeout: 15000 });
  const boot = await page.evaluate(() => document.documentElement.dataset.boot);
  if (boot !== 'ok') fail(`${label}: boot=${boot}`);
  if (!(await page.isVisible('#title'))) fail(`${label}: title not visible`);
  if (await page.evaluate(() => window.__GAME.started)) fail(`${label}: started before input`);
  await startAction(page);
  // Software GL renders ~10 fps with the night lights, so allow up to 3s for 0.3s of sim time.
  await page.waitForFunction(() => window.__GAME.started && window.__GAME.state().time > 0.3, null, { timeout: 3000 }).catch(() => {});
  const s = await page.evaluate(() => ({ started: window.__GAME.started, t: window.__GAME.state().time, title: !document.getElementById('title').hidden }));
  if (!s.started || s.title) fail(`${label}: start button did not start the run (${JSON.stringify(s)})`);
  else if (!(s.t > 0.3)) fail(`${label}: sim not advancing after start (t=${s.t})`);
  else ok(`${label}: starts the sim (t=${s.t.toFixed(2)}s)`);
  return { ctx, page, problems };
}

try {
  const browser = await chromium.launch({ args: GL_ARGS });

  // 1–2. Desktop: click the real start button.
  {
    const { ctx, page, problems } = await bootAndStart(browser, 'desktop click', { viewport: { width: 1280, height: 720 } }, (p) => p.click('#start'));
    // v0.3: A changes lane left; D changes lane right.
    const lane0 = await page.evaluate(() => window.__GAME.state().lane);
    await page.keyboard.press('KeyA');
    await page.waitForTimeout(600);
    const s = await page.evaluate(() => window.__GAME.state());
    if (s.lane !== lane0 - 1) fail(`A did not change lane (${lane0} → ${s.lane})`);
    else ok(`A changes lane ${lane0 + 1} → ${s.lane + 1}`);
    if (s.speed < 2) fail(`speed below floor (${s.speed})`);
    await page.keyboard.press('Escape');
    // Pause lands on the next rendered frame; software GL runs ~12 fps, so wait for it (≤1s) rather than a fixed 100ms.
    await page.waitForFunction(() => window.__GAME.paused, null, { timeout: 1000 }).catch(() => {});
    if (!(await page.evaluate(() => window.__GAME.paused))) fail('Esc did not pause');
    else ok('Esc pauses');
    await page.screenshot({ path: 'test-results/e2e-paused.png' });
    if (problems.length) fail(`desktop boot problems:\n    ${problems.join('\n    ')}`);
    else ok('desktop: no failed requests, no page or console errors');
    await ctx.close();
  }

  // 2. Mobile: tap the start button.
  {
    const { ctx, problems } = await bootAndStart(browser, 'mobile tap', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, (p) => p.tap('#start'));
    if (problems.length) fail(`mobile boot problems:\n    ${problems.join('\n    ')}`);
    await ctx.close();
  }

  // 2b. Keyboard start ("press any key").
  {
    const { ctx } = await bootAndStart(browser, 'keyboard', { viewport: { width: 1280, height: 720 } }, (p) => p.keyboard.press('KeyD'));
    await ctx.close();
  }

  // 4. Bot run at 3x: must reach Rampage and smash things.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    const problems = watch(page);
    await page.goto(`${URL}?seed=3&bot=1&timescale=3&debug=1`);
    await page.waitForFunction(() => window.__GAME && window.__GAME.started, null, { timeout: 15000 });
    await page.waitForFunction(() => window.__GAME.state().time > 30, null, { timeout: 60000 });
    // Camera and run cycle, measured inside the running build (v0.3).
    const c = await page.evaluate(() => window.__GAME.camera());
    const gt = await page.evaluate(() => window.__GAME.gait());
    console.log(`  camera: |screen-up| max ${c.maxScreenUp.toFixed(2)}°, giant lowest ${c.maxGiantY.toFixed(3)}, road ahead min ${c.minAhead.toFixed(2)}s, cuts ${c.cuts} (during lane change ${c.cutsDuringLane}, min gap ${c.cuts > 1 ? c.minCutGap.toFixed(2) + 's' : 'n/a'})`);
    console.log(`  run cycle: cadence ${gt.cadence.map((k) => (k.n ? `${k.min.toFixed(2)}–${k.max.toFixed(2)}` : '—')).join(' / ')} steps/s; worst slide ${gt.worstSlide.map((w) => (w * 100).toFixed(2)).join(' / ')} cm; plants ${gt.plants.join('/')}`);
    if (c.maxScreenUp > 35) fail(`screen-up law broken: ${c.maxScreenUp.toFixed(2)}°`);
    if (c.maxGiantY > 0.855) fail(`giant below 85% of the screen (${c.maxGiantY.toFixed(3)})`);
    if (c.minAhead < 2) fail(`under 2s of road ahead (${c.minAhead.toFixed(2)}s)`);
    if (c.cutsDuringLane > 0) fail(`${c.cutsDuringLane} cuts during a lane change`);
    if (c.cuts < 1) fail('no camera cut happened in 30s');
    // Phase 0c: every cut-away backed by a listed trigger; ≥15s apart; never two in a row on the same trigger.
    const cutLog = await page.evaluate(() => window.__GAME.cutLog());
    const trig = await page.evaluate(() => window.__GAME.triggerLog());
    const away = cutLog.filter((k) => k.reason !== 'home');
    console.log(`  cuts: ${cutLog.map((k) => `${k.t.toFixed(1)}s ${k.reason}`).join(', ')}`);
    for (const k of away) {
      if (!['rampage', 'heavy', 'merge'].includes(k.reason)) fail(`cut-away on unknown trigger ${k.reason}`);
      if (!trig.some((x) => x.kind === k.reason && k.t - x.t >= -1e-6 && k.t - x.t <= 1.05)) fail(`cut-away at ${k.t.toFixed(2)}s on '${k.reason}' with no matching event`);
    }
    for (let i = 1; i < away.length; i++) {
      if (away[i].t - away[i - 1].t < 15 - 1e-6) fail(`cut-aways ${(away[i].t - away[i - 1].t).toFixed(2)}s apart`);
      if (away[i].reason === away[i - 1].reason) fail(`two cut-aways in a row on '${away[i].reason}'`);
    }
    if (cutLog.some((k) => k.laneBusy)) fail('a cut happened during a lane change');
    if (cutLog.some((k) => k.reason === 'home' && k.index !== 0)) fail('a return home did not go to Chase High');
    else ok(`cuts: ${away.length} cut-aways, all on listed events, ≥15s apart; ${cutLog.length - away.length} returns to Chase High`);

    // Phase 0c broadcast HUD and escort.
    const hud = await page.evaluate(() => ({
      look: window.__GAME.look(),
      live: getComputedStyle(document.getElementById('hud')).opacity,
      clock: document.getElementById('clock').textContent,
      bug: document.getElementById('bug').textContent,
      chyron: window.__GAME.chyron(),
      headlines: window.__GAME.headlines(),
      escort: window.__GAME.escort(),
    }));
    if (hud.look !== 'night') fail(`default look is ${hud.look}, expected night`);
    if (hud.live !== '1') fail('broadcast HUD not visible during play');
    if (!/^\d+:\d\d$/.test(hud.clock) || hud.clock === '0:00') fail(`LIVE clock not running (${hud.clock})`);
    if (!/WYF/.test(hud.bug)) fail('station bug missing');
    if (!hud.chyron.text?.trim()) fail('chyron empty');
    if (hud.headlines.length < 3) fail(`only ${hud.headlines.length} headlines in 30s`);
    if (hud.headlines.slice(1).some((h) => !h.sources.length)) fail('a headline with no source event');
    console.log(`  headlines: ${hud.headlines.map((h) => `[${h.kicker}] ${h.text}`).join(' · ')}`);
    const active = hud.escort.filter((e) => e.active);
    if (active.length < 2) fail(`only ${active.length} cruisers in the chase after 30s`);
    if (active.some((e) => e.gap < 7 - 1e-6)) fail(`a cruiser closed to ${Math.min(...active.map((e) => e.gap)).toFixed(2)}m`);
    else ok(`escort: ${active.length} cruisers trailing at ${active.map((e) => e.gap.toFixed(1) + 'm').join(', ')}`);

    // Phase 0c silhouette test: every angle at night, dusk and day.
    await page.evaluate(() => window.__GAME.pause());
    for (const look of ['night', 'dusk', 'day']) {
      await page.evaluate((l) => window.__GAME.setLook(l), look);
      for (let a = 0; a < 4; a++) {
        await page.evaluate((i) => window.__GAME.setAngle(i, 1), a);
        const r = await page.evaluate(() => window.__GAME.silhouette());
        const line = `${look}/${['Chase High', 'Wide Side', 'Long Lens', 'Head-On'][a]}: ${r.heightPx.toFixed(0)}px tall, contrast ${r.contrast.toFixed(2)}:1 (${r.polarity}), edge ${(r.edgeShare * 100).toFixed(0)}%`;
        if (!r.pass) fail(`silhouette ${line}`);
        else ok(`silhouette ${line}`);
      }
    }
    await page.evaluate(() => {
      window.__GAME.setLook(null);
      window.__GAME.setAngle(0, 1);
    });
    for (let t = 0; t < 3; t++) {
      const k = gt.cadence[t];
      if (k.n && (k.min < 2.0 - 1e-6 || k.max > 2.3 + 1e-6)) fail(`cadence out of band at tier ${t}: ${k.min}–${k.max}`);
      if (gt.worstSlide[t] >= 0.05) fail(`foot slide ${gt.worstSlide[t]}m at tier ${t}`);
    }
    if (gt.plants[2] < 10) fail('too few Rampage plants measured');
    const s = await page.evaluate(() => window.__GAME.state());
    await page.screenshot({ path: 'test-results/e2e-bot.png' });
    console.log(`  bot: t=${s.time.toFixed(1)}s tier=${s.tier} speed=${s.speed.toFixed(1)} smashes=${s.stats.smashes} rampage=${s.stats.timeAtTier[2].toFixed(1)}s`);
    if (s.stats.timeAtTier[2] <= 0) fail('bot never reached Rampage');
    if (s.stats.smashes + s.stats.knocks <= 0) fail('nothing smashed');
    if (s.stats.minSpeed < 2) fail('speed floor violated');
    if (problems.length) fail(`bot run problems:\n    ${problems.join('\n    ')}`);
    await ctx.close();
  }
  // 6. Head-On cut-away: lane input follows the screen (A = screen-left = his right while he runs
  //    down the screen), and the swoop home lands in Chase High with normal lanes again.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    const problems = watch(page);
    await page.goto(`${URL}?seed=5`);
    await page.waitForFunction(() => document.documentElement.dataset.boot === 'ok', null, { timeout: 15000 });
    await page.click('#start');
    await page.waitForFunction(() => window.__GAME.state().time > 0.5, null, { timeout: 5000 });
    await page.evaluate(() => window.__GAME.setAngle(3, 1));
    await page.waitForFunction(() => window.__GAME.camera().travelDown, null, { timeout: 2000 }).catch(() => {});
    const press = async (key) => {
      const l0 = await page.evaluate(() => window.__GAME.state().lane);
      await page.keyboard.press(key);
      await page.waitForFunction((l) => window.__GAME.state().lane !== l, l0, { timeout: 2000 }).catch(() => {});
      await page.waitForFunction(() => !window.__GAME.state().laneBusy, null, { timeout: 2000 }).catch(() => {});
      return [l0, await page.evaluate(() => window.__GAME.state().lane)];
    };
    const [a0, a1] = await press('KeyA');
    if (a1 !== a0 + 1) fail(`Head-On: A should move him screen-left (his right, lane ${a0 + 1} → ${a0 + 2}), got lane ${a1 + 1}`);
    else ok(`Head-On: A moves him screen-left (lane ${a0 + 1} → ${a1 + 1}, his right)`);
    await page.evaluate(() => window.__GAME.toggleHeadOn());
    const mid = await page.waitForFunction(() => window.__GAME.camera().transition, null, { timeout: 1500 }).then(() => true, () => false);
    await page.waitForFunction(() => !window.__GAME.camera().transition, null, { timeout: 8000 }).catch(() => {});
    const c = await page.evaluate(() => window.__GAME.camera());
    if (!mid) fail('leaving Head-On did not swoop');
    if (c.angle !== 'Chase High' || c.transition || c.travelDown) fail(`swoop did not land in Chase High (${c.angle}, transition ${c.transition})`);
    else ok(`swoop out of Head-On lands in Chase High (travel ${c.screenUpDeg.toFixed(1)}° off screen-up)`);
    const [d0, d1] = await press('KeyA');
    if (d1 !== d0 - 1) fail(`after the swoop A should be lane-left again (${d0 + 1} → ${d0}), got ${d1 + 1}`);
    else ok(`after the swoop A is lane-left again (${d0 + 1} → ${d1 + 1})`);
    if (problems.length) fail(`Head-On problems:\n    ${problems.join('\n    ')}`);
    await ctx.close();
  }

  // 5b. Camera cuts: Off holds Chase High for the whole run; the pause menu has both new settings.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    await page.goto(`${URL}?seed=3&bot=1&timescale=3&cuts=0`);
    await page.waitForFunction(() => window.__GAME && window.__GAME.started, null, { timeout: 15000 });
    await page.waitForFunction(() => window.__GAME.state().time > 25, null, { timeout: 60000 });
    const r = await page.evaluate(() => ({ cuts: window.__GAME.cutLog().length, trig: window.__GAME.triggerLog().length, cam: window.__GAME.camera().angle }));
    if (r.cuts !== 0 || r.cam !== 'Chase High') fail(`Camera cuts: Off still cut (${JSON.stringify(r)})`);
    else ok(`Camera cuts: Off holds Chase High (${r.trig} trigger events, 0 cuts)`);
    await page.keyboard.press('Escape');
    const opts = await page.evaluate(() => ({ cuts: !!document.getElementById('opt-cuts'), live: !!document.getElementById('opt-livetime'), liveChecked: document.getElementById('opt-livetime').checked }));
    if (!opts.cuts || !opts.live) fail('pause menu is missing Camera cuts or LIVE TIME');
    else if (opts.liveChecked) fail('LIVE TIME should default to off');
    else ok('pause menu: Camera cuts and LIVE TIME (default off)');
    await ctx.close();
  }
  await browser.close();

  // 3. Regression: no WebGL → explicit message, never an inert title.
  {
    const noGl = await chromium.launch({ args: NO_GL_ARGS });
    const page = await noGl.newPage({ viewport: { width: 1280, height: 720 } });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.dataset.boot, null, { timeout: 15000 }).catch(() => {});
    const r = await page.evaluate(() => ({
      boot: document.documentElement.dataset.boot,
      fatal: !document.getElementById('fatal').hidden,
      title: !document.getElementById('title').hidden,
      text: document.querySelector('#fatal h2')?.textContent,
    }));
    await page.screenshot({ path: 'test-results/e2e-no-webgl.png' });
    if (r.boot !== 'failed' || !r.fatal || r.title) fail(`no-WebGL: expected the fatal message, got ${JSON.stringify(r)}`);
    else ok(`no-WebGL: shows "${r.text}" instead of an inert title`);
    if (pageErrors.length) fail(`no-WebGL: uncaught page errors: ${pageErrors.join('; ')}`);
    await noGl.close();
  }
} catch (e) {
  fail(e?.stack ?? String(e));
} finally {
  server?.kill();
}
if (failed) process.exit(1);
console.log(`e2e OK (${REMOTE ? REMOTE : 'production build via vite preview'})`);
process.exit(0);
