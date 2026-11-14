// Title screen evidence (Mike's chopper-feed direction), desktop and phone, then mid-glide after Start.
// Usage: npm run build && node tools/shots-title.mjs  (writes docs/evidence/title/*.png)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const OUT = 'docs/evidence/title';
mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4178', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
for (const [name, ctx] of [['desktop', { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 }], ['phone', { ...devices['iPhone 13 landscape'] }]]) {
  const page = await (await browser.newContext(ctx)).newPage();
  await page.goto('http://localhost:4178/?seed=3&debug=0');
  await page.waitForSelector('#ui [data-screen-id="title"]');
  await page.waitForFunction(() => window.__GAME?.attract, null, { timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${OUT}/title-${name}.png` });
  if (name === 'desktop') {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/title-glide.png` });
  }
  await page.close();
}
await browser.close();
server.kill();
console.log('ok');
