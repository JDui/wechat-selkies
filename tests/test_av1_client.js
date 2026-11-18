const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const base = path.join(__dirname, "../root/usr/share/selkies/selkies-dashboard");
const helper = fs.readFileSync(path.join(base, "src/selkies-av1.js"), "utf8");
const bundle = fs.readFileSync(path.join(base, "assets/index-CzFxBFXa.js"), "utf8");
const transport = bundle.slice(bundle.indexOf("function Ly()"), bundle.indexOf("const ky=", bundle.indexOf("function Ly()")));
const samples = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/av1_samples.json"), "utf8")).samples;
const sample = (name, index = 0) => Uint8Array.from(Buffer.from(samples[name].frames[index].base64, "base64"));
const key = sample("main8-delta"), delta = sample("main8-delta", 1);
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function clock() {
  let now = 0, nextId = 0;
  const timers = new Map();
  return {
    setTimeout(fn, delay = 0) { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(amount) {
      const end = now + amount;
      while (true) {
        const next = [...timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
    }
  };
}

function fixture(options = {}) {
  const time = clock(), decoders = [], saves = [], messages = [], notices = [], events = [];
  const stored = new Map();
  let probes = 0;
  class Frame {
    constructor(frame, init = {}) {
      Object.assign(this, frame || {}, init);
      this.visibleRect = init.visibleRect || frame?.visibleRect || { x: 0, y: 0, width: this.codedWidth, height: this.codedHeight };
      this.displayWidth = init.displayWidth || this.visibleRect.width;
      this.displayHeight = init.displayHeight || this.visibleRect.height;
      this.closed = false;
    }
    close() { this.closed = true; }
  }
  class Decoder {
    constructor(callbacks) { this.callbacks = callbacks; this.state = "unconfigured"; this.chunks = []; this.configures = 0; decoders.push(this); }
    static isConfigSupported(config) { probes++; return options.probe ? options.probe(config, probes) : Promise.resolve({ supported: true }); }
    configure(config) { assert.notEqual(this.state, "closed"); this.config = config; this.configures++; this.state = "configured"; }
    decode(chunk) { assert.equal(this.state, "configured"); if (options.decodeError) throw options.decodeError; this.chunks.push(chunk); }
    close() { this.state = "closed"; }
  }
  const document = {
    body: { appendChild(node) { notices.push(node); } },
    createElement() { return { setAttribute() {}, style: {}, remove() {} }; }
  };
  const window = { isSecureContext: options.secure !== false,
    VideoDecoder: options.noApi ? undefined : Decoder, VideoFrame: Frame,
    selkiesPreferences: { save: (name, value) => saves.push([name, value]) },
    dispatchEvent: event => events.push(event.type), postMessage: message => messages.push(message) };
  const scope = vm.createContext({ window, document, console: { log() {}, warn() {}, error() {} },
    location: { href: "https://example.test/box/" + (options.hash || ""), hash: options.hash || "", origin: "https://example.test" },
    localStorage: { setItem: (name, value) => stored.set(name, String(value)) },
    Event: class Event { constructor(type) { this.type = type; } },
    Uint8Array, ArrayBuffer, DataView, Map, Set,
    VideoDecoder: Decoder, VideoFrame: Frame, EncodedVideoChunk: class Chunk { constructor(init) { Object.assign(this, init); } },
    performance: { now: () => 1 }, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout
  });
  vm.runInContext(helper, scope);
  function output(decoder, index, width = 128, height = 96) {
    const frame = new Frame(null, { timestamp: decoder.chunks[index]?.timestamp || 1, codedWidth: width, codedHeight: height });
    decoder.callbacks.output(frame);
    return frame;
  }
  return { api: window.selkiesAv1, scope, time, decoders, saves, messages, notices, events, stored, output };
}

function packet(data = key, isKey = true, id = 1, width = 128, height = 96) {
  const result = new Uint8Array(10 + data.length);
  const view = new DataView(result.buffer);
  view.setUint8(0, 6); view.setUint8(1, isKey ? 1 : 0); view.setUint16(2, id);
  view.setUint16(6, width); view.setUint16(8, height); result.set(data, 10);
  return result.buffer;
}

function shipped(start, end) {
  const a = transport.indexOf(start), b = transport.indexOf(end, a);
  assert(a >= 0 && b > a, "transport fixture anchors must match the shipped bundle");
  return transport.slice(a, b);
}

function wireTransport(f, shared = false) {
  const noop = () => {};
  Object.assign(f.scope, {
    A: shared, w: "websockets", Ae: "av1enc", ze: true, Ye: shared ? "awaiting_identification" : "ready", yt: null,
    j: 0, n: null, Gt: {}, Za: [], axiAv1Decoder: null, se: -1, zi: new Set(), E: null, Oe: "primary", oe: false,
    H: 128, J: 96, c: { width: 128, height: 96 }, h: { setTransform: noop, clearRect: noop },
    $n: noop, li: noop, ga: noop, Pt: noop, ji: noop, ve: async () => true,
    Ne: { classList: { remove: noop } }, clearInterval: noop,
    WebSocket: { OPEN: 1 }, f: { readyState: 1, send: noop, close() { this.readyState = 3; } }
  });
  f.scope.window.selkiesHevc = { config: () => ({ codec: "hev1.1.6.L120.B0" }), fallback: noop };
  const fragments = [
    shipped("function Pa(){", "function El("),
    shipped("function El(_){", "let Za=[];"),
    shipped("function axiClearStripeFrames(){", "function Ml("),
    shipped('function on(_="unknown")', "function ja("),
    shipped("f.onmessage=G=>{", ",f.onerror=G=>{")
  ];
  vm.runInContext(fragments.join("\n"), f.scope);
  return data => f.scope.f.onmessage({ data });
}

(async () => {
  const f = fixture(); await f.api.ready;
  for (const [name, codec, width, height] of [
    ["main8-delta", "av01.0.00M.08", 128, 96], ["main8-still", "av01.0.00M.08", 128, 96],
    ["main8-1080p", "av01.0.08M.08", 1920, 1080], ["main8-1366", "av01.0.05M.08", 1366, 768]
  ]) {
    const source = samples[name].frames ? sample(name) : Uint8Array.from(Buffer.from(samples[name].sequenceObuBase64, "base64"));
    const parsed = f.api.parseSequence(source);
    assert.equal(parsed.codec, codec); assert.equal(parsed.width, width); assert.equal(parsed.height, height);
    assert.equal(parsed.bitDepth, 8);
    assert.equal(parsed.reduced, name === "main8-still");
  }
  assert.throws(() => f.api.parseSequence(Buffer.from(samples["main10-reject"].sequenceObuBase64, "base64")), /8-bit 4:2:0/);
  assert.throws(() => f.api.parseSequence(delta), /no sequence header/);
  assert.throws(() => f.api.parseSequence(key.subarray(0, 8)), /Truncated/);
  assert.throws(() => f.api.parseSequence(Uint8Array.from([0x0a, 0x80])), /Truncated/);
  assert.throws(() => f.api.parseSequence(Uint8Array.from([0x8a, 0])), /Invalid AV1 OBU header/);
  const tooManyObus = new Uint8Array(4097 * 2);
  for (let i = 0; i < tooManyObus.length; i += 2) tooManyObus[i] = 0x12;
  assert.throws(() => f.api.parseSequence(tooManyObus), /too many OBUs/,
    "Small zero-length OBUs must not expand into an unbounded object array");
  const wrongType = new Uint8Array(packet()); wrongType[0] = 4;
  assert.throws(() => f.api.parsePacket(wrongType), /packet header/);
  const wrongY = new Uint8Array(packet()); wrongY[5] = 1;
  assert.throws(() => f.api.parsePacket(wrongY), /full-frame geometry/);

  const errors = [], delivered = [];
  const session = f.api.createDecoder({ output: (frame, info) => delivered.push({ frame, info }), error: error => errors.push(error.message) });
  assert.equal(session.push(packet(delta, false)), false, "a fresh decoder waits for a keyframe");
  assert.equal(session.push(packet()), true);
  assert.equal(session.push(packet(delta, false, 2)), true, "delta queued while configuration is pending");
  await settle();
  assert.deepEqual(f.decoders[0].chunks.map(chunk => chunk.type), ["key", "delta"]);
  f.output(f.decoders[0], 0); f.output(f.decoders[0], 1);
  assert.deepEqual(delivered.map(item => item.info.frameId), [1, 2]);
  assert.equal(session.diagnostics().queuedBytes, 0);
  assert.equal(f.api.diagnostics().session.framesDecoded, 2);
  assert.equal(f.api.diagnostics().hardwareVerified, false);
  session.close(); f.time.advance(9000);
  assert.deepEqual(errors, []);
  assert.equal(f.api.diagnostics().session.state, "closed");

  const crop = fixture(); await crop.api.ready;
  const cropped = [];
  const cropSession = crop.api.createDecoder({ output: (frame, info) => cropped.push({ frame, info }) });
  cropSession.push(packet(key, true, 1, 126, 94)); await settle();
  const padded = crop.output(crop.decoders[0], 0);
  assert.equal(padded.closed, true);
  assert.equal(cropped[0].frame.visibleRect.width, 126); assert.equal(cropped[0].frame.visibleRect.height, 94);
  assert.equal(cropped[0].frame.displayHeight, 94, "coded padding is cropped without rescaling source pixels");
  cropSession.close();

  const bounded = fixture(); await bounded.api.ready;
  const limitErrors = [];
  const boundedSession = bounded.api.createDecoder({ error: error => limitErrors.push(error.message) });
  boundedSession.push(packet()); await settle();
  const largeDelta = new Uint8Array(16 * 1024 * 1024);
  assert.equal(boundedSession.push({ data: largeDelta, key: false, frameId: 2, y: 0, width: 128, height: 96 }), true);
  assert(boundedSession.diagnostics().queuedBytes > 16 * 1024 * 1024);
  assert.equal(boundedSession.push({ data: largeDelta, key: false, frameId: 3, y: 0, width: 128, height: 96 }), false);
  assert.match(limitErrors[0], /queue exceeded/);
  assert.equal(boundedSession.diagnostics().queuedBytes, 0);

  const timeout = fixture(); await timeout.api.ready;
  const timeoutErrors = [];
  const waiting = timeout.api.createDecoder({ error: error => timeoutErrors.push(error.message) });
  waiting.expectFrame(); timeout.time.advance(8000);
  assert.match(timeoutErrors[0], /produced no frame/);

  let releaseProbe;
  const stale = fixture({ probe: (_config, count) => count === 1 ? Promise.resolve({ supported: true }) : new Promise(resolve => { releaseProbe = resolve; }) });
  await stale.api.ready;
  const staleErrors = [];
  const closed = stale.api.createDecoder({ error: error => staleErrors.push(error.message) });
  closed.push(packet()); closed.close(); releaseProbe({ supported: true }); await settle(); stale.time.advance(10000);
  assert.equal(stale.decoders[0].configures, 0, "late capability replies cannot reopen a closed decoder");
  const lateFrame = stale.output(stale.decoders[0], 0);
  assert.equal(lateFrame.closed, true); assert.deepEqual(staleErrors, []);

  const refused = fixture({ probe: (_config, count) => Promise.resolve({ supported: count === 1 }) });
  await refused.api.ready; const refusedErrors = [];
  const refusedSession = refused.api.createDecoder({ error: error => refusedErrors.push(error.message) });
  refusedSession.push(packet()); await settle();
  assert.match(refusedErrors[0], /configuration is unsupported/);
  assert.equal(refused.decoders[0].state, "closed");

  const incomplete = fixture(); await incomplete.api.ready; const incompleteErrors = [];
  const incompleteSession = incomplete.api.createDecoder({ error: error => incompleteErrors.push(error.message) });
  const sequenceOnly = Buffer.from(samples["main8-1080p"].sequenceObuBase64, "base64");
  assert.equal(incompleteSession.push(packet(sequenceOnly, true, 1, 1920, 1080)), false);
  assert.match(incompleteErrors[0], /no frame header/);

  const insecure = fixture({ secure: false }); await insecure.api.ready;
  assert.equal(insecure.api.diagnostics().reason, "insecure-context");
  const missing = fixture({ noApi: true }); await missing.api.ready;
  assert.equal(missing.api.diagnostics().reason, "webcodecs-unavailable");
  const never = fixture({ probe: () => new Promise(() => {}) });
  never.time.advance(3000); await never.api.ready;
  assert.equal(never.api.diagnostics().reason, "probe-timeout");

  const viewer = fixture(); await viewer.api.ready;
  viewer.api.fallback("codec-unsupported", true);
  assert.equal(viewer.saves.length, 0); assert.equal(viewer.messages.length, 0); assert.equal(viewer.stored.size, 0);
  assert.match(viewer.notices[0].textContent, /主控端/);
  const controller = fixture({ hash: "#display2" }); await controller.api.ready;
  controller.api.fallback("codec-unsupported", false);
  assert.deepEqual(controller.saves, [["encoder_display2", "x264enc"]]);
  assert.equal(controller.messages[0].settings.displayId, "display2");
  assert.deepEqual(Object.keys(controller.messages[0].settings).sort(), ["displayId", "encoder"]);

  const primary = fixture(); await primary.api.ready;
  const receivePrimary = wireTransport(primary);
  receivePrimary(packet(key, true, 42)); await settle(); primary.output(primary.decoders[0], 0);
  assert.equal(primary.scope.se, 42); assert(primary.scope.zi.has(42));
  receivePrimary("PIPELINE_RESETTING primary");
  assert.equal(primary.decoders[0].state, "closed");
  receivePrimary(packet(key, true, 43)); await settle(); primary.output(primary.decoders[1], 0);
  assert.equal(primary.scope.Za.length, 1); assert.equal(primary.scope.se, 43);

  const shared = fixture(); await shared.api.ready;
  const receiveShared = wireTransport(shared, true);
  receiveShared(packet()); await settle(); const firstShared = shared.output(shared.decoders[0], 0);
  assert.equal(shared.scope.Ye, "ready"); assert.equal(shared.scope.Ae, "av1enc");
  assert.equal(shared.scope.se, -1, "viewers do not ACK or change controller state");
  for (let i = 1; i <= 20; i++) {
    receiveShared(packet(delta, false, i + 1));
    shared.output(shared.decoders[0], i);
    assert.equal(shared.scope.Za.length, 1, "full-frame output only retains the latest image while painting is paused");
  }
  assert.equal(firstShared.closed, true);
  receiveShared("AV1_ENCODER_FALLBACK,unavailable");
  assert.equal(shared.saves.length, 0); assert.equal(shared.messages.length, 0);

  const hevc = fixture(); await hevc.api.ready;
  const receiveHevc = wireTransport(hevc, true);
  const hevcPacket = new Uint8Array(packet()); hevcPacket[0] = 5;
  receiveHevc(hevcPacket.buffer); await settle();
  assert.equal(hevc.scope.Ye, "ready"); assert.equal(hevc.scope.Ae, "h265enc");
  receiveHevc(hevcPacket.buffer);
  assert.equal(hevc.decoders[0].chunks.length, 2, "the existing HEVC shared path also accepts subsequent matching packets");

  const killed = fixture(); await killed.api.ready;
  const receiveKilled = wireTransport(killed);
  receiveKilled(packet()); await settle(); const discarded = killed.output(killed.decoders[0], 0);
  receiveKilled("KILL session replaced"); killed.time.advance(10000);
  assert.equal(discarded.closed, true); assert.equal(killed.scope.Za.length, 0);
  assert.equal(killed.decoders[0].state, "closed"); assert.equal(killed.saves.length, 0);

  const overrides = fs.readFileSync(path.join(base, "src/selkies-runtime-overrides.js"), "utf8");
  const begin = overrides.indexOf("  function sanitizeSettingsPayload("), end = overrides.indexOf("  function sanitizeServerSettingDefinitions(", begin);
  vm.runInContext(overrides.slice(begin, end), f.scope);
  const settings = f.scope.sanitizeSettingsPayload({ encoder: "av1enc", use_cpu: true, framerate: 45 });
  assert.equal(settings.av1_supported, true); assert.equal(settings.use_cpu, false); assert.equal(settings.framerate, 45);
  assert.equal(f.scope.sanitizeSettingsPayload({ encoder: "x264enc", use_cpu: true }).use_cpu, true);
  console.log("PASS AV1: real sequence fixtures, bounded decoding, cropping, timeouts, late callbacks, shared routing, ACK/reset/KILL, fallback and capability negotiation");
})().catch(error => { console.error(error); process.exitCode = 1; });
