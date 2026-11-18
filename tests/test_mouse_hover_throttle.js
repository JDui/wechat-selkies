// Exercise the shipped idle timer and event handlers with a deterministic clock.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const source = fs.readFileSync(path.join(__dirname,
  "../root/usr/share/selkies/selkies-dashboard/src/selkies-runtime-overrides.js"), "utf8");
function functionSource(name) {
  const start = source.indexOf("  function " + name + "(");
  const end = source.indexOf("\n  function ", start + 1);
  assert(start >= 0 && end > start, name);
  return source.slice(start, end);
}
function element() {
  return {
    attrs: {}, children: [], listeners: {}, style: { setProperty() {} },
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; },
    removeAttribute(name) { delete this.attrs[name]; },
    querySelector(selector) { return this.children.find(child => String(child.className || "").split(" ").includes(selector.slice(1))) || null; },
    appendChild(child) { this.children.push(child); },
    addEventListener(name, fn) { this.listeners[name] = fn; },
  };
}
function harness() {
  const root = element(), toggle = element(), doc = element(), win = element();
  const intervals = [], profiles = [];
  const config = { enabled: true, holdMs: 15000, fps: 2 };
  Object.assign(doc, { documentElement: root, hidden: false, head: element(),
    createElement: element, getElementById: () => null });
  Object.assign(win, { innerWidth: 1000, innerHeight: 800,
    setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; } });
  const c = {
    now: 10000, document: doc, window: win,
    dynamicLatencyApplied: false, dynamicLatencyMouseInside: false,
    dynamicLatencyTimer: null, sidebarToggleIndicatorTimer: null,
    dynamicLatencyUntil: 0, dynamicLatencySuppressedUntil: 0,
    lastDynamicLatencyConfigSignature: "same", lastVideoPipelineActive: true,
    streamRecoveryInFlight: false, streamRecoveryStage: 0,
    getDynamicLatencyConfig: () => config,
    getDynamicLatencyConfigSignature: () => "same",
    startDynamicLatencyMount() {}, clearStaleSidebarToggleState() {},
    findSidebarToggleButton: () => toggle, hasVisibleStreamSurface: () => true,
    isTransportBusy: () => false, isRemoteAudioPlaying: () => false,
    captureDynamicLatencyOriginals() {}, syncDynamicLatencySettingsToBackend() {},
    noteFrontendInteraction() {}, noteUiInteraction() {}, clearUnreadOnPrimaryInteraction() {},
    isFormLikeElement: () => false,
    applyDynamicLatencyProfile(active) {
      profiles.push(active);
      c.syncSidebarToggleLowLatencyState();
    },
  };
  c.Date = { now: () => c.now };
  vm.createContext(c);
  for (const name of ["isDynamicLatencyMousePresent", "setDynamicLatencyMouseInside",
    "updateDynamicLatencyMousePosition", "syncSidebarToggleLowLatencyState", "syncSidebarStreamHealth",
    "ensureDynamicLatencyStyle", "restoreDynamicLatency", "activateDynamicLatency",
    "markDynamicLatencyInteractive", "bindDynamicLatencyMode"]) {
    vm.runInContext(functionSource(name), c);
  }
  c.bindDynamicLatencyMode();
  return { c, root, doc, win, toggle, profiles, config,
    tick() { intervals.find(i => i.ms === 200).fn(); },
    mouse: { pointerType: "mouse", clientX: 100, clientY: 100 },
  };
}

const h = harness();
h.c.now += h.config.holdMs;
h.tick();
assert.strictEqual(h.c.dynamicLatencyApplied, true, "idle initially throttles");
assert.strictEqual(h.toggle.attrs["data-selkies-low-latency"], "active");
h.root.listeners.pointerenter(h.mouse);
assert.strictEqual(h.c.dynamicLatencyApplied, false, "enter restores immediately");
assert.strictEqual(h.toggle.attrs["data-selkies-low-latency"], "mouse");
assert.strictEqual(h.toggle.children[0].attrs["data-active"], "mouse");
const profileCount = h.profiles.length;
h.c.now += 600000;
h.tick();
h.c.activateDynamicLatency("direct");
assert.strictEqual(h.c.dynamicLatencyApplied, false, "stationary hover blocks throttling");
assert.strictEqual(h.profiles.length, profileCount, "hover does not repeat backend changes");
h.root.listeners.pointerleave(h.mouse);
assert.strictEqual(h.toggle.attrs["data-selkies-low-latency"], undefined);
h.c.now += h.config.holdMs - 1;
h.tick();
assert.strictEqual(h.c.dynamicLatencyApplied, false, "exit gets a full idle interval");
h.c.now += 1;
h.tick();
assert.strictEqual(h.c.dynamicLatencyApplied, true);
assert.strictEqual(h.toggle.attrs["data-selkies-low-latency"], "active", "rainbow returns");

for (const pointerType of ["touch", "pen"]) {
  const t = harness(), event = { ...t.mouse, pointerType };
  t.root.listeners.pointerenter(event);
  t.doc.listeners.pointerdown(event);
  t.doc.listeners.pointermove({ ...event, movementX: 1 });
  t.doc.listeners.pointerup(event);
  assert.strictEqual(t.c.dynamicLatencyMouseInside, false, pointerType + " cannot latch hover");
  assert.strictEqual(t.toggle.attrs["data-selkies-low-latency"], undefined);
  t.c.now += t.config.holdMs;
  t.tick();
  assert.strictEqual(t.c.dynamicLatencyApplied, true, pointerType + " retains idle behavior");
}

for (const action of ["blur", "pagehide", "hidden", "cancel", "captured-exit"]) {
  const t = harness();
  t.root.listeners.pointerenter(t.mouse);
  t.c.now += 60000;
  if (action === "hidden") {
    t.doc.hidden = true;
    t.doc.listeners.visibilitychange();
  } else if (action === "cancel") {
    t.doc.listeners.pointercancel(t.mouse);
  } else if (action === "captured-exit") {
    t.doc.listeners.pointermove({ ...t.mouse, clientX: 1001, movementX: 10, buttons: 1 });
  } else {
    t.win.listeners[action]();
  }
  assert.strictEqual(t.c.dynamicLatencyMouseInside, false, action + " clears hover");
  assert.strictEqual(t.c.dynamicLatencyUntil, t.c.now + t.config.holdMs);
  assert.strictEqual(t.toggle.attrs["data-selkies-low-latency"], undefined);
  t.doc.hidden = false;
  t.doc.listeners.pointermove(t.mouse);
  assert.strictEqual(t.c.dynamicLatencyMouseInside, true, "move restores hover after " + action);
}

// Touch on a hybrid device must not clear an independently present mouse.
h.root.listeners.pointerenter(h.mouse);
h.root.listeners.pointerleave({ pointerType: "touch" });
assert.strictEqual(h.c.dynamicLatencyMouseInside, true);
const css = h.doc.head.children[0].textContent;
assert.match(css, /data-active='mouse'[^}]+background:#f59e0b;animation:none/,
  "mouse indicator is solid orange");
assert.match(css, /data-active='1'[^}]+animation:selkies-rainbow-fill/,
  "throttled indicator retains rainbow animation");
console.log("mouse hover throttle checks passed");
