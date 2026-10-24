// Shared isolation harness for the shipped guard. This models event delivery
// and transport acceptance, not a native IME or the remote X11 application.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const source = fs.readFileSync(path.join(__dirname, "../../root/usr/share/selkies/selkies-dashboard/src/selkies-runtime-overrides.js"), "utf8");
const start = source.indexOf("  var ASSIST_TYPING_COOLDOWN_MS");
const end = source.indexOf("  function focusKeyboardAssist()", start);
assert(start > 0 && end > start);

function createClock() {
  let now = 0, nextId = 0;
  const tasks = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay = 0) { const id = ++nextId; tasks.set(id, { fn, due: now + delay }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    count: () => tasks.size,
    stall(ms) { now += ms; },
    advance(ms) {
      const target = now + ms; let steps = 0;
      for (;;) {
        const next = [...tasks.entries()].filter(([, t]) => t.due <= target)
          .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!next) break;
        if (++steps > 100000) throw Error("timer runaway");
        tasks.delete(next[0]); now = Math.max(now, next[1].due); next[1].fn();
      }
      now = Math.max(now, target);
    }
  };
}

function fixture(options = {}) {
  const listeners = {}, timers = new Map(), sent = [], notices = [], warnings = [];
  let timerId = 0;
  const socket = { readyState: 1, bufferedAmount: 0, send: text => sent.push(text) };
  const state = { socket, assist: { id: "keyboard-input-assist", value: "" } };
  const window = {
    WebSocket: { OPEN: 1 },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    setTimeout: options.clock ? options.clock.setTimeout : function (fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout: options.clock ? options.clock.clearTimeout : function (id) { timers.delete(id); }
  };
  const context = vm.createContext({ window, document: { getElementById: () => state.assist },
    console: { warn: (...args) => warnings.push(args), log() {} },
    Date: options.clock ? { now: options.clock.now } : Date, imeCompositionActive: false,
    getPrimaryOpenDataSocket: () => state.socket,
    setActivityTask: (...args) => notices.push(args), completeActivityTask() {} });
  vm.runInContext(source.slice(start, end) + "\ninstallAssistInputGuard();", context);
  function event(type, props = {}) {
    const e = { target: state.assist, stopped: false, prevented: false,
      stopImmediatePropagation() { this.stopped = true; },
      preventDefault() { this.prevented = true; }, ...props };
    for (const fn of listeners[type] || []) { fn(e); if (e.stopped) break; }
    // The legacy listener only sees input events not stopped by the guard.
    if (type === "input" && !e.stopped) state.assist.value = "";
    return e;
  }
  function tick() {
    const batch = [...timers.values()]; timers.clear(); batch.forEach(fn => fn());
  }
  function input(value, props) { state.assist.value = value; return event("input", props); }
  return { state, sent, notices, warnings, window, context, event, tick, input, socket,
    timerCount: options.clock ? options.clock.count : () => timers.size };
}

module.exports = { fixture, source, createClock };
