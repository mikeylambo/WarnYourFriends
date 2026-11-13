/**
 * Phase 2 evidence: each police tell, each road zone, the coverage ladder and the
 * recap, from the production build (step mode + bot). Usage: node tools/shots-phase2.mjs [outDir]
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const OUT = process.argv[2] ?? 'docs/evidence/phase2';
const srv = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '4181', '--strictPort'], { stdio: 'pipe' });
await new Promise((r) => srv.stdout.on('data', (d) => String(d).includes('4181') && r()));
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errs = [];
async function until(name, seed, pred, settle = 2200) {
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`http://localhost:4181/?seed=${seed}&bot=1&step=1&debug=0&cuts=0&reducedmotion=1`);
  await p.waitForFunction(() => window.__GAME?.started);
  const found = await p.evaluate(`(() => { const G = window.__GAME; for (let k = 0; k < 1300; k++) { G.step(8); const sim = G.sim; if (${pred}) return 't=' + sim.time.toFixed(1); if (!sim.live) return 'ended'; } return 'not found'; })()`);
  await p.waitForTimeout(settle);
  const sil = await p.evaluate(() => window.__GAME.silhouette());
  const chy = await p.evaluate(() => window.__GAME.chyron());
  await p.screenshot({ path: `${OUT}/${name}.png` });
  console.log(name, found, `| ${chy.kicker} · ${chy.text} | silhouette ${sil.pass ? 'pass' : 'FAIL'} ${sil.contrast.toFixed(1)}:1 ${sil.heightPx.toFixed(0)}px`);
  return p;
}
const tell = (k) => `sim.pursuit.units.some((u) => u.unit === '${k}' && (u.phase === 'tell' || (u.unit === 'roadblock' && u.phase === 'act' && u.phaseT < 1.2)) && u.phaseT > 0.3)`;
for (const [n, seed, pred] of [
  ['tell-cruiser-ram', 1, tell('cruiser')],
  ['tell-spike-strip', 1, tell('spike')],
  ['tell-roadblock', 1, tell('roadblock')],
  ['tell-rolling-roadblock', 6, `sim.pursuit.units.some((u) => u.unit === 'rolling' && u.phase !== 'approach' && u.s - sim.giant.s < 30)`],
  ['zone-avenue', 9, `sim.track.segmentAt(sim.giant.s).zone === 'avenue' && sim.giant.s - sim.track.segmentAt(sim.giant.s).s0 > 12`],
  ['zone-bridge', 9, `sim.track.segmentAt(sim.giant.s).zone === 'bridge' && sim.track.segmentAt(sim.giant.s).zoneStart`],
  ['zone-tunnel', 9, `sim.track.segmentAt(sim.giant.s).zone === 'tunnel' && sim.giant.s - sim.track.segmentAt(sim.giant.s).s0 > 12`],
  ['exit-ramp', 2, `sim.exit && sim.exit.gore - sim.giant.s < 60`],
]) (await until(n, seed, pred)).close();
const p = await until('recap', 2, `!sim.live`, 4000);
await p.close();
console.log('errors', errs);
await b.close(); srv.kill();
