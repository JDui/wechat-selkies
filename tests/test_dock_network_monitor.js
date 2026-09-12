const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dashboard = path.join(__dirname, '../root/usr/share/selkies/selkies-dashboard');
const source = fs.readFileSync(path.join(dashboard, 'src/selkies-runtime-overrides.js'), 'utf8');
const speed = { textContent: '', setAttribute(key, value) { this[key] = value; } };
const latency = { textContent: '' };
const monitor = { hidden: false, querySelector: selector => selector.includes('speed') ? speed : latency };
const total = { textContent: '' };
const summary = { uploadKbps: 0, downloadKbps: 0, latencyMs: null, total24hBytes: 1073741824 };
let now = 100000;
let connected = true;
let recordedBytes = 0;
const scope = {
  window: {}, Date: { now: () => now }, Number, Math,
  document: { getElementById: id => id === 'selkies-dock-network-monitor' ? monitor : { querySelector: () => ({querySelector: () => total}) } },
  dockNetworkMonitorEnabled: true,
  lastNetworkStatsAt: 0, notificationBandwidthSummary: summary,
  hasOpenDataSocket: () => connected,
  readBandwidthSamples: () => [], writeBandwidthSamples() {},
  readBandwidthState: () => ({bytes: recordedBytes}),
  writeBandwidthState: state => { recordedBytes = state.bytes; },
  maybeRecordDailyBandwidthNotice() {}
};
for (const name of ['formatTrafficSpeed', 'formatTrafficTotal', 'renderNotificationBandwidthSummary', 'renderDockNetworkMonitor', 'recordNetworkStatsBandwidth']) {
  const start = source.indexOf('  function ' + name + '(');
  assert(start >= 0, name);
  vm.runInNewContext(source.slice(start, source.indexOf('\n  function ', start + 1)), scope);
}
scope.renderDockNetworkMonitor();
assert.equal(speed.textContent, '-- KB/s');
scope.recordNetworkStatsBandwidth({type: 'network_stats', upload_kbps: 8192, download_kbps: 8, latency_ms: 23.6});
assert.equal(speed.textContent, '↓ 1000 KB/s', 'Convert kilobits to bytes and use client receive direction');
assert.equal(latency.textContent, 'RTT 24 ms');
assert.equal(total.textContent, '1.00 GB', 'Total stays in the notification center');
assert(recordedBytes > 0);
const bytesBeforeIdle = recordedBytes;
now += 2000;
scope.recordNetworkStatsBandwidth({type: 'network_stats', upload_kbps: 0, download_kbps: 0, latency_ms: 0});
assert.equal(speed.textContent, '↓ 0.0 KB/s', 'An idle sample must clear the previous rate');
assert.equal(latency.textContent, 'RTT 0 ms', 'Zero latency is valid');
assert.equal(recordedBytes, bytesBeforeIdle, 'Idle samples do not add traffic');
scope.recordNetworkStatsBandwidth({type: 'network_stats', upload_kbps: 0, download_kbps: 16384});
assert.equal(speed.textContent, '↑ 1.95 MB/s');
assert.equal(latency.textContent, 'RTT -- ms', 'Missing RTT is not a zero measurement');
now += 10001;
scope.renderDockNetworkMonitor();
assert.equal(speed.textContent, '-- KB/s', 'Stale samples are not current speed');
now -= 10001;
connected = false;
scope.renderDockNetworkMonitor();
assert.equal(speed.textContent, '-- KB/s', 'Disconnect clears the displayed sample');
scope.dockNetworkMonitorEnabled = false;
scope.renderDockNetworkMonitor();
assert(monitor.hidden);
connected = true;
scope.dockNetworkMonitorEnabled = true;
scope.renderDockNetworkMonitor();
assert(!monitor.hidden);
assert.equal(speed.textContent, '↑ 1.95 MB/s');

// Execute the shipped React element, including its existing change callback.
const bundle = fs.readFileSync(path.join(dashboard, 'assets/index-CzFxBFXa.js'), 'utf8');
const start = bundle.indexOf('p.jsxs("select",{id:"framerateSlider"');
assert(start > 0, 'The native frame rate control must be a select');
const end = bundle.indexOf('})]})', start) + 2;
const elementSource = bundle.slice(start, end);
const jsx = (type, props) => ({type, ...props});
const changes = [];
const renderFps = (current, range) => vm.runInNewContext(elementSource, {
  p: {jsx, jsxs: jsx}, mt: current, O: range ? {framerate: range} : null,
  Bo: event => changes.push(Number(event.target.value))
});
const control = renderFps(30, {min: 8, max: 165});
const options = control.children.filter(Boolean);
assert.deepEqual(options.map(option => option.value), [15, 30, 45, 60, 75, 100, 120]);
for (const option of options) control.onChange({target: {value: String(option.value)}});
assert.deepEqual(changes, [15, 30, 45, 60, 75, 100, 120]);
assert.deepEqual(renderFps(30, {min: 30, max: 60}).children.filter(option => option && !option.disabled).map(option => option.value), [30,45,60]);
const locked = renderFps(50, {min: 50, max: 50});
assert(locked.disabled);
assert.equal(locked.value, 50);
assert.equal(locked.children[0].value, 50, 'A server-locked or legacy value must remain truthful');
assert(renderFps(30, null).disabled, 'Wait for server capabilities before changing FPS');
console.log('Dock monitor: units, direction, totals, idle, missing RTT, stale/disconnected samples and toggle passed');
console.log('Frame rate: seven presets, native callback, server bounds and locked values passed');
