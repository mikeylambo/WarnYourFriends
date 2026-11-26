// Simulated mid-range Android (Chrome CPU 4x slowdown, Fast 4G): boot and playable time, download, sim step cost, JS heap.
// The GPU is not simulated (software rendering here); use tools/perf-draws.mjs for the GPU-side budget. Usage: npm run build && node tools/perf-android.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(process.cwd() + '/package.json');
const { chromium } = require('playwright');
const server = spawn('npx', ['vite', 'preview', '--port', '4194', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const b = await chromium.launch();
for (const rate of [1, 4]) {
  const ctx = await b.newContext({ viewport: { width: 800, height: 360 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  await cdp.send('Network.enable');
  // Chrome's "Fast 4G" preset-ish: 9 Mbps down, 1.5 up, 60 ms.
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 60, downloadThroughput: 9e6 / 8, uploadThroughput: 1.5e6 / 8 });
  const t0 = Date.now();
  await p.goto('http://localhost:4194/?seed=4&autostart=1&bot=1');
  await p.waitForFunction(() => document.documentElement.dataset.boot === 'ok', null, { timeout: 120000 });
  const boot = Date.now() - t0;
  await p.waitForFunction(() => window.__GAME.started, null, { timeout: 120000 });
  const play = Date.now() - t0;
  // Sim + game-logic cost: time the fixed steps directly (renderer excluded: software GPU here isn't a phone GPU).
  const r = await p.evaluate(async () => {
    const G = window.__GAME;
    const xs = [];
    for (let i = 0; i < 600; i++) { const a = performance.now(); G.step(1); xs.push(performance.now() - a); if (i % 60 === 0) await new Promise((r) => setTimeout(r, 0)); }
    xs.sort((a, b) => a - b);
    const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : -1;
    return { median: xs[300].toFixed(2), p95: xs[570].toFixed(2), max: xs[599].toFixed(2), heapMB: mem };
  });
  const bytes = await p.evaluate(() => Math.round(performance.getEntriesByType('resource').reduce((s, e) => s + (e.transferSize || 0), 0) / 1e3));
  console.log(JSON.stringify({ cpuSlowdown: rate, bootMs: boot, playableMs: play, transferKB: bytes, stepMs: r }));
  await ctx.close();
}
await b.close(); server.kill();
