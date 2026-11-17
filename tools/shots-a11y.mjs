// HUD triage, onboarding prompts and accessibility evidence (2026-11-17): the in-play HUD without the asks and Heat
// stars, a control prompt on screen, Settings → Controls, and HUD Size 130%.
// Usage: npm run build && node tools/shots-a11y.mjs  (writes docs/evidence/a11y/*.png)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = 'docs/evidence/a11y';
require('fs').mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4190', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch();
const log = (...a) => console.log(...a);
try {
  // 1. A player (no bot), first time: control prompts. Steer nowhere; something unsmashable comes up at Jog.
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.addInitScript(() => localStorage.setItem('wyf.brief.v1', '1'));
    await page.goto('http://localhost:4190/?seed=4&autostart=1&cuts=0&time=night&mode=run');
    await page.waitForFunction(() => window.__GAME?.started, null, { timeout: 30000 });
    await page.waitForSelector('#prompt:not([hidden])', { timeout: 60000 });
    await page.waitForTimeout(300);
    log('prompt:', await page.textContent('#prompt'));
    await page.screenshot({ path: `${OUT}/prompt.png` });
    await page.waitForFunction(() => window.__GAME.sim.time > 12, null, { timeout: 60000 });
    const hud = await page.evaluate(() => ({ asks: getComputedStyle(document.getElementById('asks')).opacity, heat: getComputedStyle(document.getElementById('heat')).display }));
    log('hud at 12s:', JSON.stringify(hud));
    await page.screenshot({ path: `${OUT}/hud-in-play.png` });
    await page.close();
  }
  // 2. Settings → Controls, and HUD Size 130%.
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.addInitScript(() => localStorage.setItem('wyf.settings.v1', JSON.stringify({ hudSize: 1.3, keys: { left: 'KeyJ', right: 'KeyL', brake: 'KeyK', shoulder: 'KeyI', ability: 'KeyU' } })));
    await page.goto('http://localhost:4190/');
    await page.waitForSelector('[data-choice-id="start"]', { timeout: 30000 });
    await page.click('[data-choice-id="start"]');
    await page.waitForTimeout(400);
    await page.click('[data-choice-id="settings"]');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/settings.png` });
    await page.click('[data-choice-id="wyf-controls"]');
    await page.waitForSelector('#recap .controls', { timeout: 5000 });
    await page.click('.bind[data-a="ability"]');
    await page.keyboard.press('KeyO');
    await page.waitForTimeout(200);
    log('ability bound to:', await page.textContent('.bind[data-a="ability"]'));
    await page.screenshot({ path: `${OUT}/controls.png` });
    await page.goto('http://localhost:4190/?seed=4&autostart=1&cuts=0&time=night&mode=run');
    await page.waitForFunction(() => window.__GAME?.started && window.__GAME.sim.time > 4, null, { timeout: 30000 });
    log('controls hint:', await page.textContent('#controls'));
    await page.screenshot({ path: `${OUT}/hud-130.png` });
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
