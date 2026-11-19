// Isolated Chromium regression checks. No native client, profile or network is used.
// Set NODE_PATH to an existing Playwright installation and AXIVER_CHROMIUM if needed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = resolve(process.argv[2] || resolve(project, '../screenshots/frost-headless'));
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.env.AXIVER_CHROMIUM ? { executablePath: process.env.AXIVER_CHROMIUM } : {}) });
const results = [];

function assertSafe(state) {
  for (const surface of state.surfaces) {
    assert(surface.ready ? surface.covered : surface.alpha === 1,
      `Uncovered or transparent material: ${JSON.stringify(state)}`);
  }
}

try {
  for (const scale of [1, 1.25, 1.5]) {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: scale });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(() => {
      const state = { expanded: false, pillWidth: 26, panelHeight: 330, viewX: 6, viewY: 6 };
      const layout = () => ({ ...state, toolActive: false, x: state.viewX + 6, y: state.viewY + 6,
        pillX: 6, pillY: 6, panelX: 6, panelY: 40, panelWidth: 360,
        width: (state.expanded ? Math.max(state.pillWidth, 360) : state.pillWidth) + 12,
        height: (state.expanded ? 34 + state.panelHeight : 26) + 12 });
      const set = values => {
        Object.assign(state, values);
        const next = layout();
        window.__AXIVER_SHELL__?.onLayout(next);
        return next;
      };
      window.__frostFixture = { set, rawFrames: 0 };
      window.__TAURI__ = { core: { invoke: async (command, args) => {
        if (command === 'client_ui_layout') {
          const input = args.input;
          if (input.action === 'open') state.expanded = true;
          if (['close', 'dismiss'].includes(input.action)) state.expanded = false;
          if (input.action === 'height') state.panelHeight = input.height;
          if (input.action === 'pill_width') state.pillWidth = input.width;
          const next = set({});
          // Native layout push and the IPC reply both deliver the same geometry.
          await new Promise(resolve => setTimeout(resolve, 15));
          return { ok: true, data: next };
        }
        const data = {
          client_get_config: { broadcastName: 'AXIVER-FROST-TEST', wideUrl: 'https://example.test/' },
          client_get_connection: { revision: 1, phase: 'connected', kind: 'lan' },
          client_get_version: { version: 'test', buildProfile: 'headless', target: 'chromium' },
          client_get_diagnostics: {}, client_get_downloads: [],
          client_get_download_settings: { mode: 'default', directory: 'test' },
        };
        return { ok: true, data: data[command] };
      } }, event: { listen: async () => {} } };
    });
    await page.route('http://axiver.test/**', async route => {
      const name = new URL(route.request().url()).pathname.slice(1) || 'shell.html';
      assert(['shell.html', 'shell.css', 'shell.js', 'frost.js'].includes(name));
      await route.fulfill({ body: await readFile(resolve(project, 'ui', name)),
        contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://axiver.test/shell.html');
    await page.waitForFunction(() => window.__AXIVER_SHELL__?.layout);
    await page.waitForTimeout(80);

    const pixels = await page.evaluate(async scale => {
      const makeImage = async value => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(900 * scale); canvas.height = Math.round(700 * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = `rgb(${value},${value},${value})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const image = new Image(); image.src = canvas.toDataURL(); await image.decode();
        return image;
      };
      const readPixels = async src => {
        const image = new Image(); image.src = src; await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let min = 255, max = 0, alpha = 255;
        for (let i = 0; i < data.length; i += 4) {
          min = Math.min(min, data[i], data[i + 1], data[i + 2]);
          max = Math.max(max, data[i], data[i + 1], data[i + 2]);
          alpha = Math.min(alpha, data[i + 3]);
        }
        return { min, max, alpha, width: canvas.width, height: canvas.height };
      };
      const frame = { width: 900, height: 700 };
      const layout = { viewX: 6, viewY: 6, width: 372, height: 376 };
      const light = await makeImage(200), dark = await makeImage(40);
      const samples = [];
      for (const [name, image, height, value] of [
        ['cold', light, 376, 200], ['warm', light, 376, 200],
        ['resized', light, 404, 200], ['next-frame', dark, 404, 40],
      ]) {
        const output = window.__AXIVER_FROST__.render(image, frame, { ...layout, height });
        samples.push({ name, value, panel: await readPixels(output.src), pill: await readPixels(output.pillSrc) });
      }
      return samples;
    }, scale);
    for (const sample of pixels) {
      for (const name of ['panel', 'pill']) {
        const p = sample[name];
        assert.equal(p.alpha, 255, JSON.stringify(sample));
        assert(Math.abs(p.min - sample.value) <= 2 && Math.abs(p.max - sample.value) <= 2,
          `Dark edge or previous-frame residue: ${JSON.stringify(sample)}`);
      }
    }

    await page.evaluate(async scale => {
      const fixture = window.__frostFixture;
      fixture.read = () => {
        const layout = window.__AXIVER_SHELL__.layout;
        const texture = window.__AXIVER_SHELL__.backdropStats;
        const surfaces = ['pill', 'panel'].flatMap(id => {
          const element = document.getElementById(id);
          if (element.hidden) return [];
          let x = layout.viewX, y = layout.viewY;
          for (let node = element; node; node = node.offsetParent) { x += node.offsetLeft; y += node.offsetTop; }
          x += element.clientLeft; y += element.clientTop;
          const numbers = getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.map(Number) || [];
          const alpha = numbers.length === 3 ? 1 : (numbers[3] ?? 0);
          return [{ id, x, y, width: element.clientWidth, height: element.clientHeight, alpha,
            ready: element.classList.contains('has-backdrop'),
            covered: Boolean(texture && x >= texture.x - 1 && y >= texture.y - 1 &&
              x + element.clientWidth <= texture.x + texture.width + 1 &&
              y + element.clientHeight <= texture.y + texture.height + 1) }];
        });
        return { texture, surfaces, rawFrames: fixture.rawFrames };
      };
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(900 * scale); canvas.height = Math.round(700 * scale);
      const ctx = canvas.getContext('2d'); ctx.scale(scale, scale);
      for (let x = 0; x < 900; x += 20) {
        ctx.fillStyle = x % 40 ? '#c8c8c8' : '#3c3c3c'; ctx.fillRect(x, 0, 20, 700);
      }
      fixture.rawFrames++;
      await window.__AXIVER_SHELL__.onBackdrop({ src: canvas.toDataURL(), width: 900, height: 700 });
    }, scale);
    const ready = async () => page.waitForFunction(() =>
      window.__frostFixture.read().surfaces.every(surface => surface.ready && surface.covered));
    const read = () => page.evaluate(() => window.__frostFixture.read());
    await ready();
    const transitions = [];
    const change = async (name, action, holdDecode = false) => {
      if (holdDecode) await page.evaluate(() => {
        const fixture = window.__frostFixture, original = HTMLImageElement.prototype.decode;
        fixture.pendingDecode = { calls: 0, releases: [] };
        HTMLImageElement.prototype.decode = function () {
          fixture.pendingDecode.calls++;
          return original.call(this).then(() => new Promise(resolve => fixture.pendingDecode.releases.push(resolve)));
        };
        fixture.finishDecode = () => {
          HTMLImageElement.prototype.decode = original;
          fixture.pendingDecode.releases.forEach(release => release());
          return fixture.pendingDecode.calls;
        };
      });
      const immediate = await page.evaluate(action);
      assertSafe(immediate);
      if (holdDecode) await page.waitForFunction(() => window.__frostFixture.pendingDecode.releases.length >= 2);
      const samples = await page.evaluate(async () => {
        const samples = [], until = performance.now() + 420;
        do {
          await new Promise(requestAnimationFrame);
          samples.push(window.__frostFixture.read());
        } while (performance.now() < until);
        return samples;
      });
      samples.forEach(assertSafe);
      if (holdDecode) {
        assert(samples.every(state => !state.surfaces.find(surface => surface.id === 'panel').ready),
          `Panel exposed an incomplete texture while decode was held: ${name}`);
        assert.equal(await page.evaluate(() => window.__frostFixture.finishDecode()), 2,
          'Duplicate layout echoes restarted the same texture decode');
      }
      await ready();
      const settled = await read();
      assert.equal(settled.rawFrames, 1, 'Layout refresh required another remote capture');
      transitions.push({ name, immediate, samples, settled });
    };
    await change('dot-to-panel', () => {
      window.__frostFixture.set({ expanded: true }); return window.__frostFixture.read();
    }, true);
    await change('settings-grow', () => {
      document.getElementById('tab-settings').click(); return window.__frostFixture.read();
    }, true);
    await change('settings-shrink', () => {
      document.getElementById('tab-connection').click(); return window.__frostFixture.read();
    });
    await change('move-with-frozen-capture', () => {
      window.__frostFixture.set({ viewX: 470, viewY: 130 }); return window.__frostFixture.read();
    });

    // Hold the next texture pair while the layout moves again. Old decode
    // completions must never publish a crop for the superseded location.
    await page.evaluate(() => {
      const fixture = window.__frostFixture, original = HTMLImageElement.prototype.decode;
      fixture.decodeGate = { remaining: 2, releases: [], publications: [] };
      HTMLImageElement.prototype.decode = function () {
        const hold = fixture.decodeGate.remaining-- > 0;
        const decoded = original.call(this);
        return hold ? decoded.then(() => new Promise(resolve => fixture.decodeGate.releases.push(resolve))) : decoded;
      };
      let stats = window.__AXIVER_SHELL__.backdropStats;
      Object.defineProperty(window.__AXIVER_SHELL__, 'backdropStats', {
        configurable: true, get: () => stats,
        set: value => { stats = value; fixture.decodeGate.publications.push(fixture.read()); },
      });
      fixture.restoreDecode = () => { HTMLImageElement.prototype.decode = original; };
      fixture.set({ viewX: 350, viewY: 120 });
    });
    await page.waitForFunction(() => window.__frostFixture.decodeGate.releases.length === 2);
    const delayed = await page.evaluate(() => {
      const fixture = window.__frostFixture;
      fixture.set({ viewX: 6, viewY: 6 });
      const immediate = fixture.read();
      fixture.decodeGate.publications.length = 0;
      fixture.decodeGate.releases.forEach(release => release());
      return immediate;
    });
    assertSafe(delayed);
    await ready();
    const publications = await page.evaluate(() => {
      window.__frostFixture.restoreDecode(); return window.__frostFixture.decodeGate.publications;
    });
    assert(publications.length > 0, 'No replacement texture was published after decoding');
    for (const state of publications) {
      assert(state.surfaces.every(surface => surface.covered), `Stale decode published: ${JSON.stringify(state)}`);
    }
    const contrast = await page.evaluate(async () => {
      const result = {};
      for (const property of ['--backdrop', '--pill-backdrop']) {
        const value = document.documentElement.style.getPropertyValue(property);
        const image = new Image(); image.src = value.slice(5, -2); await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        const row = ctx.getImageData(20, Math.floor(canvas.height / 2), canvas.width - 40, 1).data;
        let min = 255, max = 0;
        for (let i = 0; i < row.length; i += 4) { min = Math.min(min, row[i]); max = Math.max(max, row[i]); }
        result[property] = max - min;
      }
      return result;
    });
    for (const value of Object.values(contrast)) assert(value > 1 && value < 120,
      `Material lost the sampled pattern or retained sharp 140-level stripes: ${JSON.stringify(contrast)}`);
    await page.screenshot({ path: resolve(artifacts, `frost-${scale}.png`), clip: { x: 0, y: 0, width: 390, height: 400 } });
    assert.deepEqual(errors, []);
    results.push({ scale, pixels, transitions, delayed, publications, contrast });
    await page.close();
  }
  await writeFile(resolve(artifacts, 'results.json'), JSON.stringify({
    scope: 'Headless Chromium, local IPC fixture, one frozen remote frame per scale; no native WebView2 claim', results,
  }, null, 2));
  console.log('PASS: cold/warm/resized blur edges, no frame residue, frozen-frame layout coverage, opaque fallback and stale decode rejection at 100/125/150% DPI');
} finally {
  await browser.close();
}
