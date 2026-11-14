/** Screenshot the stride strip: node tools/strip.mjs <tier> [out.png]  (GREYBOX=1 for the old rig) */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const tier = process.argv[2] ?? '2';
const out = process.argv[3] ?? `docs/evidence/model/strip-${tier}.png`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5182', '--strictPort'], { stdio: 'pipe' });
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('5182') && r()));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 560 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error(e.message));
await page.goto(`http://localhost:5182/tools/modelsheet/strip.html?tier=${tier}${process.env.GREYBOX ? '&greybox=1' : ''}`);
await page.waitForFunction(() => window.__SHEET, null, { timeout: 90000 });
await page.screenshot({ path: out });
await browser.close();
server.kill();
console.log(out);
