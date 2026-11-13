/** Side-on run-pose frames per tier (?posecam=1, day look, slow motion). Usage: node tools/shots-pose.mjs [outDir] */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const srv = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '4184', '--strictPort'], { stdio: 'pipe' });
await new Promise((r) => srv.stdout.on('data', (d) => String(d).includes('4184') && r()));
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
await p.goto('http://localhost:4184/?seed=4&autostart=1&posecam=1&debug=0&timescale=0.12&time=day');
await p.waitForFunction(() => window.__GAME?.started);
// Hold a lane, no input: let him reach each tier, then grab a strip of frames across one stride.
for (const [tier, name] of [[0, 'jog'], [1, 'stride'], [2, 'rampage']]) {
  await p.waitForFunction((t) => window.__GAME.state().tier === t, tier, { timeout: 240000 });
  await p.waitForTimeout(1500);
  for (let k = 0; k < 4; k++) {
    await p.screenshot({ path: `${process.argv[2] ?? 'test-results'}/pose-${name}-${k}.png` });
    await p.waitForTimeout(700);
  }
}
await b.close(); srv.kill();
