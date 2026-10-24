// Execute the shipped assist guard with deterministic event order and transport failures.
const assert = require("assert");
const { fixture } = require("./helpers/ime_fixture");

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
// compositionend.data is authoritative even when the DOM is already empty.
{
  const f = fixture(); f.event("compositionstart");
  f.input("zhongwen", { isComposing: true });
  f.state.assist.value = "";
  f.event("compositionend", { data: "中文" }); f.tick();
  assert.deepStrictEqual(f.sent, ["co,end,中文"]);
}
// A second composition may start before any zero-delay callback can run.
{
  const f = fixture(); f.event("compositionstart");
  f.input("第一词", { isComposing: true });
  f.event("compositionend", { data: "第一词" });
  f.event("compositionstart"); f.input("dier", { isComposing: true }); f.tick();
  f.state.assist.value = "第二词";
  f.event("compositionend", { data: "第二词" }); f.tick();
  assert.strictEqual(f.sent.map(s => s.slice(7)).join(""), "第一词第二词");
}
// Cancellation may leave preedit in the DOM until the browser's final update.
{
  const f = fixture(); f.event("compositionstart"); f.input("pinyin", { isComposing: true });
  f.event("compositionend", { data: "" }); f.tick();
  assert.deepStrictEqual(f.sent, []);
}
// A late final input after the cleanup timer is the same commit, even when
// the browser still marks it as composing. Repeated words in new compositions
// must each be delivered once.
{
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    f.event("compositionstart"); f.input("hao", { isComposing: true });
    f.event("compositionend", { data: "好" }); f.tick();
    f.input("好", { data: "好", inputType: "insertCompositionText", isComposing: true });
  }
  assert.deepStrictEqual(f.sent, ["co,end,好", "co,end,好"]);
}
// A normal keydown immediately after end must not flush the stale DOM preedit
// or duplicate the word that was already snapshotted from the end event.
{
  const f = fixture(); f.event("compositionstart"); f.input("zhong", { isComposing: true });
  f.event("compositionend", { data: "中" });
  const e = f.event("keydown", { key: "a", code: "KeyA" });
  assert(!e.stopped && !e.prevented); f.tick();
  assert.deepStrictEqual(f.sent, ["co,end,中"]);
  assert.strictEqual(f.state.assist.value, "");
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
  assert.deepStrictEqual(f.sent, ["co,end,第一段", "co,end,第二段"]);
}
// Failed delivery blocks remote Enter, and replacement connections get no replay.
{
  const f = fixture(); f.socket.send = () => { throw Error("closed"); };
  f.input("未发送");
  f.socket.readyState = 3; f.state.socket = null;
  const key = f.event("keydown", { key: "Enter" }); assert(key.stopped && key.prevented);
  f.state.socket = { readyState: 1, bufferedAmount: 0, send() { throw Error("must not replay"); } };
  f.tick(); assert.strictEqual(f.window.selkiesRecoverPendingInput(), "未发送");
  assert(f.notices.some(args => args[1].title === "文字尚未发送"));
}
// Before a transport exists, let the native local input generate its input
// event and retain it until the initial connection becomes available.
{
  const f = fixture(); f.state.socket = null; f.input("中文");
  const e = f.event("keydown", { key: "a", code: "KeyA" });
  assert(e.stopped && !e.prevented); f.input("a");
  assert.strictEqual(f.window.selkiesRecoverPendingInput(), "中文a");
  f.state.socket = f.socket; f.tick();
  assert.deepStrictEqual(f.sent, ["co,end,中文", "co,end,a"]);
}
// Delegation covers remounted assist elements and leaves ordinary form fields alone.
{
  const f = fixture(); f.state.assist = { id: "keyboard-input-assist", value: "重建" };
  f.event("input"); assert.deepStrictEqual(f.sent, ["co,end,重建"]);
  assert(!f.event("input", { target: { id: "settings" } }).stopped);
}
console.log("IME delivery regressions passed");
