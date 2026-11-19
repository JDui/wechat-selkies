// Execute the complete production shell with controlled image-decode promises.
// Geometry and IPC are stubbed: this checks lifetime/races, not a compositor
// or native WebView2. Run with: node axiver-client/tests/frost-lifetime.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function fixture() {
  const elements = new Map(), gates = new Map(), renders = [];
  function element(id) {
    const properties = new Map(), classes = new Set();
    return {
      id, hidden: id === 'panel', clientLeft: 1, clientTop: 1,
      clientWidth: id === 'panel' ? 358 : 24,
      clientHeight: id === 'panel' ? 328 : 24,
      offsetWidth: id === 'panel' ? 360 : 26,
      offsetHeight: id === 'panel' ? 330 : 26,
      scrollWidth: 100, children: [], dataset: {}, textContent: '', value: '',
      style: {
        setProperty: (key, value) => properties.set(key, value),
        getPropertyValue: key => properties.get(key) || '',
        removeProperty: key => properties.delete(key),
      },
      classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name),
        toggle(name, enabled = !classes.has(name)) {
          enabled ? classes.add(name) : classes.delete(name);
          return enabled;
        },
      },
      addEventListener() {}, setAttribute() {}, removeAttribute() {},
      blur() {}, focus() {}, querySelector() { return null; },
      getBoundingClientRect() {
        return { left: 6, top: 6, width: this.offsetWidth, height: this.offsetHeight };
      },
    };
  }
  const document = {
    documentElement: element('root'), activeElement: null, addEventListener() {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element(id));
      return elements.get(id);
    },
  };
  class GatedImage {
    decode() {
      assert(!gates.has(this.src), `Duplicate decode gate: ${this.src}`);
      return new Promise((resolve, reject) => gates.set(this.src, { resolve, reject }));
    }
  }
  const window = {
    matchMedia: () => ({ matches: true }),
    __AXIVER_FROST__: {
      render(image, frame, bounds) {
        const number = renders.length + 1;
        const x = Math.max(0, bounds.viewX - 48), y = Math.max(0, bounds.viewY - 48);
        const result = frame.width > 0 && frame.height > 0 ? {
          src: `processed:${number}:panel`, pillSrc: `processed:${number}:pill`, x, y,
          width: Math.min(frame.width - x, Math.max(bounds.width, 260) + 96),
          height: Math.min(frame.height - y, bounds.height + 96),
          sampleWidth: 100, sampleHeight: 100, processingMs: 1,
        } : null;
        renders.push({ raw: image.src, bounds: { ...bounds }, result });
        return result;
      },
    },
  };
  const context = vm.createContext({
    window, document, Image: GatedImage, ResizeObserver: class { observe() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1,
  });
  const filename = resolve(__dirname, '../ui/shell.js');
  vm.runInContext(readFileSync(filename, 'utf8'), context, { filename });
  const shell = window.__AXIVER_SHELL__;
  async function settle(src, failure = false) {
    assert(gates.has(src), `Missing decode gate: ${src}`);
    if (failure) gates.get(src).reject(new Error('Fixture decode failure'));
    else gates.get(src).resolve();
    // Drain the raw decode, PNG Promise.all, and publication continuations.
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
  return {
    shell, renders, panel: document.getElementById('panel'), settle,
    latest: () => renders.at(-1),
    published: () => document.documentElement.style.getPropertyValue('--backdrop'),
    feed: (name, extra = {}) => shell.onBackdrop({
      src: `raw:${name}`, width: 1200, height: 900, ...extra,
    }),
    async complete(call) {
      await settle(call.result.src);
      await settle(call.result.pillSrc);
    },
  };
}

const layout = (extra = {}) => ({
  expanded: true, toolActive: false, x: 12, y: 12, viewX: 6, viewY: 6,
  pillX: 6, pillY: 6, panelX: 6, panelY: 40, panelWidth: 360, panelHeight: 330,
  width: 372, height: 376, ...extra,
});

test('frost lifetime with stub geometry and decode gates', { timeout: 5000 }, async () => {
  const f = fixture();
  const apply = extra => f.shell.onLayout(layout(extra));
  apply();

  // Latest raw decode wins, even if an earlier source finishes afterward.
  const a = f.feed('A'), b = f.feed('B');
  await f.settle('raw:B');
  await f.complete(f.latest());
  await b;
  const first = f.published();
  await f.settle('raw:A');
  await a;
  assert.equal(f.latest().raw, 'raw:B');
  assert.equal(f.renders.length, 1);
  assert.equal(f.published(), first);

  // A partially decoded pair must never replace the previous material.
  const c = f.feed('C');
  await f.settle('raw:C');
  const pair = f.latest();
  assert.equal(f.published(), first);
  await f.settle(pair.result.src);
  assert.equal(f.published(), first, 'Only one PNG decoded');
  await f.settle(pair.result.pillSrc);
  await c;
  assert(f.published().includes(pair.result.src));

  // Reuse the full decoded source on movement; duplicate layouts are no-ops.
  const count = f.renders.length;
  apply({ viewX: 500, x: 506 });
  const moved = f.latest();
  assert.equal(moved.raw, 'raw:C');
  assert.equal(f.panel.classList.contains('has-backdrop'), false);
  apply({ viewX: 500, x: 506 });
  assert.equal(f.renders.length, count + 1);
  await f.complete(moved);
  apply({ viewX: 500, x: 506 });
  assert.equal(f.renders.length, count + 1);

  apply({ viewX: 300, x: 306 });
  const stale = f.latest();
  apply({ viewX: 700, x: 706 });
  await f.complete(f.latest());
  const latestMaterial = f.published();
  await f.complete(stale);
  assert.equal(f.published(), latestMaterial, 'Stale crop replaced the latest move');
  assert.equal(f.shell.backdropStats.x, 652);

  // Failures retain the good material; a failed output can retry the same layout.
  const badRaw = f.feed('badRaw');
  await f.settle('raw:badRaw', true);
  await badRaw;
  assert.equal(f.published(), latestMaterial);
  apply({ viewX: 650, x: 656 });
  assert.equal(f.latest().raw, 'raw:C');
  await f.complete(f.latest());
  const beforeBadOutput = f.published(), badOutput = f.feed('badOutput');
  await f.settle('raw:badOutput');
  const rejected = f.latest();
  await f.settle(rejected.result.src, true);
  await f.settle(rejected.result.pillSrc);
  await badOutput;
  assert.equal(f.published(), beforeBadOutput);
  const retryCount = f.renders.length;
  apply({ viewX: 650, x: 656 });
  assert.equal(f.renders.length, retryCount + 1);
  await f.complete(f.latest());
  const valid = f.published(), invalid = f.feed('invalid', { width: 0 });
  await f.settle('raw:invalid');
  await invalid;
  assert.equal(f.latest().result, null);
  assert.equal(f.published(), valid);

  // Explicit current geometry simulates a resize transition awaiting a texture.
  const stable = f.feed('stable');
  await f.settle('raw:stable');
  await f.complete(f.latest());
  await stable;
  apply();
  await f.complete(f.latest());
  assert(f.panel.classList.contains('has-backdrop'));
  apply({ panelHeight: 478, height: 524 });
  assert.equal(f.panel.clientHeight, 328);
  assert.equal(f.panel.classList.contains('has-backdrop'), false, 'Target outgrew old crop');
  assert(f.latest().bounds.height >= 524);
  await f.complete(f.latest());
  assert(f.panel.classList.contains('has-backdrop'));
  f.panel.offsetHeight = 478;
  f.panel.clientHeight = 476;
  apply();
  assert.equal(f.latest().bounds.height, 518, 'Shrink lost still-visible geometry');
  await f.complete(f.latest());
  assert(f.panel.classList.contains('has-backdrop'));

  console.log('PASS: frost decode ordering, atomic publication, layout cache, failure retention, growth and shrink coverage (stub DOM; no compositor/native check)');
});
