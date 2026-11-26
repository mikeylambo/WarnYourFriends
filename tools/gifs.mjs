// Store GIFs (itch): short clips from the running build, stepped by the sim (15 fps), bot driving.
// Usage: npm run build && node tools/gifs.mjs  (writes store/itch/gifs/*.gif; needs ffmpeg). ONLY=name for one clip.
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = 'store/itch/gifs', TMP = 'test-results/gif-frames';
mkdirSync(OUT, { recursive: true });
const FPS = 15, W = 960, H = 540;
// name, seed, seconds of bot play before the clip, clip length, setup in page (optional)
const CLIPS = [
  { name: 'rampage', seed: 6, warm: 14, len: 6, setup: () => { const G = window.__GAME; G.sim.giant.meter = 100; G.step(1, { lane: 0, brake: false, shoulder: true }); } },
  { name: 'smash-run', seed: 11, warm: 40, len: 6 },
  { name: 'pursuit', seed: 3, warm: 75, len: 6 },
].filter((c) => !process.env.ONLY || c.name === process.env.ONLY);
const server = spawn('npx', ['vite', 'preview', '--port', '4193', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
for (const c of CLIPS) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.addInitScript(() => localStorage.setItem('wyf.prompts.v2', '[]'));
  await page.goto(`http://localhost:4193/?seed=${c.seed}&step=1&autostart=1&debug=0&time=night&replay=0`);
  await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
  await page.evaluate((t) => { const G = window.__GAME; G.setBot(true); while (G.sim.live && G.sim.time < t) G.step(1); }, c.warm);
  if (c.setup) await page.evaluate(c.setup);
  await page.evaluate(() => window.__GAME.setBot(true));
  rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true });
  const n = c.len * FPS;
  for (let i = 0; i < n; i++) {
    await page.evaluate((k) => window.__GAME.step(k), 60 / FPS);
    await page.waitForTimeout(40); // let a real frame render (camera and tells ease on frames)
    await page.screenshot({ path: `${TMP}/${String(i).padStart(4, '0')}.png` });
  }
  const vf = `fps=${FPS},scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', `${TMP}/%04d.png`, '-vf', vf, '-loop', '0', `${OUT}/${c.name}.gif`]);
  console.log(c.name, 'ok');
  await page.close();
}
await browser.close();
server.kill();
