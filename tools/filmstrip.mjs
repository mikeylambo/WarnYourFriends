// Filmstrip of an impact: steps the bot until an event, then captures frames after it.
// Usage: npm run build && node tools/filmstrip.mjs <smash-heavy|smash-medium|bounce|nearMiss> [out.png]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const kind = process.argv[2] ?? 'smash-heavy';
const out = process.argv[3] ?? `docs/evidence/impact/${kind}.png`;
const server = spawn('npx', ['vite', 'preview', '--port', '4176', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
await page.goto(`http://localhost:4176/?seed=${process.env.SEED ?? 4}&step=1&autostart=1&cuts=0&debug=0&time=night`);
await page.waitForFunction(() => window.__GAME?.started);
await page.waitForFunction(() => !window.__GAME.coverage().cold, null, { timeout: 15000 });
const found = await page.evaluate((kind) => {
  const G = window.__GAME;
  // Bounces need a driver who doesn't steer: run straight into whatever comes.
  const manual = kind === 'bounce';
  G.setBot(!manual);
  const [type, cls] = kind.split('-');
  for (let i = 0; i < 60 * 120; i++) {
    G.step(1, manual ? { lane: 0, brake: false, shoulder: false, ability: false } : undefined);
    if (G.events.slice(-4).some((e) => e.type === type && (!cls || e.cls === cls))) return true;
  }
  return false;
}, kind);
if (!found) throw new Error('event not found');
// Then play on in slow motion (sim and presentation together) and stamp each frame with the
// real game time since the event.
const t0 = await page.evaluate(() => {
  const G = window.__GAME;
  G.setTimescale(Number(new URLSearchParams(location.search).get('ts') ?? 0.06));
  G.setStepMode(false);
  return G.state().time;
});
const want = [0, 0.08, 0.16, 0.28, 0.42, 0.6, 0.85, 1.2];
const shots = [];
const frames = [];
for (const w of want) {
  await page.waitForFunction(([t0, w]) => window.__GAME.state().time - t0 >= w, [t0, w], { timeout: 60000 });
  const t = await page.evaluate((t0) => window.__GAME.state().time - t0, t0);
  shots.push(await page.screenshot({ clip: { x: 160, y: 120, width: 640, height: 420 } }));
  frames.push(`+${Math.round(t * 1000)}ms`);
}
const html = `<body style="margin:0;display:grid;grid-template-columns:repeat(4,480px);background:#000">${shots.map((b, i) => `<div style="position:relative"><img style="width:480px" src="data:image/png;base64,${b.toString('base64')}"><span style="position:absolute;left:6px;top:4px;color:#fff;font:bold 14px system-ui;text-shadow:0 0 3px #000">${frames[i]}</span></div>`).join('')}</body>`;
const p2 = await browser.newPage({ viewport: { width: 1920, height: 630 } });
await p2.setContent(html);
await p2.screenshot({ path: out });
await browser.close();
server.kill();
console.log(out);
