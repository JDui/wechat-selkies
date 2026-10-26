// Focus-safe regression check: headless Chromium only; no native client launch.
// Set NODE_PATH to an existing Playwright installation if it is not local.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = resolve(process.argv[2] || resolve(project, '../screenshots/dock-headless'));
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.AXIVER_CHROMIUM ? { executablePath: process.env.AXIVER_CHROMIUM } : {}),
});
const results = [];
try {
  for (const scale of [1, 1.25, 1.5]) {
    const page = await browser.newPage({ viewport: { width: 600, height: 600 }, deviceScaleFactor: scale });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(() => {
      let expanded = false, width = 26, height = 330;
      const layout = () => ({ expanded, toolActive: false, x: 12, y: 12,
        viewX: 6, viewY: 6, pillX: 6, pillY: 6,
        panelX: 6, panelY: 40, panelWidth: 360, panelHeight: height,
        width: (expanded ? Math.max(width, 360) : width) + 12,
        height: (expanded ? 34 + height : 26) + 12 });
      window.__dockWidths = [];
      window.__TAURI__ = { core: { invoke: async (command, args) => {
        if (command === 'client_ui_layout') {
          const input = args.input;
          if (input.action === 'open') expanded = true;
          if (input.action === 'close') expanded = false;
          if (input.action === 'height') height = input.height;
          if (input.action === 'pill_width') { width = input.width; window.__dockWidths.push(width); }
          // Echo Rust's eval push before the duplicate IPC reply, with delay.
          const next = layout();
          await new Promise(resolve => setTimeout(resolve, 15));
          window.__AXIVER_SHELL__?.onLayout(next);
          return { ok: true, data: next };
        }
        const data = {
          client_get_config: { broadcastName: 'AXIVER-TEST', wideUrl: 'https://example.test/' },
          client_get_connection: { revision: 1, phase: 'discovering_lan' },
          client_get_version: { version: 'test', buildProfile: 'headless', target: 'chromium' },
          client_get_diagnostics: {}, client_get_downloads: [],
          client_get_download_settings: { mode: 'default', directory: 'test' },
        };
        return { ok: true, data: data[command] };
      } }, event: { listen: async () => {} } };
    });
    await page.route('http://axiver.test/**', async route => {
      const name = new URL(route.request().url()).pathname.slice(1) || 'shell.html';
      assert(['shell.html', 'shell.css', 'shell.js'].includes(name));
      await route.fulfill({ body: await readFile(resolve(project, 'ui', name)),
        contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://axiver.test/shell.html');
    await page.waitForFunction(() => window.__AXIVER_SHELL__?.layout && !document.getElementById('pill-wan').hidden);
    await page.waitForTimeout(100);
    const geometry = () => page.evaluate(() => {
      const pill = document.getElementById('pill').getBoundingClientRect();
      const dot = document.getElementById('pill-dot').getBoundingClientRect();
      const chip = document.getElementById('pill-wan').getBoundingClientRect();
      return { width: pill.width, height: pill.height,
        dotX: dot.x + dot.width / 2 - pill.x, dotY: dot.y + dot.height / 2 - pill.y,
        gap: chip.x - pill.right, busy: document.getElementById('pill').classList.contains('animating') };
    });
    const centered = (sample, circle = false) => {
      assert(Math.abs(sample.dotX - 13) < .02, JSON.stringify(sample));
      assert(Math.abs(sample.dotY - 13) < .02, JSON.stringify(sample));
      assert(Math.abs(sample.gap - 6) < .02, JSON.stringify(sample));
      if (circle) assert.equal(sample.width, sample.height);
    };
    centered(await geometry(), true);
    // Distinct remote color bands make a wrongly shared background offset visible.
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 600;
      const ctx = canvas.getContext('2d');
      for (let x = 0; x < 600; x += 20) { ctx.fillStyle = `hsl(${x},55%,65%)`; ctx.fillRect(x, 0, 20, 600); }
      await window.__AXIVER_SHELL__.onBackdrop({ src: canvas.toDataURL(), width: 600, height: 600 });
    });
    await page.screenshot({ path: resolve(artifacts, `collapsed-${scale}.png`), clip: { x: 0, y: 0, width: 290, height: 50 } });
    const sampleTransition = async type => {
      await page.locator('#pill').dispatchEvent(type);
      const samples = [];
      for (let i = 0; i < 15; i++) { await page.waitForTimeout(35); samples.push(await geometry()); }
      samples.forEach(sample => centered(sample));
      assert(new Set(samples.map(sample => sample.width.toFixed(1))).size >= 3, 'transition has no intermediate widths');
      assert.equal(samples.at(-1).busy, false, 'layout echo restarted the animation');
      return samples;
    };
    const opening = await sampleTransition('mouseenter');
    assert(opening.at(-1).width > 70);
    await page.screenshot({ path: resolve(artifacts, `expanded-${scale}.png`), clip: { x: 0, y: 0, width: 290, height: 50 } });
    const offset = await page.evaluate(() => {
      const layout = window.__AXIVER_SHELL__.layout;
      const chip = document.getElementById('pill-wan');
      return { actual: parseFloat(chip.style.getPropertyValue('--sample-x')),
        expected: -(layout.viewX + chip.getBoundingClientRect().left + chip.clientLeft) + 18 };
    });
    assert(Math.abs(offset.actual - offset.expected) < .02);
    await page.locator('#pill').dispatchEvent('mouseleave');
    await page.waitForTimeout(510);
    const closing = [];
    for (let i = 0; i < 12; i++) { await page.waitForTimeout(35); closing.push(await geometry()); }
    closing.forEach(sample => centered(sample));
    centered(closing.at(-1), true);
    assert.equal(closing.at(-1).busy, false);
    assert(new Set(closing.map(sample => sample.width.toFixed(1))).size >= 3);
    // Reverse a closing animation and receive a connection event mid-flight.
    await page.locator('#pill').dispatchEvent('mouseenter'); await page.waitForTimeout(180);
    await page.locator('#pill').dispatchEvent('mouseleave'); await page.waitForTimeout(590);
    await page.locator('#pill').dispatchEvent('mouseenter');
    await page.evaluate(() => window.__AXIVER_SHELL__.onStatus({ revision: 2, phase: 'connecting_wan' }));
    await page.waitForTimeout(600);
    centered(await geometry());
    assert.equal((await geometry()).busy, false);
    assert.equal(await page.locator('#pill-wan').getAttribute('data-mode'), 'lan');
    // Panel animation remains alive through duplicate layouts.
    await page.locator('#pill').click(); await page.waitForTimeout(350);
    assert.equal(await page.locator('#panel').isVisible(), true);
    await page.locator('#btn-hide').click(); await page.waitForTimeout(250);
    assert.equal(await page.locator('#panel').isVisible(), false);
    await page.locator('#pill').evaluate(element => element.blur());
    await page.locator('#pill').dispatchEvent('mouseleave'); await page.waitForTimeout(1000);
    // Reduced motion settles directly, without stale animations or inline styles.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('#pill').dispatchEvent('mouseenter'); await page.waitForTimeout(100);
    assert.equal((await geometry()).busy, false);
    await page.locator('#pill').dispatchEvent('mouseleave'); await page.waitForTimeout(600);
    centered(await geometry(), true);
    assert.deepEqual(errors, []);
    results.push({ scale, opening, closing, offset, nativeWidthReports: await page.evaluate(() => window.__dockWidths) });
    await page.close();
  }
  await writeFile(resolve(artifacts, 'results.json'), JSON.stringify({ scope: 'headless Chromium with delayed IPC fixture; no native client launched', results }, null, 2));
  console.log('PASS: centered dot, complete width transitions, interrupt/reverse, background offsets, panel and reduced motion at 100/125/150% DPI');
} finally {
  await browser.close();
}
