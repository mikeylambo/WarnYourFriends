/** Compare run clips: node tools/clips.mjs out.png file1.glb,file2.glb  (paths relative to the repo) */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const [out, list] = process.argv.slice(2);
const files = list.split(',').map((f) => '/' + f.replace(/^\.?\//, ''));
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5184', '--strictPort'], { stdio: 'pipe' });
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('5184') && r()));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 230 * files.length }, deviceScaleFactor: 1 });
page.on('console', (m) => console.log(m.text()));
page.on('pageerror', (e) => console.error(e.message));
await page.goto(`http://localhost:5184/tools/modelsheet/clips.html?f=${files.join(',')}`);
await page.waitForFunction(() => window.__SHEET, null, { timeout: 120000 });
await page.screenshot({ path: out });
await browser.close();
server.kill();
console.log(out);
