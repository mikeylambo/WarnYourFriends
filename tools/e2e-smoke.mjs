/**
 * E2E smoke against the PRODUCTION build (§41, adapted for Phase 0).
 * By default serves dist/ with `vite preview` (run `npm run build` first; the
 * gates do). Set E2E_URL to run the same checks against a deployed URL:
 *   E2E_URL=https://warn-your-friends.vercel.app/ npm run e2e
 *
 * Checks:
 *   1. Boot: every request succeeds (no 4xx/5xx, no failed loads), no page errors.
 *   2. Start through the SLU Web Shell flow (title → main menu → mode select):
 *      by clicking (desktop), tapping (mobile) and keyboard alone; lane input and
 *      Esc pause work; pause → settings shows the game's settings; quit returns to
 *      the attract broadcast behind the menus.
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
  await page.waitForSelector('#ui [data-screen-id="title"]', { timeout: 15000 }).catch(() => {});
  if (!(await page.isVisible('#ui [data-screen-id="title"]'))) fail(`${label}: shell title screen not visible`);
  if (await page.evaluate(() => window.__GAME.started)) fail(`${label}: started before input`);
  await startAction(page);
  // Software GL renders ~10 fps with the night lights, so allow up to 6s for 0.3s of sim time.
  await page.waitForFunction(() => window.__GAME.started && window.__GAME.state().time > 0.3, null, { timeout: 6000 }).catch(() => {});
  const s = await page.evaluate(() => ({ started: window.__GAME.started, t: window.__GAME.state().time, title: document.querySelector('#ui [data-screen-id]')?.dataset.screenId !== 'gameplay-placeholder' }));
  if (!s.started || s.title) fail(`${label}: start button did not start the run (${JSON.stringify(s)})`);
  else if (!(s.t > 0.3)) fail(`${label}: sim not advancing after start (t=${s.t})`);
  else ok(`${label}: starts the sim (t=${s.t.toFixed(2)}s)`);
  return { ctx, page, problems };
}

try {
  const browser = await chromium.launch({ args: GL_ARGS });

  // 1–2. Desktop: click the real start button.
  {
    const { ctx, page, problems } = await bootAndStart(browser, 'desktop click', { viewport: { width: 1280, height: 720 } }, async (p) => {
      // One menu: the mode is on it. A first broadcast shows How to Play; Go live starts it.
      for (const id of ['start', 'run']) {
        await p.click(`[data-choice-id="${id}"]`);
        await p.waitForTimeout(150);
      }
      await p.waitForSelector('#recap .briefing', { timeout: 3000 }).catch(() => {});
      if (!(await p.isVisible('#recap .briefing'))) fail('How to Play did not show before the first broadcast');
      else ok('How to Play shows before the first broadcast');
      if (await p.evaluate(() => window.__GAME.started)) fail('broadcast started behind How to Play');
      await p.click('#brief-go');
    });
    // Authored SFX: every file decodes once audio is unlocked by the start click.
    await page.waitForFunction(() => Object.keys(window.__GAME.sfx()).length >= 16, null, { timeout: 8000 }).catch(() => {});
    const sfx = await page.evaluate(() => window.__GAME.sfx());
    const takes = Object.values(sfx).reduce((a, b) => a + b, 0);
    if (Object.keys(sfx).length < 16) fail(`sound effects not all loaded (${JSON.stringify(sfx)})`);
    else ok(`sound effects: ${Object.keys(sfx).length} kinds, ${takes} takes decoded`);
    // Spatial mix: right of him on screen pans right, left pans left, far away is quieter.
    const sp = await page.evaluate(() => ({ r: window.__GAME.sfxPlace(10, 0), l: window.__GAME.sfxPlace(-10, 0), far: window.__GAME.sfxPlace(0, 120) }));
    if (!(sp.r.pan > 0.3 && sp.l.pan < -0.3 && sp.far.gain < 0.3 && sp.r.gain > 0.8)) fail(`spatial mix (${JSON.stringify(sp)})`);
    else ok(`spatial mix: right pans ${sp.r.pan.toFixed(2)}, left ${sp.l.pan.toFixed(2)}, 120m ahead at ${(sp.far.gain * 100).toFixed(0)}% level`);
    // The broadcast opens on High Head-On (he runs at the camera), then pivots round into Chase High.
    const openAng = await page.evaluate(() => window.__GAME.cutLog().length ? -1 : window.__GAME.director().current);
    if (openAng !== 4 && openAng !== -1) fail(`broadcast opened on angle ${openAng}, expected High Head-On (4)`);
    await page.waitForFunction(() => window.__GAME.director().current === 0 && !window.__GAME.camera().transition, null, { timeout: 15000 }).catch(() => {});
    const home = await page.evaluate(() => ({ cut: window.__GAME.cutLog()[0], cur: window.__GAME.director().current }));
    if (home.cur !== 0 || !home.cut || home.cut.reason !== 'home') fail(`opening did not swing home to Chase High (${JSON.stringify(home)})`);
    else ok(`opening High Head-On pivots home to Chase High at ${home.cut.t.toFixed(1)}s`);
    // v0.3: A changes lane left (Chase High: screen-left is his left).
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
    const { ctx, problems } = await bootAndStart(browser, 'mobile tap', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, async (p) => {
      for (const id of ['start', 'run']) {
        await p.tap(`[data-choice-id="${id}"]`);
        await p.waitForTimeout(150);
      }
      await p.waitForSelector('#recap .briefing', { timeout: 3000 }).catch(() => {});
      await p.tap('#brief-go');
    });
    if (problems.length) fail(`mobile boot problems:\n    ${problems.join('\n    ')}`);
    await ctx.close();
  }

  // 2b. Keyboard start ("press any key").
  {
    const { ctx } = await bootAndStart(browser, 'keyboard', { viewport: { width: 1280, height: 720 } }, async (p) => {
      // Keyboard only: Enter through the title, the main menu (Full Broadcast) and How to Play (Go live).
      // How to Play ignores input for its first 250ms (no accidental double-press), so give each screen a beat.
      for (let i = 0; i < 3; i++) {
        await p.keyboard.press('Enter');
        await p.waitForTimeout(450);
      }
    });
    await ctx.close();
  }

  // 4. Bot run at 3x: must reach Rampage and smash things.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    const problems = watch(page);
    await page.goto(`${URL}?seed=3&bot=1&timescale=3&debug=1`);
    await page.waitForFunction(() => window.__GAME && window.__GAME.started, null, { timeout: 15000 });
    // Rampage loop: the meter needs ~25s of smashing to fill, so run 45s.
    // 240s: on a software-rendered machine the page manages ~0.6x real time, not the 3x asked for (2026-11-19).
    await page.waitForFunction(() => window.__GAME.state().time > 45, null, { timeout: 240000 });
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
      for (let a = 0; a < 6; a++) {
        // Contrast swings with where he is (in a lamp pool, or between two); one frame between pools isn't the
        // angle's readability. Up to five moments 1s apart (the bot driving), the first that reads counts.
        let r = null;
        for (let k = 0; k < 5 && !r?.pass; k++) {
          if (k) {
            // Let the broadcast roll on a moment (the presentation only follows the sim on live frames).
            await page.evaluate((l) => { window.__GAME.setLook(l); window.__GAME.setAngle(0, 1); window.__GAME.resume(); }, look);
            await page.waitForTimeout(700);
            await page.evaluate(() => window.__GAME.pause());
            await page.waitForTimeout(100);
          }
          await page.evaluate((i) => window.__GAME.setAngle(i, 1), a);
          r = await page.evaluate(() => window.__GAME.silhouette());
        }
        // Diagnostic: the nearest police car (a dark car beside him is in the surround the contrast is measured against).
        const near = await page.evaluate(() => { const G = window.__GAME.sim; let m = Infinity; for (const u of G.pursuit.units) if (u.alive && u.solid) m = Math.min(m, Math.hypot(u.s - G.giant.s, u.d - G.giant.d)); return m; });
        const line = `${look}/${['Chase High', 'Wide Side', 'Long Lens', 'Head-On', 'High Head-On', 'Overhead'][a]}: ${r.heightPx.toFixed(0)}px tall, contrast ${r.contrast.toFixed(2)}:1 (${r.polarity}; giant ${r.giantLuma.toFixed(3)}, surround ${r.surroundLuma.toFixed(3)}), edge ${(r.edgeShare * 100).toFixed(0)}%${near < 12 ? `, police car ${near.toFixed(1)}m away` : ''}`;
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
      if (k.n && (k.min < gt.band[0] - 1e-6 || k.max > gt.band[1] + 1e-6)) fail(`cadence out of band at tier ${t}: ${k.min}–${k.max}`);
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
    await page.goto(`${URL}?seed=5&autostart=1`);
    await page.waitForFunction(() => document.documentElement.dataset.boot === 'ok', null, { timeout: 15000 });
    await page.waitForFunction(() => window.__GAME.state().time > 0.5, null, { timeout: 15000 });
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

  // 7. Phase 2: one full broadcast (150s + grace, LOCKED) in step mode with the bot: pursuers,
  //    Ratings HUD, the sign-off/busted ending, then the 11 O'Clock Recap. No page errors.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    const problems = watch(page);
    await page.goto(`${URL}?seed=2&bot=1&step=1`);
    await page.waitForFunction(() => window.__GAME && window.__GAME.started, null, { timeout: 15000 });
    const mid = await page.evaluate(async () => {
      window.__GAME.step(60 * 90);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // the HUD draws on a frame
      return { show: window.__GAME.show(), score: document.getElementById('score').textContent };
    });
    const end = await page.evaluate(() => {
      window.__GAME.step(60 * 80);
      return window.__GAME.show();
    });
    await page.waitForFunction(() => window.__GAME.recap(), null, { timeout: 15000 }).catch(() => {});
    const recap = await page.evaluate(() => window.__GAME.recap());
    const heads = await page.evaluate(() => window.__GAME.headlines());
    await page.screenshot({ path: 'test-results/e2e-recap.png' });
    if (end.live || end.state === 'live') fail(`segment still live after 170s (${end.state})`);
    else ok(`segment ended: ${end.state}${end.reason ? ' (' + end.reason + ')' : ''}, peak Ratings ${end.peak.toFixed(0)}, banked ${Math.round(end.banked)}`);
    if (mid.score.replace(/\D/g, '') !== String(Math.floor(mid.show.banked))) fail(`HUD score ${mid.score} != banked ${Math.floor(mid.show.banked)}`);
    // Regressions (2026-11-18): the Rampage frame never shows over the recap (it was re-set every frame while he was
    // still in Rampage), and BREAKING on the chyron is red, not paper.
    const rc = await page.evaluate(async () => {
      document.documentElement.classList.add('rampage');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const k = document.querySelector('#chyron .kicker');
      const had = k.classList.contains('breaking');
      k.classList.remove('breaking');
      const plain = getComputedStyle(k).backgroundColor;
      k.classList.add('breaking');
      const breaking = getComputedStyle(k).backgroundColor;
      if (!had) k.classList.remove('breaking');
      return { rampage: document.documentElement.classList.contains('rampage'), plain, breaking };
    });
    if (rc.rampage) fail('the Rampage frame shows over the recap');
    if (rc.breaking !== rc.plain) fail(`BREAKING kicker is ${rc.breaking}, not the kicker red ${rc.plain}`);
    if (!recap?.title) fail('no recap after the broadcast ended');
    else ok(`recap: "${recap.title}" · ${recap.outcome}`);
    // Playtest export: this broadcast is in the log with the sim's own score, and the button exports JSON.
    const logged = await page.evaluate(() => JSON.parse(localStorage.getItem('gal.playlog.v1') ?? '[]').slice(-1)[0] ?? null);
    if (!logged || logged.score !== Math.round(end.banked)) fail(`play log entry missing or wrong (${JSON.stringify(logged)?.slice(0, 120)}, banked ${Math.round(end.banked)})`);
    else ok(`play log: ${logged.outcome}, score ${logged.score}, ${logged.chains.length} chains, asks ${logged.asks.map((a) => a.id + (a.done ? '✓' : '')).join(' ')}`);
    await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
    await page.click('#playdata');
    const copied = await page.waitForFunction(() => window.__copied, null, { timeout: 5000 }).then((h) => h.jsonValue()).catch(() => null);
    const parsed = copied ? JSON.parse(copied) : null;
    if (!parsed?.broadcasts?.length) fail('Copy play data produced no JSON');
    else ok(`Copy play data: ${parsed.broadcasts.length} broadcast(s), ${copied.length} bytes`);
    const last = heads[heads.length - 1];
    if (!last || !['SIGN-OFF', 'BUSTED'].includes(last.kicker)) fail(`last headline isn't the ending (${JSON.stringify(last)})`);
    // Run it again: Enter restarts from the recap.
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const again = await page.evaluate(() => ({ recap: window.__GAME.recap(), live: window.__GAME.show().live, t: window.__GAME.state().time }));
    if (again.recap || !again.live) fail(`Enter on the recap did not start a new broadcast (${JSON.stringify(again)})`);
    else ok('Enter on the recap starts a new broadcast');
    if (problems.length) fail(`full-segment problems:\n    ${problems.join('\n    ')}`);
    await ctx.close();
  }

  // 8. Phase 3: the five-segment run. Segment 1 auto-played by the bot → recap (SEGMENT 1 OF 5)
  //    → Producer's Meeting (3 pitches, keyboard) → buy → segment 2 starts hotter with the upgrade.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    const problems = watch(page);
    await page.goto(`${URL}?seed=11&bot=1&step=1&mode=run`); // a seed the bot clears segment 1 on (seed 10 busts since the dozer)
    await page.waitForFunction(() => window.__GAME && window.__GAME.started, null, { timeout: 15000 });
    await page.evaluate(() => window.__GAME.step(60 * 170));
    await page.waitForFunction(() => window.__GAME.recap(), null, { timeout: 15000 }).catch(() => {});
    const r1 = await page.evaluate(() => ({ run: window.__GAME.run(), kicker: document.querySelector('#recap .kicker')?.textContent }));
    if (r1.run?.phase !== 'meeting') fail(`run: segment 1 should lead to a meeting (${JSON.stringify(r1.run)})`);
    else ok(`run: segment 1 ${r1.run.results[0].cleared ? 'cleared' : 'lost'}, budget ${r1.run.purse} · "${r1.kicker}"`);
    if (!/SEGMENT 1 OF 5/.test(r1.kicker ?? '')) fail(`run: recap kicker lacks the segment (${r1.kicker})`);
    await page.waitForTimeout(400); // a new card ignores accept for 250ms
    await page.keyboard.press('Enter'); // focused: Producer's Meeting
    await page.waitForTimeout(400);
    const pitches = await page.evaluate(() => window.__GAME.meeting());
    await page.screenshot({ path: 'test-results/e2e-meeting.png' });
    // One press opens the meeting; it must not also pick a pitch.
    if (!pitches) fail('run: one Enter opened the meeting and chose on it (double activation)');
    // Regression (2026-11-18): no quotes on the cards; the effect is the copy.
    if (await page.evaluate(() => !!document.querySelector('#recap .pitch q, #recap .pitch .said'))) fail('meeting cards show a quote');
    if (!pitches || pitches.length !== 3) fail(`run: meeting should pitch 3 upgrades (${JSON.stringify(pitches)})`);
    else ok(`run: Producer's Meeting pitches ${pitches.map((p) => p.id + (p.disabled ? ' (over budget)' : '')).join(', ')}`);
    const pick = pitches?.find((p) => !p.disabled)?.id;
    await page.keyboard.press('Enter'); // focused: the first affordable pitch (or Go live)
    await page.waitForTimeout(400);
    // The meeting stays open after a buy (2026-11-17): it's bought and marked, then Go live starts the segment.
    if (pick) {
      const still = await page.evaluate((id) => ({ phase: window.__GAME.run()?.phase, bought: !!document.querySelector(`#recap .pitch.bought[data-id="${id}"]`) }), pick);
      if (still.phase !== 'meeting' || !still.bought) fail(`run: after buying ${pick} the meeting should stay open with it marked (${JSON.stringify(still)})`);
      else ok(`run: bought ${pick}; the meeting stays open`);
      await page.click('#skip');
      await page.waitForTimeout(400);
    }
    const r2 = await page.evaluate(() => ({ run: window.__GAME.run(), show: window.__GAME.show(), recap: window.__GAME.recap(), ability: window.__GAME.ability() }));
    if (r2.run?.segment !== 1 || r2.run.phase !== 'live' || !r2.show.live || r2.recap) fail(`run: segment 2 didn't start (${JSON.stringify(r2.run)})`);
    else ok(`run: segment 2 live at Heat ${r2.show.heat}, owns [${r2.run.owned.join(', ')}]`);
    if (r2.show.heat !== 2) fail(`run: segment 2 should open at Heat 2 (${r2.show.heat})`);
    if (pick && !r2.run?.owned.includes(pick)) fail(`run: bought ${pick} but it isn't owned`);
    if (r2.ability.id && !r2.ability.chip) fail('run: ability equipped but no HUD chip');
    if (problems.length) fail(`run problems:\n    ${problems.join('\n    ')}`);
    await ctx.close();
  }

  // 5b. Camera cuts: Off holds Chase High for the whole run; the pause menu has both new settings.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    await page.goto(`${URL}?seed=3&bot=1&timescale=3&cuts=0`);
    await page.waitForFunction(() => window.__GAME && window.__GAME.started, null, { timeout: 15000 });
    await page.waitForFunction(() => window.__GAME.state().time > 25, null, { timeout: 180000 }); // slow (software-rendered) machines: see above
    const r = await page.evaluate(() => ({ cuts: window.__GAME.cutLog().length, trig: window.__GAME.triggerLog().length, cam: window.__GAME.camera().angle }));
    if (r.cuts !== 0 || r.cam !== 'Chase High') fail(`Camera cuts: Off still cut (${JSON.stringify(r)})`);
    else ok(`Camera cuts: Off holds Chase High (${r.trig} trigger events, 0 cuts)`);
    // Pause → Settings (shell) carries the game's settings; Quit returns to the attract broadcast.
    await page.keyboard.press('Escape');
    await page.waitForSelector('#ui [data-screen-id="pause"]', { timeout: 3000 }).catch(() => {});
    await page.click('[data-choice-id="settings"]');
    await page.waitForTimeout(200);
    // Settings are tabbed (2026-11-18): Game opens; Display holds the camera and look; Audio the shell's volume.
    const visibleIds = () => page.evaluate(() => [...document.querySelectorAll('#ui [data-choice-id]')].filter((e) => !e.hidden).map((e) => e.dataset.choiceId));
    const tabs0 = await visibleIds();
    if (tabs0.slice(0, 4).join('|') !== 'wyf-tab-game|wyf-tab-controls|wyf-tab-display|wyf-tab-audio') fail(`settings tab row missing (${tabs0.join('|')})`);
    if (tabs0.includes('master-down') || tabs0.includes('wyf-cuts')) fail(`Game tab shows other tabs' settings (${tabs0.join('|')})`);
    await page.click('[data-choice-id="wyf-tab-audio"]');
    await page.waitForTimeout(200);
    const audioIds = await visibleIds();
    if (!audioIds.includes('master-down') || audioIds.includes('wyf-auto')) fail(`Audio tab (${audioIds.join('|')})`);
    else ok('settings tabs: Game · Controls · Display · Audio');
    await page.click('[data-choice-id="wyf-tab-display"]');
    await page.waitForTimeout(200);
    const labels = await page.evaluate(() => [...document.querySelectorAll('#ui .slu-choice-label')].filter((e) => !e.closest('[hidden]')).map((e) => e.textContent));
    if (!labels.includes('Camera Cuts: Off') || !labels.includes('LIVE TIME: Off')) fail(`shell settings missing the game's settings (${labels.join(' | ')})`);
    else ok(`shell settings: ${labels.slice(0, 4).join(' · ')}`);
    await page.click('[data-back]');
    await page.waitForTimeout(150);
    await page.click('[data-choice-id="quit"]');
    await page.waitForTimeout(500);
    const q = await page.evaluate(() => ({ screen: document.querySelector('#ui [data-screen-id]')?.dataset.screenId, attract: window.__GAME.attract, started: window.__GAME.started }));
    if (q.screen !== 'main-menu' || !q.attract || q.started) fail(`quit did not return to the menu over the attract broadcast (${JSON.stringify(q)})`);
    else ok('quit to menu: attract broadcast runs behind the main menu');
    // Menus show the chopper shot only: no broadcast HUD, and the modes are on the main menu.
    const m = await page.evaluate(() => ({
      hud: !!document.getElementById('hud')?.checkVisibility?.(),
      asks: !!document.getElementById('asks')?.checkVisibility?.(),
      choices: [...document.querySelectorAll('#ui [data-choice-id]')].map((e) => e.dataset.choiceId).join('|'),
      desc: document.querySelectorAll('#ui [data-screen-id="main-menu"] .slu-choice-desc').length,
    }));
    if (m.desc) fail(`main menu items have subcopy (${m.desc})`); // Mike, 2026-11-18: labels only
    // How to Play from the menu survives the attract broadcast behind it ending and rolling over.
    await page.click('[data-choice-id="howto"]');
    await page.waitForSelector('#recap .briefing', { timeout: 3000 }).catch(() => {});
    const runBefore = await page.evaluate(() => window.__GAME.sim.seed);
    await page.evaluate(() => (window.__GAME.sim.time = 164.9));
    await page.waitForFunction((s) => window.__GAME.sim.seed !== s, runBefore, { timeout: 12000 }).catch(() => {});
    const b = await page.evaluate((s) => ({ rolled: window.__GAME.sim.seed !== s, open: !!document.querySelector('#recap .briefing') && !document.getElementById('recap').hidden }), runBefore);
    if (!b.rolled) fail('attract broadcast did not roll over (test setup)');
    else if (!b.open) fail('How to Play closed when the attract broadcast behind it rolled over');
    else ok('How to Play stays open while the attract broadcast behind it rolls over');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    if (m.hud || m.asks) fail(`broadcast HUD shows behind the menu (${JSON.stringify(m)})`);
    else if (m.choices !== 'run|awards|howto|settings') fail(`main menu choices: ${m.choices}`);
    else ok(`main menu over a clean chopper shot: ${m.choices}`);
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
      title: !!document.querySelector('#ui [data-screen-id]'),
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
