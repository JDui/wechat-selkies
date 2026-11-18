const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtime = process.env.CODEX_NODE_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const { chromium } = require(path.join(runtime, 'playwright'));
const root = path.resolve(process.env.QOE_PROBE_ROOT || path.join(__dirname, '..'));
const dashboard = 'root/usr/share/selkies/selkies-dashboard/src/';

async function run() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    const files = new Map([['tests/av1_browser_probe.html', 'text/html'], ['tests/fixtures/av1_samples.json', 'application/json'],
      [dashboard + 'selkies-av1.js', 'application/javascript']]);
    await page.route('**/*', route => {
      const file = new URL(route.request().url()).pathname.slice(1);
      return files.has(file) ? route.fulfill({ contentType: files.get(file), body: fs.readFileSync(path.join(root, file)) }) : route.abort();
    });
    const software = process.argv.includes('--software');
    if (software) await page.addInitScript(() => {
      const NativeDecoder = window.VideoDecoder;
      window.VideoDecoder = class extends NativeDecoder {
        static isConfigSupported(config) { return NativeDecoder.isConfigSupported({ ...config, hardwareAcceleration: 'prefer-software' }); }
        configure(config) { super.configure({ ...config, hardwareAcceleration: 'prefer-software' }); }
      };
    });
    await page.goto('http://localhost/tests/av1_browser_probe.html');
    await page.addScriptTag({ path: path.join(root, dashboard, 'selkies-stream-health.js') });
    const offered = await page.evaluate(() => {
      const health = window.__selkiesStreamHealth;
      if (!health.offer) return false;
      window.qoeReports = [];
      const socket = { readyState: 1, bufferedAmount: 0, send: text => window.qoeReports.push(text) };
      health.connect(socket, 'primary'); health.opened(socket); health.setRole(socket, 'controller'); health.start();
      health.offer(socket, 'VIDEO_QOE,primary,' + 'a'.repeat(32) + '.1');
      const create = window.selkiesAv1.createDecoder;
      window.selkiesAv1.createDecoder = options => create({ ...options, receipt: (id, decoder) => health.receipt(socket, id, decoder),
        output(frame, packet) { options.output(frame, packet); health.progress(packet.ticket, 'drawn'); } });
      return true;
    });
    await page.locator('#run').click({ timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('#result').innerText.includes('"passed"'), null, { timeout: 12000 });
    const result = JSON.parse(await page.locator('#result').innerText());
    console.log(browser.version(), { software, offered, passed: result.passed, error: result.error,
      cases: result.cases.map(entry => [entry.sample, entry.framesDrawn]) });
    assert.equal(result.passed, true, result.error);
    if (offered) {
      const count = result.cases.reduce((sum, entry) => sum + entry.framesDrawn, 0);
      await page.waitForFunction(expected => [11, 12, 13].every(field => window.qoeReports.reduce((sum, line) =>
        sum + Number(line.split(',')[field]), 0) === expected), count, { timeout: 3000 });
    }
  } finally { await browser.close(); }
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
