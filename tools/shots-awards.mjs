// The Local News Awards evidence (2026-11-17): the Awards screen with some won, an award on the recap, and the
// giant in each outfit (recolors). Usage: npm run build && node tools/shots-awards.mjs  (writes docs/evidence/awards/)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = 'docs/evidence/awards';
require('fs').mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4191', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const profile = (outfit) => JSON.stringify({ counts: { signOffs: 4, policeWrecked: 13, objects: 412, bestSegment: 3, runsWon: 1 }, won: ['liveAtEleven', 'specialReport', 'pursuitOfTheYear', 'regularFixture', 'seasonFinale'], outfit });
try {
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript((p) => localStorage.setItem('wyf.awards.v1', p), profile('midnight'));
    await page.goto('http://localhost:4191/');
    await page.waitForSelector('[data-choice-id="start"]', { timeout: 30000 });
    await page.click('[data-choice-id="start"]');
    await page.waitForTimeout(400);
    await page.click('[data-choice-id="awards"]');
    await page.waitForSelector('#recap .awards', { timeout: 5000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/awards-screen.png` });
    console.log('awards screen: won', await page.locator('#recap .aw li.won').count(), 'of', await page.locator('#recap .aw li').count());
    await page.close();
  }
  for (const outfit of ['classic', 'midnight', 'parade', 'gold']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    // Every outfit unlocked for the sheet (the Awards screen above shows a part-way profile).
    await page.addInitScript((p) => localStorage.setItem('wyf.awards.v1', p), profile(outfit).replace('"seasonFinale"', '"seasonFinale","trafficHazard"'));
    await page.goto('http://localhost:4191/?seed=4&step=1&autostart=1&bot=1&cuts=0&time=day&posecam=1');
    await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
    await page.waitForFunction(() => !window.__GAME.coverage().cold, null, { timeout: 15000 });
    await page.evaluate(() => window.__GAME.step(420));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/outfit-${outfit}.png` });
    console.log('outfit', outfit);
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
