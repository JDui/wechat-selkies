// Execute the shipped assist guard with deterministic event order and transport failures.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const source = fs.readFileSync(path.join(__dirname, "../root/usr/share/selkies/selkies-dashboard/src/selkies-runtime-overrides.js"), "utf8");
const start = source.indexOf("  var ASSIST_TYPING_COOLDOWN_MS");
const end = source.indexOf("  function focusKeyboardAssist()", start);
assert(start > 0 && end > start);

function fixture() {
  const listeners = {}, timers = new Map(), sent = [], notices = [];
  let timerId = 0;
  const socket = { readyState: 1, bufferedAmount: 0, send: text => sent.push(text) };
  const state = { socket, assist: { id: "keyboard-input-assist", value: "" } };
  const window = {
    WebSocket: { OPEN: 1 },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  };
  const context = vm.createContext({ window, document: { getElementById: () => state.assist },
    console: { warn() {}, log() {} }, Date, imeCompositionActive: false,
    getPrimaryOpenDataSocket: () => state.socket,
    setActivityTask: (...args) => notices.push(args), completeActivityTask() {} });
  vm.runInContext(source.slice(start, end) + "\ninstallAssistInputGuard();", context);
  function event(type, props = {}) {
    const e = { target: state.assist, stopped: false, prevented: false,
      stopImmediatePropagation() { this.stopped = true; },
      preventDefault() { this.prevented = true; }, ...props };
    for (const fn of listeners[type] || []) { fn(e); if (e.stopped) break; }
    // Simulate the legacy target listener clearing the value if not intercepted.
    if (type === "input" && !e.stopped) state.assist.value = "";
    return e;
  }
  function tick() {
    const batch = [...timers.values()]; timers.clear(); batch.forEach(fn => fn());
  }
  function input(value, props) { state.assist.value = value; return event("input", props); }
  return { state, sent, notices, window, context, event, tick, input, socket };
}

// Preedit never leaves the browser; candidate Enter keeps its native default.
{
  const f = fixture();
  f.event("compositionstart"); f.input("ni", { isComposing: true });
  assert.deepStrictEqual(f.sent, []); assert.strictEqual(f.state.assist.value, "ni");
  const key = f.event("keydown", { key: "Enter", code: "Enter", keyCode: 13 });
  assert(key.stopped && !key.prevented);
  f.state.assist.value = "你"; f.event("compositionend", { data: "你" });
  f.input("你", { isComposing: false }); f.tick();
  assert.deepStrictEqual(f.sent, ["co,end,你"]);
  assert(f.event("keyup", { key: "Enter", code: "Enter" }).stopped);
}
// End-only browsers, final-input-before-end browsers, and cancellation.
for (const cancelled of [false, true]) {
  const f = fixture(); f.event("compositionstart");
  f.input(cancelled ? "" : "中文", { isComposing: true });
  f.event("compositionend", { data: cancelled ? "" : "中文" }); f.tick();
  assert.deepStrictEqual(f.sent, cancelled ? [] : ["co,end,中文"]);
}
// Two identical commits are intentional, not a duplicate event to suppress.
{
  const f = fixture(); f.input("好"); f.input("好");
  assert.deepStrictEqual(f.sent, ["co,end,好", "co,end,好"]);
  assert.strictEqual(f.event("keydown", { key: "Enter" }).stopped, false);
}
// Preserve emoji, supplementary Chinese, punctuation and leading option-like text.
{
  const f = fixture(), text = "-中文,😀𠮷".repeat(80);
  f.input(text);
  assert.strictEqual(f.sent.map(s => s.slice(7)).join(""), text);
  assert(f.sent.every(s => Array.from(s.slice(7)).length <= 128));
}
// Only unsent chunks are retried, including failures halfway through a commit.
{
  const f = fixture(), text = "你".repeat(300);
  let calls = 0;
  f.socket.send = text => { if (++calls === 2) throw Error("busy"); f.sent.push(text); };
  f.input(text); assert.strictEqual(f.sent.length, 1);
  assert.strictEqual(f.window.selkiesRecoverPendingInput(), "你".repeat(172));
  f.socket.send = text => f.sent.push(text); f.tick();
  assert.strictEqual(f.sent.map(s => s.slice(7)).join(""), text);
}
// Backpressure retains committed text separately from the next composition.
{
  const f = fixture(); f.socket.bufferedAmount = 262144;
  f.input("第一段"); f.event("compositionstart"); f.input("di", { isComposing: true }); f.tick();
  assert.strictEqual(f.window.selkiesRecoverPendingInput(), "第一段");
  f.socket.bufferedAmount = 0;
  f.state.assist.value = "第二段"; f.event("compositionend"); f.tick();
  assert.deepStrictEqual(f.sent, ["co,end,第一段第二段"]);
}
// Failed delivery blocks remote Enter, and replacement connections get no replay.
{
  const f = fixture(); f.socket.send = () => { throw Error("closed"); };
  f.input("未发送");
  const key = f.event("keydown", { key: "Enter" }); assert(key.stopped && key.prevented);
  f.state.socket = { readyState: 1, bufferedAmount: 0, send() { throw Error("must not replay"); } };
  f.tick(); assert.strictEqual(f.window.selkiesRecoverPendingInput(), "未发送");
  assert(f.notices.some(args => args[1].title === "文字尚未发送"));
}
// Delegation covers remounted assist elements and leaves ordinary form fields alone.
{
  const f = fixture(); f.state.assist = { id: "keyboard-input-assist", value: "重建" };
  f.event("input"); assert.deepStrictEqual(f.sent, ["co,end,重建"]);
  assert(!f.event("input", { target: { id: "settings" } }).stopped);
}
console.log("IME delivery regressions passed");
