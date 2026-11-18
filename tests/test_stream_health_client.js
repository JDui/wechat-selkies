const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname,
  '../root/usr/share/selkies/selkies-dashboard/src/selkies-stream-health.js'), 'utf8');

function fixture(autoStart = true) {
  let now = 0, timerId = 0;
  const intervals = new Map(), listeners = new Map();
  const document = { hidden: false, addEventListener(name, fn) { listeners.set(name, fn); } };
  const window = { performance: { now: () => now },
    setInterval(fn, ms) { intervals.set(++timerId, { fn, ms, at: now + ms }); return timerId; } };
  vm.runInNewContext(source, { window, document, ArrayBuffer, DataView, Map, Set, Number, Date, Object, Math });
  const health = window.__selkiesStreamHealth;
  if (autoStart) health.start();
  return { health, document, intervals,
    advance(ms) {
      const end = now + ms;
      while (true) {
        const upcoming = [...intervals.values()].sort((a, b) => a.at - b.at)[0];
        if (!upcoming || upcoming.at > end) break;
        now = upcoming.at; upcoming.at += upcoming.ms; upcoming.fn();
      }
      now = end;
    },
    block(ms) { now += ms; for (const task of intervals.values()) { task.at = now + task.ms; task.fn(); } },
    hide(hidden) { document.hidden = hidden; listeners.get('visibilitychange')(); },
    connect(display = 'primary', role = 'controller') {
      const socket = { sends: 0, send() { this.sends += 1; } };
      assert(health.connect(socket, display)); health.setRole(socket, role); health.opened(socket);
      return socket;
    }
  };
}
function packet(type = 6, id = 1, role = 'controller') {
  const header = type === 0 ? (role === 'controller' ? 4 : 2) : type === 3 ? (role === 'controller' ? 6 : 4) : 10;
  const bytes = new ArrayBuffer(header + 1), view = new DataView(bytes);
  view.setUint8(0, type); view.setUint8(1, 1);
  if (header >= 6 || type === 0 && role === 'controller') view.setUint16(2, id);
  if (type >= 4) { view.setUint16(6, 1920); view.setUint16(8, 1080); }
  return bytes;
}
let checks = 0;
function test(name, fn) { fn(); checks += 1; console.log('PASS ' + name); }

test('static desktop never becomes stalled merely because its last frame is old', () => {
  const f = fixture(), ws = f.connect();
  f.health.packet(ws, packet()); assert(f.health.frameRendered('primary', 1));
  f.advance(120000);
  assert.equal(f.health.stalledFor(), 0); assert(!f.health.diagnostics().stallActive);
  assert.equal(f.health.diagnostics().displays[0].framesRendered, 1);
});

test('AV1 pending output triggers a hint after startup grace and exposes real stall duration', () => {
  const f = fixture(), ws = f.connect();
  assert(f.health.packet(ws, packet(6, 9)));
  f.advance(3000); assert.equal(f.health.stalledFor(), 0); assert(!f.health.diagnostics().stallActive);
  f.advance(500); assert.equal(f.health.stalledFor(), 500); assert(f.health.diagnostics().stallActive);
  f.advance(12000); assert.equal(f.health.stalledFor(), 12500);
  const state = f.health.diagnostics();
  assert.equal(state.stallReason, 'render_timeout'); assert(state.displays[0].stallCount <= 14);
  assert.equal(ws.sends, 0);
});

test('actual output clears pending work but keeps a brief incident pulse', () => {
  const f = fixture(), ws = f.connect();
  f.health.packet(ws, packet()); f.advance(3500);
  let outputs = 0; f.health.onFrameRendered = () => { outputs += 1; };
  assert(f.health.frameRendered('primary', 1)); assert.equal(outputs, 1);
  assert.equal(f.health.stalledFor(), 0); assert(f.health.diagnostics().stallActive);
  f.advance(2500); assert(!f.health.diagnostics().stallActive);
});

test('VIDEO_STARTED does not discard received work or declare a rendered frame', () => {
  const f = fixture(), ws = f.connect(); let outputs = 0;
  f.health.onFrameRendered = () => { outputs += 1; };
  f.health.packet(ws, packet()); f.advance(3500);
  f.health.pipeline(ws, true); assert.equal(f.health.stalledFor(), 500);
  assert.equal(f.health.diagnostics().displays[0].pendingFrames, 1);
  assert.equal(outputs, 0); assert.equal(f.health.diagnostics().displays[0].framesRendered, 0);
  f.health.packet(ws, packet(6, 2)); f.health.reset(ws); f.advance(10000);
  assert(!f.health.diagnostics().stallActive); assert.equal(f.health.stalledFor(), 0);
});

test('repeated pipeline status is idempotent while STOP to START grants new grace', () => {
  const f = fixture(), ws = f.connect();
  f.advance(3000); f.health.packet(ws, packet());
  for (let step = 0; step < 8; step += 1) {
    f.advance(250); f.health.pipeline(ws, true);
  }
  assert.equal(f.health.stalledFor(), 2000);
  assert.equal(f.health.diagnostics().displays[0].pendingFrames, 1);
  f.health.pipeline(ws, false); assert.equal(f.health.stalledFor(), 0);
  assert.equal(f.health.diagnostics().displays[0].pendingFrames, 0);
  f.advance(1000); f.health.pipeline(ws, false); f.health.pipeline(ws, true);
  f.health.packet(ws, packet(6, 2)); f.advance(3000);
  assert.equal(f.health.stalledFor(), 0); assert(!f.health.diagnostics().stallActive);
  f.advance(500); assert.equal(f.health.stalledFor(), 500); assert(f.health.diagnostics().stallActive);
});

test('stripe duplicates, frame number jumps and wraparound are not packet loss', () => {
  const f = fixture(), ws = f.connect();
  for (const id of [65534, 65534, 65535, 0, 7, 7]) f.health.packet(ws, packet(4, id));
  assert.equal(f.health.diagnostics().displays[0].pendingFrames, 4);
  assert(f.health.frameRendered('primary', 0));
  assert.equal(f.health.diagnostics().displays[0].pendingFrames, 1);
  assert(!f.health.frameRendered('primary', 65535));
  assert.equal(f.health.diagnostics().displays[0].pendingFrames, 1);
  assert(!f.health.diagnostics().dropActive);
  assert(f.health.frameRendered('primary', 7));
});

test('old sockets cannot mutate the replacement connection or report old failures', () => {
  const f = fixture(), old = f.connect(), current = f.connect();
  f.health.packet(current, packet(6, 8));
  assert(!f.health.packet(old, packet(6, 9)));
  assert(!f.health.closed(old, { code: 1006 })); assert(!f.health.pipeline(old, false));
  assert(!f.health.serverEvent(old, { display_id: 'primary', kind: 'drop', reason: 'video_queue_overflow' }));
  assert(!f.health.frameRendered('primary', 7));
  assert.equal(f.health.connection().socket, current);
  assert.equal(f.health.diagnostics().displays[0].pendingFrames, 1);
  assert(!f.health.diagnostics().dropActive);
});

test('reconnection keeps a recent real incident briefly without inventing another loss', () => {
  const f = fixture(), old = f.connect();
  f.health.packet(old, packet()); f.health.closed(old, { code: 1006 });
  const replacement = f.connect();
  assert(f.health.diagnostics().dropActive);
  assert.equal(f.health.diagnostics().displays[0].dropCount, 1);
  f.health.packet(replacement, packet(6, 2)); f.health.frameRendered('primary', 2);
  f.advance(2500); assert(!f.health.diagnostics().dropActive);
  assert.equal(f.health.diagnostics().displays[0].dropCount, 1);
});

test('hidden, stopped and suspended streams do not accumulate expectations', () => {
  const f = fixture(), ws = f.connect();
  f.health.packet(ws, packet()); f.hide(true); f.advance(60000);
  assert(!f.health.packet(ws, packet(6, 2))); assert.equal(f.health.stalledFor(), 0);
  f.hide(false); f.health.packet(ws, packet(6, 3)); f.advance(3000); assert(!f.health.diagnostics().stallActive);
  f.health.pipeline(ws, false); assert(!f.health.packet(ws, packet(6, 4))); f.advance(10000);
  assert(!f.health.diagnostics().stallActive);
  f.health.pipeline(ws, true); f.health.setSuspended(true); f.advance(10000);
  assert(!f.health.report('stall', 'decoder_error')); assert.equal(f.health.stalledFor(), 0);
  f.health.setSuspended(false); f.health.packet(ws, packet(6, 5)); f.advance(3499);
  assert(!f.health.diagnostics().stallActive);
});

test('abnormal transport closure requires an established active media session', () => {
  for (const code of [1000, 1001, 4001, 4002, 4003, 4004, 4029]) {
    const f = fixture(), ws = f.connect(); f.health.packet(ws, packet());
    f.health.closed(ws, { code, wasClean: false }); assert(!f.health.diagnostics().dropActive, String(code));
  }
  const f = fixture(), empty = f.connect();
  f.health.closed(empty, { code: 1006 }); assert(!f.health.diagnostics().dropActive);
  const ws = f.connect(); f.health.packet(ws, packet()); f.health.closed(ws, { code: 1006 });
  assert(f.health.diagnostics().dropActive); assert.equal(f.health.diagnostics().dropReason, 'transport_closed');
  assert.equal(f.health.connection(), null); f.advance(2500); assert(!f.health.diagnostics().dropActive);
  const cleanError = f.connect(); f.health.packet(cleanError, packet());
  f.health.closed(cleanError, { code: 1011, wasClean: true });
  assert(f.health.diagnostics().dropActive, 'A clean close handshake can still carry a server failure');
});

test('only finite application reasons and matching server display IDs are accepted, without echo', () => {
  const f = fixture(), ws = f.connect();
  assert(!f.health.report('drop', 'packet_loss_50_percent'));
  assert(!f.health.report('stall', '<script>'));
  assert(!f.health.report('constructor', 'decoder_error'));
  assert(!f.health.serverEvent(ws, { display_id: 'display2', kind: 'drop', reason: 'video_queue_overflow' }));
  assert(f.health.serverEvent(ws, { display_id: 'primary', kind: 'drop', reason: 'video_queue_overflow' }));
  assert.equal(f.health.diagnostics().dropReason, 'video_queue_overflow');
  assert.equal(ws.sends, 0);
});

test('minimum video lengths are checked for AV1, H264, HEVC and viewer legacy headers', () => {
  for (const type of [0, 3, 4, 5, 6]) {
    const f = fixture(), ws = f.connect();
    assert(f.health.packet(ws, packet(type)), String(type));
    const malformed = packet(type).slice(0, -1);
    assert(!f.health.packet(ws, malformed)); assert.equal(f.health.diagnostics().dropReason, 'invalid_video_packet');
  }
  const f = fixture(), ws = f.connect('primary', 'viewer');
  assert(f.health.packet(ws, packet(0, 0, 'viewer'))); assert(f.health.frameRendered('primary', null));
  assert(f.health.packet(ws, packet(3, 0, 'viewer'))); assert(f.health.frameRendered('primary', null));
  assert(!f.health.packet(ws, new Uint8Array([1, 2, 3]).buffer));
  assert(!f.health.diagnostics().dropActive);
});

test('observation memory and event counters stay bounded under repeated failures', () => {
  const f = fixture(), ws = f.connect();
  f.advance(3000);
  for (let id = 0; id < 2000; id += 1) f.health.packet(ws, packet(6, id));
  assert.equal(f.health.diagnostics().displays[0].pendingFrames, 256);
  for (let n = 0; n < 10000; n += 1) f.health.report('drop', 'invalid_video_packet');
  for (let n = 0; n < 1000; n += 1) f.health.report('drop', n % 2 ? 'transport_closed' : 'video_queue_overflow');
  assert.equal(f.health.diagnostics().displays[0].dropCount, 1);
  for (const id of ['display2', 'display3', 'display4']) f.connect(id);
  assert(!f.health.connect({}, 'display5')); assert.equal(f.health.diagnostics().displays.length, 4);
});

test('event loop lag pulses separately, grants fresh grace and never initiates recovery', () => {
  const f = fixture(), ws = f.connect();
  f.advance(3000); f.health.packet(ws, packet()); f.health.frameRendered('primary', 1);
  f.block(1500);
  assert(f.health.diagnostics().stallActive); assert.equal(f.health.diagnostics().stallReason, 'event_loop_lag');
  assert.equal(f.health.stalledFor(), 0); assert.equal(ws.sends, 0);
  assert.equal(f.health.diagnostics().displays[0].lastPacketAt, 3000);
  assert.equal(f.health.diagnostics().displays[0].lastRenderAt, 3000);
  assert.equal(f.health.diagnostics().displays[0].pendingFrames, 0);
  f.advance(3000); assert(!f.health.diagnostics().stallActive);
  f.advance(60000); assert.equal(f.health.stalledFor(), 0); assert(!f.health.diagnostics().stallActive);
  f.hide(true); f.block(5000); f.hide(false);
  assert(!f.health.diagnostics().stallActive);
});

test('event loop lag preserves the final unrendered packet beyond its fresh grace period', () => {
  const f = fixture(), ws = f.connect();
  f.advance(3000); f.health.packet(ws, packet(6, 17));
  f.block(1500);
  let state = f.health.diagnostics();
  assert.equal(state.stallReason, 'event_loop_lag');
  assert.equal(state.displays[0].pendingFrames, 1);
  assert.equal(state.displays[0].framesRendered, 0);
  assert.equal(state.displays[0].lastPacketAt, 3000);
  assert.equal(state.displays[0].lastRenderAt, null);
  assert.equal(state.displays[0].graceRemainingMs, 3000);
  assert.equal(f.health.stalledFor(), 0);
  f.advance(3000);
  assert.equal(f.health.stalledFor(), 0); assert(!f.health.diagnostics().stallActive);
  f.advance(500);
  state = f.health.diagnostics();
  assert.equal(state.stalledForMs, 500); assert(state.stallActive);
  assert.equal(state.stallReason, 'render_timeout');
  assert.equal(state.displays[0].pendingFrames, 1);
  f.advance(12000);
  assert.equal(f.health.stalledFor(), 12500);
  assert.equal(f.health.diagnostics().displays[0].framesRendered, 0);
  assert(!f.health.diagnostics().dropActive); assert.equal(ws.sends, 0);
});

test('real output after event loop lag still clears its preserved pending packet', () => {
  const f = fixture(), ws = f.connect(); let outputs = 0;
  f.health.onFrameRendered = () => { outputs += 1; };
  f.advance(3000); f.health.packet(ws, packet(3, 23));
  f.block(1500); f.advance(200);
  assert(f.health.frameRendered('primary', null));
  const state = f.health.diagnostics().displays[0];
  assert.equal(state.pendingFrames, 0); assert.equal(state.framesRendered, 1);
  assert.equal(state.lastPacketAt, 3000); assert.equal(state.lastRenderAt, 4700);
  assert.equal(outputs, 1);
  f.advance(60000);
  assert.equal(f.health.stalledFor(), 0); assert(!f.health.diagnostics().stallActive);
  assert.equal(f.health.diagnostics().displays[0].stallReasons.render_timeout, undefined);
  assert.equal(ws.sends, 0);
});

test('callback errors are isolated and start never duplicates timers', () => {
  const f = fixture();
  f.health.onChange = () => { throw new Error('UI unavailable'); };
  f.health.onFrameRendered = () => { throw new Error('Listener unavailable'); };
  const ws = f.connect(); f.health.packet(ws, packet());
  assert(f.health.frameRendered('primary', 1));
  f.health.start(); f.health.start(); assert.equal(f.intervals.size, 1);
  f.health.report('stall', 'decoder_error'); f.advance(2500);
  assert(!f.health.diagnostics().stallActive);
});

test('first start grants a fresh observation window and a socket belongs to one display', () => {
  const f = fixture(false), ws = f.connect();
  assert(f.health.packet(ws, packet()));
  assert(!f.health.connect(ws, 'display2'));
  f.health.start(); assert.equal(f.health.diagnostics().displays[0].pendingFrames, 0);
  assert.equal(f.intervals.size, 1);
});

test('multi-display notices keep the active incident reason and do not expose sockets', () => {
  const f = fixture(), primary = f.connect();
  primary.url = 'wss://private.example/secret';
  f.health.report('stall', 'decoder_error', 'primary'); f.advance(100);
  const secondary = f.connect('display2');
  f.health.report('stall', 'ack_timeout', 'display2');
  f.health.pipeline(secondary, false);
  assert.equal(f.health.diagnostics().stallReason, 'decoder_error');
  assert.equal(f.health.connection('primary').socket, primary);
  assert(!JSON.stringify(f.health.diagnostics()).includes('private.example'));
});

test('packet format changes alone cannot keep resetting a stuck output grace period', () => {
  const f = fixture(), ws = f.connect();
  f.advance(3000);
  for (let id = 1; id <= 12; id += 1) {
    f.health.packet(ws, packet(id % 2 ? 4 : 6, id));
    f.advance(250);
  }
  assert.equal(f.health.stalledFor(), 3000);
  assert(f.health.diagnostics().stallActive);
});

test('current socket identity distinguishes replacements before open from unrelated transports', () => {
  const f = fixture(), old = f.connect();
  const unknown = {}, replacement = {};
  assert.equal(f.health.isCurrentSocket(unknown), null);
  assert.equal(f.health.isCurrentSocket(null), null);
  assert.equal(f.health.isCurrentSocket(old), true);
  assert(f.health.connect(replacement, 'primary'));
  assert.equal(f.health.isCurrentSocket(old), false);
  assert.equal(f.health.isCurrentSocket(replacement), true);
  assert.equal(f.health.connection(), null, 'The replacement is registered before its open event');
  assert(!f.health.opened(old)); assert(!f.health.pipeline(old, false));
  assert(!f.health.reset(old)); assert(!f.health.setRole(old, 'controller'));
  assert(!f.health.packet(old, packet())); assert(!f.health.closed(old, { code: 1006 }));
  assert(!f.health.serverEvent(old, { display_id: 'primary', kind: 'drop', reason: 'transport_closed' }));
  f.health.opened(replacement);
  assert.equal(f.health.connection().role, 'unknown');
  assert.equal(f.health.diagnostics().displays[0].packetsReceived, 0);
  assert(!f.health.diagnostics().dropActive);
  assert.equal(f.health.isCurrentSocket(unknown), null);
});

test('JPEG draw batches clear controller frame IDs and viewer anonymous stripes without false stalls', () => {
  for (const role of ['controller', 'viewer']) {
    const f = fixture(), ws = f.connect('primary', role);
    for (const id of [1, 1, 4, 9]) assert(f.health.packet(ws, packet(3, id, role)));
    assert(f.health.frameRendered('primary', null));
    assert.equal(f.health.diagnostics().displays[0].pendingFrames, 0);
    f.advance(60000);
    assert.equal(f.health.stalledFor(), 0); assert(!f.health.diagnostics().stallActive);
    assert(!f.health.diagnostics().dropActive);
  }
});

console.log('Stream health: ' + checks + ' behavior groups passed.');
