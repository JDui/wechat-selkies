const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const base = path.join(__dirname, "../root/usr/share/selkies/selkies-dashboard");
const runtime = fs.readFileSync(path.join(base, "src/selkies-runtime-overrides.js"), "utf8");
const helper = fs.readFileSync(path.join(base, "src/selkies-stream-health.js"), "utf8");
function shipped(name) {
  const start = runtime.indexOf("  function " + name + "(");
  assert(start >= 0, name);
  const tail = runtime.slice(start + 2);
  const end = tail.search(/\n  (?:async )?function /);
  assert(end > 0, name + " end");
  return tail.slice(0, end);
}

class Node {
  constructor() { this.children = []; this.attributes = {}; this.className = ""; this.style = { setProperty() {}, removeProperty() {} }; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return Object.hasOwn(this.attributes, key) ? this.attributes[key] : null; }
  removeAttribute(key) { delete this.attributes[key]; }
  appendChild(node) { node.parentElement = this; this.children.push(node); }
  removeChild(node) { this.children = this.children.filter(child => child !== node); node.parentElement = null; }
  querySelector(selector) { return this.children.find(child => child.className.split(" ").includes(selector.slice(1))) || null; }
}

function fixture() {
  let at = 100000;
  const noop = () => {};
  const toggle = new Node(), head = new Node(), windowListeners = new Map();
  toggle.setAttribute("title", "打开侧边栏");
  const document = { hidden: false, hasFocus: () => true, head,
    createElement: () => new Node(), getElementById: () => null, addEventListener: noop };
  class Socket {
    static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3;
    constructor() { this.readyState = 0; this.listeners = {}; this.sent = []; }
    send(message) { this.sent.push(message); }
    close() { this.readyState = 3; }
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
    emit(name, data) {
      const event = { data, stopImmediatePropagation() { this.stopped = true; } };
      if (name === "open") this.readyState = 1;
      for (const listener of this.listeners[name] || []) { listener(event); if (event.stopped) break; }
      return event;
    }
  }
  const window = { WebSocket: Socket, performance: { now: () => at }, location: { origin: "https://example.test" },
    setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1,
    addEventListener(name, callback) { (windowListeners.get(name) || windowListeners.set(name, []).get(name)).push(callback); } };
  const scope = vm.createContext({ window, document, console, ArrayBuffer, DataView, Map, Set, WeakSet, Number,
    Date: { now: () => at }, activeDataSockets: [], lastVideoPipelineActive: true, lastAudioPipelineActive: true,
    lastVideoPacketAt: 0, lastAudioPacketAt: 0, lastAudioStartRequestAt: 0,
    lastAutomaticVideoRecoveryAt: 0, lastRenderKickAt: 0, streamRecoveryStartedAt: 0,
    lastFrameProgressAt: 1, lastRenderProgressAt: 1, waitingSinceMs: 0,
    streamRecoveryInFlight: false, streamRecoveryStage: 0, activityTasks: {},
    RENDER_STALL_WATCHDOG: true, RENDER_STALL_THRESHOLD_MS: 12000, RENDER_STALL_COOLDOWN_MS: 25000,
    STREAM_STALL_THRESHOLD_MS: 18000, PAGE_STALL_WATCHDOG: true, PAGE_STALL_THRESHOLD_MS: 45000,
    PAGE_STALL_RELOAD_MIN_RECOVERS: 2, lastPageWatchdogTickAt: 1, softRecoverAttempts: 0,
    pipelineResetNoticeTimer: null, dynamicLatencyApplied: false, GAMEPAD_UI_ENABLED: false,
    withSessionIdentity: value => value, createInputSampler: () => ({ send: () => false }),
    sanitizeOutgoingWebSocketPayload: value => value, queueAssistKeyCommand: () => false,
    syncAssistInputTransport: noop, reportClientAwakeState: noop, scheduleAutoSplitForPinSession: noop,
    forcePinLogin: () => { throw new Error("stale messages must not log out the current connection"); },
    recordNetworkStatsBandwidth: noop, recordUploadDiagnostic: noop, noteVideoHealthEvent: noop,
    findSidebarToggleButton: () => toggle, clearStaleSidebarToggleState: noop,
    isDynamicLatencyMousePresent: () => false, getDynamicLatencyConfig: () => ({ enabled: true }),
    hasVisibleStreamSurface: () => true, isTransportBusy: () => false, isStreamLikelyStalled: () => false,
    kickLocalRenderSurfaces: noop, suppressDynamicLatency: noop, scheduleKeyboardAssistFocus: noop,
    scheduleBadgeRefresh: noop, syncStreamActivity: noop,
    sanitizeBool: (value, fallback) => typeof value === "boolean" ? value : fallback,
    finishStreamRecoveryActivity: () => { scope.finished++; }, finished: 0,
    runSilentStreamSoftRecover: () => { scope.pageRecoveries++; }, pageRecoveries: 0,
    maybeReloadForPageStall: () => { scope.reloads++; }, reloads: 0
  });
  vm.runInContext(helper, scope);
  for (const name of ["installSingleSessionWebSocketGuard", "hasOpenDataSocket", "noteInboundStreamPacket",
    "requestVideoStreamRecovery", "recoverRenderStall", "getPendingVideoStallMs", "getFrameStallActive",
    "checkRenderStallHealth", "checkPageStallHealth", "noteFrameProgress", "syncSidebarToggleLowLatencyState",
    "syncSidebarStreamHealth", "clearSidebarToggleState", "ensureDynamicLatencyStyle", "bindStreamHealthHooks",
    "bindServerSettingsModeHint"]) vm.runInContext(shipped(name), scope);
  scope.installSingleSessionWebSocketGuard();
  scope.bindStreamHealthHooks();
  scope.bindServerSettingsModeHint();
  const health = window.__selkiesStreamHealth;
  function connect(display = "primary", role = "controller", open = true) {
    const socket = new window.WebSocket("wss://example.test/websockets");
    health.connect(socket, display); health.setRole(socket, role);
    if (open) socket.emit("open");
    return socket;
  }
  return { scope, window, document, health, toggle, head, connect, advance: ms => { at += ms; },
    message: data => { for (const callback of windowListeners.get("message") || []) callback({ data }); } };
}

function packet(id = 1, type = 6) {
  const data = new ArrayBuffer(12), view = new DataView(data);
  view.setUint8(0, type); view.setUint8(1, 1); view.setUint16(2, id);
  view.setUint16(6, 1920); view.setUint16(8, 1080);
  return data;
}

// Exercise the actual WebSocket wrapper together with the shipped health module.
const transport = fixture(), socket = transport.connect();
transport.advance(4000); socket.emit("message", packet());
assert(transport.scope.lastVideoPacketAt > 0, "AV1 packets update the receive marker");
socket.emit("message", "VIDEO_STARTED");
assert.equal(transport.health.diagnostics().displays[0].pendingFrames, 1, "late STARTED retains the first received picture");
transport.scope.streamRecoveryInFlight = true;
transport.message({ type: "pipelineStatusUpdate", video: true });
assert.equal(transport.scope.lastFrameProgressAt, 1);
assert.equal(transport.scope.finished, 0, "a pipeline notification must not claim successful presentation");
transport.advance(1); transport.health.frameRendered("primary", 1);
assert.equal(transport.scope.finished, 1, "a real presented frame completes recovery");
socket.emit("message", packet(2));
socket.emit("message", JSON.stringify({ type: "pipeline_status", video: false }));
assert.equal(transport.scope.lastVideoPipelineActive, false);
assert.equal(transport.health.diagnostics().displays[0].pendingFrames, 0);
socket.emit("message", JSON.stringify({ type: "pipeline_status", video: true }));
socket.emit("message", packet(3)); transport.advance(4000);
const pendingBeforeRepeat = transport.health.stalledFor();
socket.emit("message", JSON.stringify({ type: "pipeline_status", video: true }));
assert.equal(transport.health.stalledFor(), pendingBeforeRepeat, "duplicate JSON status cannot hide a pending output");

const replacement = transport.connect("primary", "viewer", false);
assert(socket.emit("message", "VIDEO_STOPPED").stopped);
assert(socket.emit("message", "FORCE_PIN_LOGIN").stopped);
assert(socket.emit("message", 'AUTH_SUCCESS,{"role":"controller"}').stopped);
assert.equal(transport.scope.lastVideoPipelineActive, true);
replacement.emit("open");
assert.equal(transport.health.connection().role, "viewer");

const secondary = fixture(), display2 = secondary.connect("display2");
secondary.advance(4000); display2.emit("message", packet());
display2.emit("message", "PIPELINE_RESETTING primary");
assert.equal(secondary.health.diagnostics().displays[0].pendingFrames, 1);
display2.emit("message", 'STREAM_HEALTH,{"kind":"drop","reason":"video_queue_overflow","display_id":"primary"}');
assert.equal(secondary.health.diagnostics().dropActive, false);
display2.emit("message", 'STREAM_HEALTH,{"kind":"drop","reason":"video_queue_overflow","display_id":"display2"}');
assert.equal(secondary.health.diagnostics().dropActive, true);
display2.emit("message", "PIPELINE_RESETTING display2");
assert.equal(secondary.health.diagnostics().displays[0].pendingFrames, 0);
display2.send("STOP_VIDEO");
assert.equal(secondary.health.diagnostics().displays[0].active, false);
display2.send("START_VIDEO");
display2.emit("message", packet(2));
display2.emit("message", "VIDEO_STARTED");
assert.equal(secondary.health.diagnostics().displays[0].pendingFrames, 1,
  "the first resumed frame can arrive before STARTED, without losing its presentation expectation");

// A high receive FPS no longer hides missing canvas output; idle is not a stall.
const recovery = fixture(), controller = recovery.connect("display2");
recovery.window.fps = 60;
recovery.advance(100000);
recovery.scope.checkRenderStallHealth(); recovery.scope.checkPageStallHealth();
assert.deepEqual(controller.sent, []); assert.equal(recovery.scope.pageRecoveries, 0);
controller.emit("message", packet()); recovery.advance(12500);
recovery.scope.checkRenderStallHealth();
assert.deepEqual(controller.sent, ["FORCE_STREAM_RECOVER,display2,video"]);
recovery.scope.checkRenderStallHealth();
assert.equal(controller.sent.length, 1, "recovery requests share a cooldown");
recovery.advance(10001); recovery.health.setRole(controller, "viewer");
assert(recovery.scope.requestVideoStreamRecovery("test"));
assert.equal(controller.sent.at(-1), "START_VIDEO", "a viewer may only request a fresh shared keyframe");
recovery.advance(10001); recovery.health.setRole(controller, "unknown");
assert.equal(recovery.scope.requestVideoStreamRecovery("test"), false);
recovery.health.setRole(controller, "controller"); recovery.document.hidden = true;
assert.equal(recovery.scope.requestVideoStreamRecovery("test"), false);
recovery.document.hidden = false; recovery.scope.recordUploadDiagnostic = () => { throw new Error("diagnostics unavailable"); };
assert(recovery.scope.requestVideoStreamRecovery("test"), "logging failure cannot change an already sent recovery request");

// Real status-bar DOM functions mount exactly two dots and restore native state.
const ui = fixture(), uiSocket = ui.connect();
ui.scope.dynamicLatencyApplied = true;
ui.scope.syncSidebarToggleLowLatencyState(); ui.scope.syncSidebarToggleLowLatencyState();
assert.equal(ui.toggle.children.length, 3, "one rainbow core plus two dots, without duplicate mounts");
const red = ui.toggle.querySelector(".selkies-stream-health-drop"), purple = ui.toggle.querySelector(".selkies-stream-health-stall");
assert.equal(red.getAttribute("data-active"), null); assert.equal(purple.getAttribute("data-active"), null);
ui.health.serverEvent(uiSocket, { display_id: "primary", kind: "drop", reason: "video_queue_overflow" });
ui.health.report("stall", "render_error", "primary");
assert.equal(red.getAttribute("data-active"), "1"); assert.equal(purple.getAttribute("data-active"), "1");
ui.advance(2401); ui.scope.syncSidebarStreamHealth(ui.toggle);
assert.equal(red.getAttribute("data-active"), null); assert.equal(purple.getAttribute("data-active"), null);
ui.scope.ensureDynamicLatencyStyle();
const css = ui.head.children[0].textContent;
assert(css.includes("span:not(.selkies-stream-health-dot)"), "rainbow animation must not recolor the health dots");
assert(css.includes(".selkies-stream-health-drop{top:") && css.includes(".selkies-stream-health-stall{bottom:"));
assert(css.includes("background:#ef4444") && css.includes("background:#a855f7"));
assert(css.includes("prefers-reduced-motion:reduce"));
ui.scope.clearSidebarToggleState(ui.toggle);
assert.equal(ui.toggle.children.length, 0); assert.equal(ui.toggle.getAttribute("title"), "打开侧边栏");

console.log("Stream health runtime: real WS messages, roles, stale sockets, JSON lifecycle, AV1, pending-output recovery and status-bar DOM passed.");
