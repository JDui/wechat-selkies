// Isolated DOM geometry and capture-event tests for the shipped position module.
// This models CSS coordinates, not a browser layout engine or native OS IME.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { source: guardSource, createClock } = require("./helpers/ime_fixture");
const moduleSource = fs.readFileSync(path.join(__dirname,
  "../root/usr/share/selkies/selkies-dashboard/src/selkies-ime-position.js"), "utf8");

class Style {
  constructor() { this.values = new Map(); this.priorities = new Map(); this.writes = []; }
  setProperty(name, value, priority = "") {
    this.values.set(name, value); this.priorities.set(name, priority);
    this.writes.push({ name, value, priority });
  }
  getPropertyValue(name) { return this.values.get(name) || ""; }
  getPropertyPriority(name) { return this.priorities.get(name) || ""; }
}

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch(event) {
      for (const fn of listeners.get(event.type) || []) {
        fn(event);
        if (event.stopped) break;
      }
    }
  };
}

function harness({ loadModule = true, video = false } = {}) {
  const elements = new Map(), clock = createClock(), frames = new Map(), observers = [], mutations = [];
  const sent = [], notices = [], activity = [], window = eventTarget(), document = eventTarget();
  let nextFrame = 0, focusCalls = 0, structureWrites = 0, valueWrites = 0;
  function element(id, rect, parent = null) {
    let value = "";
    const el = {
      id, parentElement: parent, isConnected: true, style: new Style(), rect: { ...rect },
      className: "", objectFit: "fill", videoWidth: 0, videoHeight: 0,
      get value() { return value; },
      set value(next) { valueWrites += 1; value = next; },
      focus() { focusCalls += 1; document.activeElement = el; },
      appendChild() { structureWrites += 1; },
      getBoundingClientRect() {
        return { ...el.rect, right: el.rect.left + el.rect.width, bottom: el.rect.top + el.rect.height };
      },
      closest(selector) {
        for (let candidate = el; candidate; candidate = candidate.parentElement) {
          if (selector.split(",").some(part => part.trim() === "#" + candidate.id ||
              (part.trim() === ".video-container" && candidate.className === "video-container"))) return candidate;
        }
        return null;
      },
      querySelectorAll(selector) {
        return [...elements.values()].filter(candidate => candidate.isConnected &&
          candidate.parentElement === el && selector.split(",").includes("#" + candidate.id));
      }
    };
    elements.set(id, el);
    return el;
  }
  const rect = { left: 100, top: 80, width: 800, height: 500 };
  const container = element("container", rect); container.className = "video-container";
  const overlay = element("overlayInput", rect, container);
  const media = element(video ? "stream" : "videoCanvas", rect, container);
  const assist = element("keyboard-input-assist", { left: -9999, top: -9999, width: 1, height: 1 });
  const settings = element("settings", { left: 0, top: 0, width: 50, height: 20 });
  const body = element("body", { left: 0, top: 0, width: 1280, height: 720 });
  Object.assign(document, {
    hidden: false, body, activeElement: body, pointerLockElement: null,
    getElementById: id => elements.get(id) || null,
    querySelectorAll: selector => [...elements.values()].filter(el => el.isConnected &&
      selector.split(",").includes("#" + el.id))
  });
  const visualViewport = Object.assign(eventTarget(), { offsetLeft: 0, offsetTop: 0, width: 1280, height: 720, scale: 1 });
  Object.assign(window, {
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, visualViewport,
    webrtcInput: { mouseRelative: false, _trackpadMode: false },
    WebSocket: { OPEN: 1 },
    getComputedStyle: el => ({ objectFit: el.objectFit }),
    requestAnimationFrame(fn) { const id = ++nextFrame; frames.set(id, fn); return id; },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    ResizeObserver: class {
      constructor(fn) { this.fn = fn; this.observed = new Set(); observers.push(this); }
      disconnect() { this.observed.clear(); }
      observe(el) { this.observed.add(el); }
    },
    MutationObserver: class {
      constructor(fn) { this.fn = fn; this.active = false; this.options = null; mutations.push(this); }
      disconnect() { this.active = false; }
      observe(target, options) { this.active = true; this.target = target; this.options = options; }
    }
  });
  const socket = { readyState: 1, bufferedAmount: 0, send: packet => sent.push(packet) };
  const context = vm.createContext({ window, document,
    navigator: { platform: "Win32", userAgent: "test", maxTouchPoints: 0 },
    console: { log() {}, warn() {} }, Date: { now: clock.now },
    imeCompositionActive: false, dynamicLatencySuppressedUntil: 0,
    getPrimaryOpenDataSocket: () => socket,
    noteUiInteraction: () => activity.push("ui"),
    noteFrontendInteraction: () => activity.push("frontend"),
    markDynamicLatencyInteractive: () => activity.push("latency"),
    setActivityTask: (...args) => notices.push(args), completeActivityTask() {}
  });
  if (loadModule) vm.runInContext(moduleSource, context);
  function dispatch(type, props = {}, destination = "capture") {
    const event = { type, target: assist, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...props };
    if (destination === "viewport") visualViewport.dispatch(event);
    else if (destination === "document") document.dispatch(event);
    else {
      window.dispatch(event);
      if (!event.stopped) document.dispatch(event);
    }
    return event;
  }
  function flushFrames() {
    const batch = [...frames.values()]; frames.clear(); batch.forEach(fn => fn(clock.now()));
  }
  function position(target = document.getElementById("keyboard-input-assist")) {
    return [parseFloat(target.style.getPropertyValue("left")), parseFloat(target.style.getPropertyValue("top"))];
  }
  function installGuard() {
    const start = guardSource.indexOf("  var ASSIST_TYPING_COOLDOWN_MS");
    const end = guardSource.indexOf("  function focusKeyboardAssist(", start);
    assert(start > 0 && end > start);
    vm.runInContext(guardSource.slice(start, end) + "\ninstallAssistInputGuard();", context);
  }
  return { window, document, overlay, media, assist, settings, container, elements, element,
    observers, mutations, context, sent, notices, activity, clock, dispatch, position, flushFrames, installGuard,
    frameCount: () => frames.size,
    mutate() { for (const observer of mutations) if (observer.active) observer.fn([{ type: "childList" }]); },
    touch(x, y) { return dispatch("touchstart", { target: overlay, touches: [{ clientX: x, clientY: y }] }); },
    click(x, y, extra = {}) { return dispatch("pointerdown", { target: overlay, button: 0, clientX: x, clientY: y, ...extra }); },
    counts: () => ({ focusCalls, structureWrites, valueWrites }) };
}

let passed = 0;
function test(name, run) { run(); passed += 1; console.log("PASS " + name); }
function at(f, x, y, target) { assert.deepStrictEqual(f.position(target), [x, y]); }

test("dashboard loads the position observer before the consuming input guard", () => {
  const html = fs.readFileSync(path.join(__dirname,
    "../root/usr/share/selkies/selkies-dashboard/index.html"), "utf8");
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)];
  const positionIndex = scripts.findIndex(match => match[1].includes("src/selkies-ime-position.js?"));
  const guardIndex = scripts.findIndex(match => match[1].includes("src/selkies-runtime-overrides.js?"));
  assert(positionIndex >= 0 && guardIndex > positionIndex);
  assert(!/\b(?:async|defer)\b|type="module"/.test(scripts[positionIndex][0]));
});

test("click uses CSS pixels immediately and only writes important positioning", () => {
  const f = harness(); f.window.devicePixelRatio = 2.5;
  let observedAtFocus;
  f.document.addEventListener("pointerdown", () => { observedAtFocus = f.position(); });
  const event = f.click(300, 450);
  at(f, 300, 450);
  assert.deepStrictEqual(observedAtFocus, [300, 450], "position must precede document focus recovery");
  assert(!event.prevented && !event.stopped);
  assert.strictEqual(f.assist.style.getPropertyValue("position"), "fixed");
  for (const property of ["position", "left", "top"]) {
    assert.strictEqual(f.assist.style.getPropertyPriority(property), "important");
  }
  assert.deepStrictEqual([...new Set(f.assist.style.writes.map(write => write.name))].sort(), ["left", "position", "top"]);
  assert.deepStrictEqual(f.counts(), { focusCalls: 0, structureWrites: 0, valueWrites: 0 });
  assert.deepStrictEqual(f.sent, []);
  const writes = f.assist.style.writes.length;
  f.dispatch("mousedown", { target: f.overlay, button: 0, clientX: 300, clientY: 450 });
  assert.strictEqual(f.assist.style.writes.length, writes, "compatibility mouse event must not rewrite unchanged styles");
});

test("remembered surface position survives scaling and viewport movement", () => {
  const f = harness(); f.click(300, 330);
  f.media.rect = { left: 200, top: 100, width: 400, height: 250 };
  f.dispatch("resize"); f.flushFrames(); at(f, 300, 225);
  f.media.rect = { left: 0, top: 10, width: 1000, height: 600 };
  f.dispatch("scroll"); f.flushFrames(); at(f, 250, 310);
  f.media.rect = { left: 0, top: 0, width: 1280, height: 720 };
  f.dispatch("fullscreenchange", {}, "document"); f.flushFrames(); at(f, 320, 360);
});

test("resize observation and viewport events batch geometry work", () => {
  const f = harness(); f.click(300, 330);
  assert.strictEqual(f.observers.length, 1);
  assert(f.observers[0].observed.has(f.overlay));
  assert(f.observers[0].observed.has(f.media));
  f.media.rect = { left: 0, top: 0, width: 400, height: 200 };
  f.observers[0].fn(); f.dispatch("resize"); f.dispatch("scroll");
  f.dispatch("resize", {}, "viewport"); f.dispatch("scroll", {}, "viewport");
  assert.strictEqual(f.frameCount(), 1); f.flushFrames(); at(f, 100, 100);
  assert.strictEqual(f.frameCount(), 0);
});

test("visual viewport clamps the one-pixel input with a two-pixel margin", () => {
  const f = harness(); f.click(850, 550);
  Object.assign(f.window.visualViewport, { offsetLeft: 80, offsetTop: 100, width: 500, height: 300, scale: 2 });
  f.dispatch("resize", {}, "viewport"); f.flushFrames(); at(f, 577, 397);
  f.click(100, 80); at(f, 100, 102);
  Object.assign(f.window.visualViewport, { offsetLeft: 200, offsetTop: 150 });
  f.dispatch("scroll", {}, "viewport"); f.flushFrames(); at(f, 202, 152);
});

test("single touches locate without taking focus or consuming the event", () => {
  const f = harness(); const event = f.touch(700, 400); at(f, 700, 400);
  assert(!event.prevented && !event.stopped);
  f.click(350, 200, { pointerType: "touch", isPrimary: true }); at(f, 350, 200);
  assert.deepStrictEqual(f.counts(), { focusCalls: 0, structureWrites: 0, valueWrites: 0 });
});

test("compatibility mouse events cannot replace a pointer or trackpad anchor", () => {
  const f = harness(); f.click(300, 200);
  f.dispatch("mousedown", { target: f.overlay, button: 0, clientX: 350, clientY: 250 });
  at(f, 350, 250);
  f.window.PointerEvent = function PointerEvent() {};
  f.dispatch("mousedown", { target: f.overlay, button: 0, clientX: 700, clientY: 500 });
  at(f, 350, 250);
  f.click(400, 300); at(f, 400, 300);
  delete f.window.PointerEvent;
  f.window.webrtcInput._trackpadMode = true;
  f.touch(700, 500);
  f.dispatch("mousedown", { target: f.overlay, button: 0, clientX: 700, clientY: 500 });
  at(f, 400, 300);
  f.clock.advance(799);
  f.dispatch("mousedown", { target: f.overlay, button: 0, clientX: 700, clientY: 500 });
  at(f, 400, 300);
  f.clock.advance(1);
  f.dispatch("mousedown", { target: f.overlay, button: 0, clientX: 700, clientY: 500,
    sourceCapabilities: { firesTouchEvents: true } });
  at(f, 400, 300);
  f.dispatch("mousedown", { target: f.overlay, button: 0, clientX: 600, clientY: 400 });
  at(f, 600, 400);
});

test("a second finger, drag or cancellation restores the position before a touch gesture", () => {
  for (const cancel of ["second-finger", "pointer-move", "touch-move", "pointer-cancel", "touch-cancel"]) {
    const f = harness(); f.click(300, 200);
    f.click(700, 400, { pointerType: "touch", isPrimary: true });
    f.touch(700, 400); at(f, 700, 400);
    let event;
    if (cancel === "second-finger") {
      event = f.click(710, 410, { pointerType: "touch", isPrimary: false });
      f.dispatch("touchstart", { target: f.overlay, touches: [
        { clientX: 700, clientY: 400 }, { clientX: 710, clientY: 410 }
      ] });
      f.dispatch("touchend", { target: f.overlay, touches: [{ clientX: 700, clientY: 400 }] });
    } else if (cancel === "pointer-move") {
      f.dispatch("pointermove", { target: f.overlay, pointerType: "touch", clientX: 706, clientY: 408 });
      at(f, 700, 400);
      event = f.dispatch("pointermove", { target: f.overlay, pointerType: "touch", clientX: 711, clientY: 400 });
    } else if (cancel === "touch-move") {
      f.dispatch("touchmove", { target: f.overlay, touches: [{ clientX: 706, clientY: 408 }] });
      at(f, 700, 400);
      event = f.dispatch("touchmove", { target: f.overlay, touches: [{ clientX: 711, clientY: 400 }] });
    } else if (cancel === "pointer-cancel") {
      event = f.dispatch("pointercancel", { target: f.overlay, pointerType: "touch" });
    } else {
      event = f.dispatch("touchcancel", { target: f.overlay });
    }
    at(f, 300, 200);
    assert(!event.prevented && !event.stopped, cancel + " must remain available to the input handler");
    f.dispatch("touchend", { target: f.overlay, touches: [] });
    f.dispatch("mousedown", { target: f.overlay, button: 0, clientX: 700, clientY: 400 });
    at(f, 300, 200);
    f.touch(500, 300); f.dispatch("touchend", { target: f.overlay, touches: [] }); at(f, 500, 300);
    assert.deepStrictEqual(f.counts(), { focusCalls: 0, structureWrites: 0, valueWrites: 0 });
  }
});

test("cancelled first touch falls back safely and composition keeps touch rollback deferred", () => {
  const f = harness(); f.touch(700, 400);
  f.dispatch("touchcancel", { target: f.overlay }); at(f, 500, 330);
  f.click(300, 200); f.dispatch("compositionstart"); f.touch(700, 400);
  at(f, 300, 200);
  f.dispatch("touchmove", { target: f.overlay, touches: [{ clientX: 730, clientY: 400 }] });
  f.dispatch("touchend", { target: f.overlay, touches: [] });
  f.dispatch("compositionend", { data: "文字" }); f.flushFrames(); at(f, 300, 200);
});

test("hover, local controls, secondary buttons and invalid absolute gestures are ignored", () => {
  const f = harness(); f.click(300, 300);
  for (const type of ["pointermove", "mousemove", "touchmove"]) {
    f.dispatch(type, { target: f.overlay, button: 0, clientX: 700, clientY: 500 });
  }
  f.click(700, 500, { target: f.settings });
  f.click(700, 500, { button: 2 });
  f.click(700, 500, { isPrimary: false });
  f.click(NaN, 500); f.click(700, Infinity); f.click(999, 500);
  f.dispatch("touchstart", { target: f.overlay, touches: [{ clientX: 700, clientY: 500 }, { clientX: 710, clientY: 510 }] });
  f.dispatch("touchstart", { target: f.overlay, touches: [] });
  at(f, 300, 300);
  f.document.pointerLockElement = f.overlay; f.click(700, 500); at(f, 300, 300);
  f.document.pointerLockElement = null; f.window.webrtcInput.mouseRelative = true;
  f.click(700, 500); at(f, 300, 300);
  f.window.webrtcInput.mouseRelative = false; f.window.webrtcInput._trackpadMode = true;
  f.touch(700, 500); f.click(700, 500, { pointerType: "touch" }); at(f, 300, 300);
  f.click(600, 400); at(f, 600, 400);
});

test("video contain letterboxing is excluded and reprojected after resize", () => {
  const f = harness({ video: true });
  f.overlay.rect = f.media.rect = { left: 100, top: 50, width: 800, height: 600 };
  Object.assign(f.media, { videoWidth: 1600, videoHeight: 900, objectFit: "contain" });
  f.click(300, 350); at(f, 300, 350);
  f.click(300, 80); at(f, 300, 350);
  f.media.rect = { left: 0, top: 0, width: 400, height: 300 };
  f.observers[0].fn(); f.flushFrames(); at(f, 100, 150);
});

test("fallback uses the surface center and reconstructed elements recover the remembered location", () => {
  const f = harness(); f.dispatch("focusin"); at(f, 500, 330);
  f.click(300, 330);
  f.overlay.isConnected = false;
  const overlay = f.element("overlayInput", { left: 200, top: 100, width: 400, height: 200 });
  f.assist.isConnected = false;
  const assist = f.element("keyboard-input-assist", { left: -9999, top: -9999, width: 1, height: 1 });
  f.dispatch("focusin", { target: assist }); at(f, 300, 200, assist);
  assert(f.observers[0].observed.has(overlay));
  assert(!f.observers[0].observed.has(f.overlay));
  assert.deepStrictEqual(f.counts(), { focusCalls: 0, structureWrites: 0, valueWrites: 0 });
});

test("surface replacement uses a temporary mutation observer and resumes resize observation", () => {
  const f = harness(); f.click(300, 330);
  assert.strictEqual(f.mutations.length, 0, "normal layout needs no global mutation observer");
  f.overlay.isConnected = false; f.media.isConnected = false;
  f.elements.delete("overlayInput"); f.elements.delete("videoCanvas");
  f.observers[0].fn(); f.flushFrames(); at(f, 300, 330);
  assert.strictEqual(f.mutations.length, 1);
  assert(f.mutations[0].active);
  assert.strictEqual(f.mutations[0].target, f.document.body);
  assert.strictEqual(f.mutations[0].options.childList, true);
  assert.strictEqual(f.mutations[0].options.subtree, true);
  assert.strictEqual(f.clock.count(), 0, "replacement waiting must not poll");
  f.element("unrelated", { left: 0, top: 0, width: 10, height: 10 });
  f.mutate(); assert.strictEqual(f.frameCount(), 0);
  const rect = { left: 200, top: 100, width: 400, height: 200 };
  const overlay = f.element("overlayInput", rect, f.container);
  const media = f.element("videoCanvas", rect, f.container);
  f.mutate(); f.mutate(); assert.strictEqual(f.frameCount(), 1);
  assert(f.mutations[0].active); f.flushFrames(); at(f, 300, 200);
  assert(!f.mutations[0].active);
  assert(f.observers[0].observed.has(overlay)); assert(f.observers[0].observed.has(media));
  assert(!f.observers[0].observed.has(f.overlay)); assert(!f.observers[0].observed.has(f.media));
  f.mutate(); assert.strictEqual(f.frameCount(), 0);
  media.rect = { left: 100, top: 50, width: 800, height: 400 };
  f.observers[0].fn(); f.flushFrames(); at(f, 300, 250);
  assert.deepStrictEqual(f.counts(), { focusCalls: 0, structureWrites: 0, valueWrites: 0 });
});

test("explicit composition freezes placement and applies deferred geometry after commit", () => {
  const f = harness(); f.click(300, 200); f.dispatch("compositionstart");
  f.dispatch("compositionupdate", { data: "word" });
  f.click(700, 400); at(f, 300, 200);
  f.media.rect = { left: 0, top: 0, width: 400, height: 250 };
  f.dispatch("resize"); f.flushFrames(); at(f, 300, 200);
  f.dispatch("compositionend", { data: "文字" }); at(f, 300, 200);
  f.dispatch("input", { inputType: "insertCompositionText", isComposing: true, data: "文字" });
  f.flushFrames(); at(f, 300, 160);
  assert.deepStrictEqual(f.counts(), { focusCalls: 0, structureWrites: 0, valueWrites: 0 });
});

test("preedit without compositionstart freezes until a final insertion", () => {
  const f = harness(); f.click(300, 200);
  f.dispatch("beforeinput", { inputType: "insertCompositionText", isComposing: true });
  f.click(700, 400); f.flushFrames(); at(f, 300, 200);
  f.dispatch("input", { inputType: "insertFromComposition", isComposing: false, data: "文字" });
  f.flushFrames(); at(f, 700, 400);
});

test("trailing composing events do not freeze the next click, but fresh preedit does", () => {
  const f = harness(); f.click(300, 200); f.dispatch("compositionstart");
  f.dispatch("compositionend", { data: "文字" });
  for (const type of ["beforeinput", "input"]) {
    f.dispatch(type, { inputType: "insertCompositionText", isComposing: true, data: "文字" });
  }
  f.flushFrames(); f.click(700, 400); at(f, 700, 400);
  f.dispatch("keydown", { key: "a", code: "KeyA", keyCode: 65 });
  f.dispatch("beforeinput", { inputType: "insertCompositionText", isComposing: true, data: "new" });
  f.click(400, 300); f.flushFrames(); at(f, 700, 400);
  f.dispatch("input", { inputType: "insertFromComposition", isComposing: false, data: "另段" });
  f.flushFrames(); at(f, 400, 300);
});

test("focus loss and assist reconstruction do not leave a frozen anchor", () => {
  const f = harness(); f.click(300, 200); f.dispatch("compositionstart");
  f.click(700, 400); f.dispatch("focusout"); f.flushFrames(); at(f, 700, 400);
  f.dispatch("compositionstart"); f.dispatch("blur", { target: f.window });
  f.click(400, 300); at(f, 400, 300);
  f.dispatch("compositionstart"); f.click(600, 400);
  const assist = f.element("keyboard-input-assist", { left: -9999, top: -9999, width: 1, height: 1 });
  f.dispatch("focusin", { target: assist }); at(f, 600, 400, assist);
});

test("missing or hidden surfaces are safe and no-viewport fallback uses window bounds", () => {
  const f = harness(); f.click(300, 200);
  f.media.rect.width = 0; f.overlay.rect.width = 0;
  f.click(600, 400); f.dispatch("resize"); f.flushFrames(); at(f, 300, 200);
  f.elements.delete("keyboard-input-assist"); f.dispatch("focusin");
  f.elements.set("keyboard-input-assist", f.assist);
  f.media.rect.width = f.overlay.rect.width = 800;
  f.window.visualViewport = null; f.window.innerWidth = 500; f.window.innerHeight = 300;
  f.click(800, 500); at(f, 497, 297);
  f.document.hidden = true; f.click(300, 200); at(f, 497, 297);
  f.document.hidden = false; f.dispatch("focusin"); at(f, 300, 200);
});

test("position observers precede the real guard without changing text packets or key handling", () => {
  function run(loadModule) {
    const f = harness({ loadModule }); f.installGuard();
    let documentComposition = 0;
    f.document.addEventListener("compositionstart", () => { documentComposition += 1; });
    f.click(300, 200);
    const events = [];
    function send(type, props) {
      const event = f.dispatch(type, props);
      events.push([type, event.stopped, event.prevented]);
    }
    send("compositionstart");
    f.assist.value = "wenzi";
    send("input", { inputType: "insertCompositionText", isComposing: true, data: "wenzi" });
    send("keydown", { key: " ", code: "Space", keyCode: 32, isComposing: true });
    f.click(700, 400);
    if (loadModule) at(f, 300, 200);
    f.assist.value = "文字";
    send("compositionend", { data: "文字" });
    send("input", { inputType: "insertFromComposition", isComposing: false, data: "文字" });
    send("keyup", { key: " ", code: "Space", keyCode: 32, isComposing: false });
    f.clock.advance(0); f.flushFrames();
    if (loadModule) at(f, 700, 400);
    send("keydown", { key: "a", code: "KeyA", keyCode: 65 });
    f.assist.value = "另段";
    send("input", { inputType: "insertText", isComposing: false, data: "另段" });
    f.clock.advance(0); f.flushFrames();
    assert.strictEqual(documentComposition, 0, "guard must still consume composition at window capture");
    assert.deepStrictEqual(f.sent, ["co,end,文字", "co,end,另段"]);
    assert.strictEqual(f.counts().focusCalls, 0);
    assert.strictEqual(f.counts().structureWrites, 0);
    return { sent: f.sent, notices: f.notices, activity: f.activity, events, value: f.assist.value };
  }
  assert.deepStrictEqual(run(true), run(false));
});

test("the real guard distinguishes fresh soft-keyboard preedit without start or keydown from a final echo", () => {
  function run(loadModule, cleanupBeforePreedit) {
    const f = harness({ loadModule }); f.installGuard(); f.click(300, 200);
    const events = [];
    function send(type, props) {
      const event = f.dispatch(type, props);
      events.push([type, event.stopped, event.prevented]);
    }
    send("compositionstart"); f.assist.value = "首段"; send("compositionend", { data: "首段" });
    if (cleanupBeforePreedit) f.clock.advance(0);
    f.flushFrames();
    send("beforeinput", { inputType: "insertCompositionText", isComposing: true, data: "next" });
    f.assist.value = "next";
    send("input", { inputType: "insertCompositionText", isComposing: true, data: "next" });
    f.click(700, 400);
    if (loadModule) at(f, 300, 200);
    f.clock.advance(0); f.flushFrames();
    assert.strictEqual(f.assist.value, "next", "the unchanged guard must preserve fresh preedit");
    assert.deepStrictEqual(f.sent, ["co,end,首段"]);
    f.media.rect = { left: 0, top: 0, width: 800, height: 500 };
    f.dispatch("resize"); f.flushFrames();
    if (loadModule) at(f, 300, 200);
    f.assist.value = "另段";
    send("input", { inputType: "insertFromComposition", isComposing: false, data: "另段" });
    f.clock.advance(0); f.flushFrames();
    if (loadModule) at(f, 600, 320);
    assert.deepStrictEqual(f.sent, ["co,end,首段", "co,end,另段"]);
    assert.strictEqual(f.assist.value, "");
    return { sent: f.sent, notices: f.notices, activity: f.activity, events, counts: f.counts() };
  }
  for (const cleanupBeforePreedit of [false, true]) {
    assert.deepStrictEqual(run(true, cleanupBeforePreedit), run(false, cleanupBeforePreedit));
  }
  const f = harness(); f.installGuard(); f.click(300, 200);
  f.dispatch("compositionstart"); f.assist.value = "文字";
  f.dispatch("compositionend", { data: "文字" });
  f.dispatch("beforeinput", { inputType: "insertCompositionText", isComposing: true, data: "文字" });
  f.dispatch("input", { inputType: "insertCompositionText", isComposing: true, data: "文字" });
  assert.strictEqual(f.assist.value, "", "the unchanged guard clears a final echo");
  f.clock.advance(0); f.flushFrames(); f.click(700, 400); at(f, 700, 400);
  assert.deepStrictEqual(f.sent, ["co,end,文字"]);
});

test("an action key before the settling frame cannot freeze an echoed final insertion", () => {
  function run(loadModule) {
    const f = harness({ loadModule }); f.installGuard(); f.click(300, 200);
    f.dispatch("compositionstart"); f.assist.value = "文字";
    f.dispatch("compositionend", { data: "文字" });
    f.dispatch("input", { inputType: "insertCompositionText", isComposing: true, data: "文字" });
    assert.strictEqual(f.assist.value, "");
    const enter = f.dispatch("keydown", { key: "Enter", code: "Enter", keyCode: 13 });
    f.clock.advance(0); f.flushFrames(); f.click(700, 400);
    if (loadModule) at(f, 700, 400);
    f.media.rect = { left: 0, top: 0, width: 400, height: 250 };
    f.dispatch("resize"); f.flushFrames();
    if (loadModule) at(f, 300, 160);
    return { sent: f.sent, keyStopped: enter.stopped, keyPrevented: enter.prevented, value: f.assist.value, counts: f.counts() };
  }
  assert.deepStrictEqual(run(true), run(false));
  const f = harness(); f.installGuard(); f.click(300, 200);
  f.dispatch("compositionstart"); f.assist.value = "首段";
  f.dispatch("compositionend", { data: "首段" });
  f.dispatch("input", { inputType: "insertCompositionText", isComposing: true, data: "首段" });
  f.dispatch("compositionstart");
  f.click(700, 400); f.clock.advance(0); f.flushFrames(); at(f, 300, 200);
  f.assist.value = "新段"; f.dispatch("compositionend", { data: "新段" });
  f.clock.advance(0); f.flushFrames(); at(f, 700, 400);
  assert.deepStrictEqual(f.sent, ["co,end,首段", "co,end,新段"]);
});

console.log("IME_POSITION_SUMMARY " + JSON.stringify({ total: passed, passed, failed: 0 }));
