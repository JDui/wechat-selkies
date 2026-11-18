const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const base = path.join(__dirname, "../root/usr/share/selkies/selkies-dashboard");
const bundle = fs.readFileSync(path.join(base, "assets/index-CzFxBFXa.js"), "utf8");
const transport = bundle.slice(bundle.indexOf("function Ly()"), bundle.indexOf("const ky=", bundle.indexOf("function Ly()")));
const hevc = fs.readFileSync(path.join(base, "src/selkies-hevc.js"), "utf8");
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function shipped(start, end) {
  const a = transport.indexOf(start), b = transport.indexOf(end, a);
  assert(a >= 0 && b > a, "fixture must execute the shipped decoder / renderer");
  return transport.slice(a, b);
}

function clock() {
  let time = 0, next = 0;
  const tasks = new Map();
  return {
    now: () => time,
    setTimeout(fn, delay) { const id = ++next; tasks.set(id, { fn, at: time + delay }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    advance(ms) {
      const end = time + ms;
      while (true) {
        const due = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        tasks.delete(due[0]); time = due[1].at; due[1].fn();
      }
      time = end;
    }
  };
}

function fixture(options = {}) {
  const time = clock(), decoders = [], sent = [], reports = [], renders = [], drawn = [], raf = new Map();
  let rafId = 0;
  class Decoder {
    constructor(callbacks) { this.callbacks = callbacks; this.state = "unconfigured"; this.chunks = []; decoders.push(this); }
    static isConfigSupported(config) { return options.probe ? options.probe(config) : Promise.resolve({ supported: true }); }
    configure(config) { assert.notEqual(this.state, "closed"); this.config = config; this.state = "configured"; }
    decode(chunk) { assert.equal(this.state, "configured"); if (options.decodeError) throw options.decodeError; this.chunks.push(chunk); }
    close() { this.state = "closed"; }
  }
  const noop = () => {};
  const scope = vm.createContext({
    console: { warn: noop, error: noop, log: noop }, Map, Set,
    performance: { now: time.now }, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    VideoDecoder: Decoder, EncodedVideoChunk: class Chunk { constructor(init) { Object.assign(this, init); } },
    window: { devicePixelRatio: 1, selkiesHevc: { config: () => ({ codec: "hev1.1.6.L120.B0" }), fallback: noop },
      __selkiesStreamHealth: { report: (...args) => reports.push(args), frameRendered: (...args) => renders.push(args) } },
    document: { hidden: !!options.hidden },
    Gt: {}, axiAv1Decoder: null, axiStripeTimestamp: 0, axiLastDecoderRecoveryAt: -Infinity,
    A: !!options.shared, ze: true, oe: true, Oe: options.display || "primary", Ae: "x264enc", Ye: "ready",
    WebSocket: { OPEN: 1 }, f: { readyState: 1, send: message => sent.push(message) },
    c: { width: 1920, height: 1080 }, h: { drawImage: frame => { if (frame.bad) throw new Error("stale surface"); drawn.push(frame); } },
    ft: false, H: 1920, J: 1080, Fi: true, Ka: true, Fe: [], Se: [], Ya: 0,
    Ve: value => value, Pt: noop, bi: noop, an: noop,
    requestAnimationFrame(fn) { const id = ++rafId; raf.set(id, fn); return id; }
  });
  vm.runInContext(shipped("function Pa(){", "function Ml(") + shipped("let axiPaintRequest=null;", "async function te(){"), scope);
  function push(id = 1, key = true, y = 0, width = 1920, height = 1080, bytes = 4, type = 4) {
    scope.axiPushStripePacket(type, key ? 1 : 0, id, y, width, height, new Uint8Array(bytes));
  }
  function output(decoder, index, extra = {}) {
    const frame = Object.assign({ timestamp: decoder.chunks[index].timestamp, codedWidth: 1920, codedHeight: 1080,
      closed: false, close() { this.closed = true; } }, extra);
    decoder.callbacks.output(frame);
    return frame;
  }
  function paint() {
    const next = raf.entries().next().value;
    assert(next, "paint chain must remain scheduled"); raf.delete(next[0]); next[1]();
  }
  return { scope, time, decoders, sent, reports, renders, drawn, raf, push, output, paint,
    frames: () => vm.runInContext("Za", scope) };
}

(async () => {
  // A delayed support answer from an old decoder cannot configure, delete or
  // close the new decoder at the same stripe position.
  const probes = [];
  const stale = fixture({ probe: () => new Promise(resolve => probes.push(resolve)) });
  stale.push(7); const old = stale.decoders[0];
  stale.scope.Pa(); stale.push(8); const replacement = stale.decoders[1];
  probes[1]({ supported: true }); await settle();
  probes[0]({ supported: false }); await settle();
  assert.equal(replacement.state, "configured");
  assert.equal(stale.scope.Gt[0].decoder, replacement);
  assert.equal(old.state, "closed");
  const late = { timestamp: 1, close() { this.closed = true; } };
  old.callbacks.output(late);
  old.callbacks.error(new Error("late closed-decoder error"));
  assert(late.closed); assert.equal(stale.frames().length, 0); assert.deepEqual(stale.sent, []);
  stale.scope.Pa();

  // Resolution changes during an unresolved probe also replace the instance,
  // and a later supported answer cannot revive the old one.
  const resizeProbes = [];
  const resize = fixture({ probe: () => new Promise(resolve => resizeProbes.push(resolve)) });
  resize.push(1, true, 0, 1280, 720);
  resize.push(2, true, 0, 1920, 1080);
  resizeProbes[0]({ supported: true }); resizeProbes[1]({ supported: true }); await settle();
  assert.equal(resize.decoders[0].state, "closed");
  assert.equal(resize.decoders[1].config.codedWidth, 1920);
  resize.scope.Pa();

  const normal = fixture();
  normal.push(101); await settle(); normal.push(102, false);
  const first = normal.output(normal.decoders[0], 0), second = normal.output(normal.decoders[0], 1);
  assert(first.closed, "decoded pictures for the same stripe coalesce without retaining stale surfaces");
  assert.equal(normal.frames().length, 1);
  assert.equal(normal.frames()[0].vncFrameID, 102, "output identity follows each input timestamp, not the first keyframe");
  assert.equal(normal.scope.Gt[0].queuedBytes, 0);
  normal.scope.axiSchedulePaint(); normal.scope.axiSchedulePaint();
  assert.equal(normal.raf.size, 1, "MODE / reconnect scheduling must not create duplicate RAF chains");
  normal.paint();
  assert.deepEqual(normal.renders, [["primary", 102]]); assert(second.closed);
  normal.time.advance(30000);
  assert.deepEqual(normal.sent, [], "an idle static image with no pending decode must not time out");
  normal.scope.Pa();

  const render = fixture({ display: "display2" });
  render.push(1, true, 0, 1920, 540); render.push(1, true, 540, 1920, 540); await settle();
  const bad = render.output(render.decoders[0], 0, { bad: true });
  const good = render.output(render.decoders[1], 0);
  render.scope.axiSchedulePaint(); render.paint();
  assert(bad.closed && good.closed, "every dequeued VideoFrame is closed even if drawImage throws");
  assert.deepEqual(render.renders, [["display2", 1]], "only a successful canvas draw is progress");
  assert.deepEqual(render.reports, [["stall", "render_error", "display2"]]);
  assert.equal(render.raf.size, 1, "a draw exception cannot terminate the RAF chain");
  render.push(2, false, 0, 1920, 540); render.output(render.decoders[0], 1); render.paint();
  assert.equal(render.renders.length, 2, "the next decoded picture is displayed after a drawing error");
  render.scope.window.__selkiesStreamHealth.frameRendered = () => { throw new Error("diagnostic hook failed"); };
  render.scope.window.__selkiesStreamHealth.report = () => { throw new Error("diagnostic hook failed"); };
  render.push(3, false, 0, 1920, 540); const hookFrame = render.output(render.decoders[0], 2); render.paint();
  assert(hookFrame.closed); assert.equal(render.raf.size, 1, "optional health hooks cannot interrupt rendering");
  render.scope.Pa();

  // Pending and already-submitted pictures use the same bounded queue budget.
  for (const stalledProbe of [false, true]) {
    const bounded = fixture({ probe: stalledProbe ? () => new Promise(() => {}) : undefined });
    bounded.push(); await settle();
    for (let id = 2; id <= 49; id++) bounded.push(id, false);
    assert.equal(Object.keys(bounded.scope.Gt).length, 0);
    assert.equal(bounded.decoders[0].state, "closed");
    assert.deepEqual(bounded.sent, ["FORCE_STREAM_RECOVER,primary,video"]);
    assert.equal(bounded.reports.at(-1)[1], "decoder_queue_overflow");
  }

  const byteLimit = fixture({ probe: () => new Promise(() => {}) });
  byteLimit.push(1, true, 0, 1920, 1080, 16 * 1024 * 1024);
  byteLimit.push(2, false, 0, 1920, 1080, 16 * 1024 * 1024);
  byteLimit.push(3, false);
  assert.equal(byteLimit.reports.at(-1)[1], "decoder_queue_overflow");
  assert.equal(byteLimit.decoders[0].state, "closed");

  for (const options of [{}, { shared: true }, { hidden: true }, { display: "display2" }]) {
    const timeout = fixture({ ...options, probe: () => new Promise(() => {}) });
    timeout.push(); timeout.time.advance(8000);
    assert.equal(timeout.decoders[0].state, "closed");
    assert.deepEqual(timeout.sent, options.hidden ? [] : [options.shared ? "START_VIDEO" :
      "FORCE_STREAM_RECOVER," + (options.display || "primary") + ",video"]);
    timeout.time.advance(8000);
    assert(timeout.sent.length <= 1, "retired timeout callbacks cannot form a recovery loop");
  }

  const recovering = fixture({ decodeError: new Error("decoder temporarily unavailable") });
  recovering.push(); await settle(); recovering.push(2); await settle();
  assert.equal(recovering.sent.length, 1, "transient decoder recovery requests are throttled for five seconds");
  recovering.time.advance(5000); recovering.push(3); await settle();
  assert.equal(recovering.sent.length, 2);

  // A shared tab whose background decoder was reclaimed must request a new
  // keyframe on return, without resetting the controller's capture pipeline.
  for (const codec of ["x264enc", "x264enc-striped", "h265enc", "av1enc"]) {
    const shared = fixture({ shared: true });
    shared.scope.Ae = codec;
    shared.scope.document.addEventListener = (_name, callback) => { shared.visible = callback; };
    vm.runInContext(shipped('document.addEventListener("visibilitychange",async()=>{', 'async function z(G,N){'), shared.scope);
    await shared.visible();
    assert.deepEqual(shared.sent, ["START_VIDEO"]);
    assert.equal(shared.scope.oe, false);
    shared.scope.document.hidden = true; await shared.visible();
    assert.equal(shared.sent.length, 1);
  }

  // The helper is awaited before the whole dashboard starts. A stuck HEVC
  // capability probe must settle and permit H.264 / other UI initialization.
  const probeTime = clock();
  const hevcWindow = { isSecureContext: true, VideoDecoder: { isConfigSupported: () => new Promise(() => {}) } };
  vm.runInNewContext(hevc, { window: hevcWindow, VideoDecoder: hevcWindow.VideoDecoder,
    location: { href: "https://example.test/", hash: "", origin: "https://example.test" },
    setTimeout: probeTime.setTimeout, clearTimeout: probeTime.clearTimeout });
  probeTime.advance(3000); await hevcWindow.selkiesHevc.ready;
  assert.equal(hevcWindow.selkiesHevc.supported(), false);
  assert.throws(() => hevcWindow.selkiesHevc.config(1920, 1080, new Uint8Array([0, 0, 1, 1])), /no SPS/);

  const fallbackTime = clock(), messages = [];
  const fallbackWindow = { isSecureContext: false, dispatchEvent() {}, postMessage: message => messages.push(message) };
  vm.runInNewContext(hevc, { window: fallbackWindow, console: { warn() {} },
    location: { href: "https://example.test/", hash: "", origin: "https://example.test" },
    localStorage: { setItem() { throw new Error("storage unavailable"); } },
    document: { createElement: () => ({ style: {}, setAttribute() {}, remove() {} }), body: { appendChild() {} } },
    Event: class Event {}, setTimeout: fallbackTime.setTimeout, clearTimeout: fallbackTime.clearTimeout });
  fallbackWindow.selkiesHevc.fallback("unsupported");
  assert.equal(messages[0].settings.encoder, "x264enc", "storage failure cannot prevent the codec fallback command");

  console.log("PASS video decode recovery: stale probes / output, geometry change, queue bounds, actual draw progress, RAF resilience, scoped recovery and HEVC probe timeout");
})().catch(error => { console.error(error); process.exitCode = 1; });
