// Safe-area check (iPhone with a Dynamic Island, landscape): Chromium has no notch, so every env(safe-area-inset-*)
// in the built CSS is replaced with an iPhone's landscape values (47px left and right, 21px bottom), then every
// visible HUD element is checked to sit inside the safe rectangle through menus, play, the viewer video and the recap.
// Usage: npm run build && node tools/safe-area.mjs   (exit 1 on any element outside)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(process.cwd() + '/package.json');
const { chromium } = require('playwright');
const INSET = { top: 0, right: 47, bottom: 21, left: 47 };
const server = spawn('npx', ['vite', 'preview', '--port', '4210', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const b = await chromium.launch();
let bad = 0;
for (const [w, h, label] of [[844, 390, 'iPhone 14/15'], [932, 430, 'iPhone Pro Max']]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await ctx.addInitScript(() => localStorage.setItem('wyf.settings.v1', JSON.stringify({ autoRampage: false })));
  await ctx.route(/\.css(\?.*)?$/, async (route) => {
    const r = await route.fetch();
    let css = await r.text();
    for (const [side, v] of Object.entries(INSET)) css = css.replaceAll(`env(safe-area-inset-${side})`, `${v}px`);
    await route.fulfill({ response: r, body: css });
  });
  const p = await ctx.newPage();
  const check = async (moment) => {
    const out = await p.evaluate(({ I }) => {
      const sel = ['#live', '#ratings', '#chain', '#gears', '#chyron', '#ticker', '#bug', '#btn-pause', '#btn-cam', '#pip', '#asks', '#abil', '#abil2', '#prompt', '#controls', '#boxed', '#signoff', '#replay', '#menucard', '#ui .slu-panel', '#recap .card', '#recap .rc'];
      const W = innerWidth, H = innerHeight, res = [];
      for (const s of sel) for (const e of document.querySelectorAll(s)) {
        if (!e.checkVisibility?.({ opacityProperty: true, visibilityProperty: true })) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const o = [];
        if (r.left < I.left - 0.5) o.push(`left ${Math.round(r.left)} < ${I.left}`);
        if (r.right > W - I.right + 0.5) o.push(`right ${Math.round(r.right)} > ${W - I.right}`);
        if (r.top < I.top - 0.5) o.push(`top ${Math.round(r.top)}`);
        if (r.bottom > H - I.bottom + 0.5) o.push(`bottom ${Math.round(r.bottom)} > ${H - I.bottom}`);
        res.push({ s, o });
      }
      return res;
    }, { I: INSET });
    const fails = out.filter((x) => x.o.length);
    console.log(`${label} · ${moment}: ${out.length} elements checked${fails.length ? '' : ', all inside the safe area'}`);
    for (const f of fails) { bad++; console.log(`  OUTSIDE ${f.s}: ${f.o.join(', ')}`); }
  };
  await p.goto('http://localhost:4210/?seed=3');
  await p.waitForSelector('[data-choice-id="start"]');
  await p.tap('[data-choice-id="start"]');
  await p.waitForSelector('#ui [data-screen-id="main-menu"]');
  await p.waitForTimeout(600);
  await check('main menu');
  for (const [choice, sel, back] of [['awards', '#recap .awards', '#aw-back'], ['settings', '#ui [data-screen-id="settings"]', '#ui [data-screen-id="settings"] [data-back]'], ['run', '#recap .preshow', '#ps-back']]) {
    await p.tap(`[data-choice-id="${choice}"]`);
    await p.waitForSelector(sel).catch(() => {});
    await p.waitForTimeout(400);
    await check(choice);
    await p.tap(back);
    await p.waitForSelector('#ui [data-screen-id="main-menu"]').catch(() => {});
    await p.waitForTimeout(300);
  }
  await p.goto('http://localhost:4210/?seed=3&autostart=1');
  await p.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
  await p.waitForFunction(() => !window.__GAME.coverage().cold, null, { timeout: 20000 }); // the traffic-cam cold open runs on real time
  await p.evaluate(() => { const G = window.__GAME; G.setBot(true); for (let i = 0; i < 900; i++) G.step(1); });
  await p.waitForTimeout(800);
  await check('play');
  await p.evaluate(() => { const G = window.__GAME; G.viewerVideo(); G.sim.show.decayMult = 0; G.sim.show.ratings = 100; G.step(1); });
  await p.waitForTimeout(600);
  // The viewer video slides in (0.3s): measure where it lands, not mid-slide (a loaded machine caught it in flight).
  await p.waitForFunction(() => !document.getAnimations().some((a) => a.playState === 'running' && a.effect?.target?.id === 'pip'), null, { timeout: 5000 }).catch(() => {});
  await check('viewer video + audience full');
  await p.evaluate(() => { const G = window.__GAME; for (let i = 0; i < 60 * 600 && G.sim.live; i++) G.step(1); });
  await p.waitForFunction(() => !document.getElementById('recap').hidden, null, { timeout: 40000 }).catch(() => {});
  await p.waitForTimeout(800);
  await check('end of broadcast / recap');
  await ctx.close();
}
await b.close();
server.kill();
console.log(bad ? `\n${bad} element(s) outside the safe area` : '\nSafe area OK');
process.exit(bad ? 1 : 0);
