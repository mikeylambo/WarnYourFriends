/** Screenshot the model sheet: node tools/modelsheet.mjs [out.png] [t] */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const out = process.argv[2] ?? 'docs/evidence/model/sheet.png';
const t = process.argv[3] ?? '3.3';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5179', '--strictPort'], { stdio: 'pipe' });
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('5179') && r()));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error(e.message));
await page.goto(`http://localhost:5179/tools/modelsheet/?t=${t}`);
await page.waitForFunction(() => window.__SHEET, null, { timeout: 60000 });
await page.screenshot({ path: out });
await browser.close();
server.kill();
console.log(out);
