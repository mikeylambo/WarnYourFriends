/**
 * Phase 0 E2E smoke (§41, adapted until the shell flow exists):
 *   title → any key starts the run → giant runs under keyboard input
 *   bot run: reaches Rampage, smashes things, no page errors, speed floor holds.
 * Serves dist/ with `vite preview`, drives headless Chromium.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
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
const URL = `http://localhost:${PORT}/`;
mkdirSync('test-results', { recursive: true });

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
const ready = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('preview server timeout')), 20000);
  server.stdout.on('data', (d) => {
    if (String(d).includes(String(PORT))) {
      clearTimeout(t);
      resolve();
    }
  });
});

let failed = false;
const fail = (msg) => {
  console.error('E2E FAIL:', msg);
  failed = true;
};

try {
  await ready;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // 1) Title → keyboard start → steering works.
  await page.goto(`${URL}?seed=5`);
  await page.waitForFunction(() => window.__GAME);
  if (!(await page.isVisible('#title'))) fail('title not visible');
  await page.keyboard.press('KeyD');
  await page.waitForFunction(() => window.__GAME.started);
  if (await page.isVisible('#title')) fail('title still visible after input');
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(600);
  await page.keyboard.up('KeyA');
  const s1 = await page.evaluate(() => window.__GAME.state());
  if (!(s1.time > 0.3)) fail(`sim not advancing (t=${s1.time})`);
  if (s1.speed < 2) fail(`speed below floor (${s1.speed})`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  if (!(await page.evaluate(() => window.__GAME.paused))) fail('Esc did not pause');
  await page.screenshot({ path: 'test-results/e2e-paused.png' });
  await page.click('#resume');

  // 2) Bot run at 3x: must tier up to Rampage and smash things.
  await page.goto(`${URL}?seed=3&bot=1&timescale=3&debug=1`);
  await page.waitForFunction(() => window.__GAME && window.__GAME.started);
  await page.waitForFunction(() => window.__GAME.state().time > 30, null, { timeout: 30000 });
  const s2 = await page.evaluate(() => window.__GAME.state());
  await page.screenshot({ path: 'test-results/e2e-bot.png' });
  console.log(`bot: t=${s2.time.toFixed(1)}s tier=${s2.tier} speed=${s2.speed.toFixed(1)} smashes=${s2.stats.smashes} bounces=${s2.stats.bounces} rampage=${s2.stats.timeAtTier[2].toFixed(1)}s`);
  if (s2.stats.timeAtTier[2] <= 0) fail('bot never reached Rampage');
  if (s2.stats.smashes + s2.stats.knocks <= 0) fail('nothing smashed');
  if (s2.stats.minSpeed < 2) fail('speed floor violated');

  if (errors.length) fail(`page errors:\n  ${errors.join('\n  ')}`);
  await browser.close();
} catch (e) {
  fail(e?.stack ?? String(e));
} finally {
  server.kill();
}
if (failed) process.exit(1);
console.log('e2e OK');
process.exit(0);
