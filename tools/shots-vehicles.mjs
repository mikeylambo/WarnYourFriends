// Vehicle sheet evidence: every lane prop and police body, chopper view on top, side-on below.
// Usage: node tools/shots-vehicles.mjs  (dev server; writes docs/evidence/vehicles/sheet.png)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const OUT = 'docs/evidence/vehicles';
mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', '--port', '5193', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 4000));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto('http://localhost:5193/tools/modelsheet/vehicles.html');
await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
await page.screenshot({ path: `${OUT}/sheet.png` });
console.log(`wrote ${OUT}/sheet.png`);
await browser.close();
server.kill();
