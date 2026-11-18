// Reconnect must quarantine old unsent input without blocking new input or
// replaying an old Enter into the newly focused application.
const assert = require("assert");
const vm = require("vm");
const { fixture, source } = require("./helpers/ime_fixture");

function replaceSocket(f) {
  const sent = [];
  const socket = { readyState: 1, bufferedAmount: 0,
    send(packet) {
      if (!f.context.queueAssistKeyCommand(socket, packet)) sent.push(packet);
    }
  };
  f.state.socket = socket;
  return { socket, sent };
}

function compose(f, text) {
  f.event("compositionstart");
  f.input("pinyin", { isComposing: true, inputType: "insertCompositionText", data: "pinyin" });
  f.state.assist.value = text;
  f.event("compositionend", { data: text });
  f.input(text, { isComposing: false, inputType: "insertFromComposition", data: text });
}

function repair(f) {
  for (const name of ["noteUiInteraction", "resetClientClipboardRuntime", "clearAllHighLoadState",
    "sendRawDataCommand", "scheduleKeyboardAssistFocus"]) f.context[name] = () => {};
  f.context.normalizeKeyboardAssist = () => f.state.assist;
  const start = source.indexOf("  function repairImeAndClipboardLight(");
  const end = source.indexOf("  function repairImeAndClipboardHeavy(", start);
  vm.runInContext(source.slice(start, end) + "\nrepairImeAndClipboardLight();", f.context);
}

// The reconnect retry timer need not run before the next input. Keep only the
// old text for recovery; old Enter and modifier packets must never replay.
for (const retryFirst of [false, true]) {
  const f = fixture();
  f.socket.bufferedAmount = 262144;
  compose(f, "旧文字");
  f.context.queueAssistKeyCommand(f.socket, "kd,65293");
  f.context.queueAssistKeyCommand(f.socket, "ku,65293");
  const next = replaceSocket(f);
  if (retryFirst) f.tick();
  compose(f, "新文字");
  f.tick();
  assert.deepStrictEqual(next.sent, ["co,end,新文字"]);
  assert.strictEqual(f.window.selkiesRecoverPendingInput(), "旧文字");
  assert.strictEqual(f.timerCount(), 0);
}

// A temporary gap is a lost transport, not permission to send old/offline
// commits to whichever application happens to be focused after reconnect.
{
  const f = fixture();
  f.socket.bufferedAmount = 262144;
  compose(f, "断线前");
  f.socket.readyState = 3;
  f.state.socket = null;
  f.tick();
  compose(f, "离线期间");
  f.tick();
  const next = replaceSocket(f);
  f.tick();
  assert.deepStrictEqual(next.sent, []);
  compose(f, "连接后");
  assert.deepStrictEqual(next.sent, ["co,end,连接后"]);
  assert.strictEqual(f.window.selkiesRecoverPendingInput(), "断线前离线期间");
}

// An already accepted chunk cannot be recalled or repeated. Only the unsent
// suffix remains available, even when it contains supplementary characters.
{
  const f = fixture();
  const text = "😀𠮷中".repeat(100);
  f.socket.send = packet => { f.sent.push(packet); f.socket.bufferedAmount = 262144; };
  f.input(text);
  const accepted = f.sent[0].slice(7);
  const next = replaceSocket(f);
  f.input("继续输入");
  assert.deepStrictEqual(next.sent, ["co,end,继续输入"]);
  assert.strictEqual(accepted + f.window.selkiesRecoverPendingInput(), text);
  f.tick();
  assert.deepStrictEqual(next.sent, ["co,end,继续输入"]);
}

// An IME composition belongs to the transport on which it started. A late
// end or final input must not move it to the replacement connection.
for (const boundary of ["direct", "offline", "focusout"]) {
  const f = fixture();
  f.event("compositionstart");
  f.input("pinyin", { isComposing: true, inputType: "insertCompositionText", data: "pinyin" });
  if (boundary === "focusout") f.event("focusout");
  if (boundary === "offline") {
    f.socket.readyState = 3;
    f.state.socket = null;
    f.context.flushAssistInput();
  }
  const next = replaceSocket(f);
  f.state.assist.value = "切换时提交";
  f.event("compositionend", { data: "切换时提交" });
  f.tick();
  f.input("切换时提交", { isComposing: false, inputType: "insertFromComposition", data: "切换时提交" });
  assert.deepStrictEqual(next.sent, []);
  assert.strictEqual(f.window.selkiesRecoverPendingInput(), "切换时提交");
  compose(f, "新的组词");
  assert.deepStrictEqual(next.sent, ["co,end,新的组词"]);
}

// Some keyboards give an empty compositionend and commit in the final input.
{
  const f = fixture();
  f.event("compositionstart");
  f.input("pinyin", { isComposing: true, inputType: "insertCompositionText", data: "pinyin" });
  const next = replaceSocket(f);
  f.event("compositionend", { data: "" });
  f.tick();
  f.input("延迟候选", { isComposing: false, inputType: "insertFromComposition", data: "延迟候选" });
  assert.deepStrictEqual(next.sent, []);
  assert.strictEqual(f.window.selkiesRecoverPendingInput(), "延迟候选");
  compose(f, "正常候选");
  assert.deepStrictEqual(next.sent, ["co,end,正常候选"]);
}

// Explicit preedit can arrive without compositionstart. Its eventual end or
// standalone final input still belongs to the old transport.
for (const endEvent of [true, false]) {
  const f = fixture();
  f.input("pinyin", { isComposing: true, inputType: "insertCompositionText", data: "pinyin" });
  const next = replaceSocket(f);
  if (endEvent) {
    f.state.assist.value = "缺少开始事件";
    f.event("compositionend", { data: "缺少开始事件" });
  } else {
    f.input("缺少开始事件", { isComposing: false, inputType: "insertFromComposition", data: "缺少开始事件" });
  }
  assert.deepStrictEqual(next.sent, []);
  assert.strictEqual(f.window.selkiesRecoverPendingInput(), "缺少开始事件");
  compose(f, "之后正常输入");
  assert.deepStrictEqual(next.sent, ["co,end,之后正常输入"]);
}

// A context-menu paste or drop is a new action, even without a keydown. An
// interrupted composition must neither capture it nor lose its own binding
// when its delayed end arrives after that independent insertion.
for (const boundary of ["focusout", "blur"]) {
  for (const inputType of ["insertFromPaste", "insertFromDrop", "insertFromPasteAsQuotation", "insertFromYank"]) {
    const f = fixture();
    f.event("compositionstart");
    f.input("jiu", { isComposing: true, inputType: "insertCompositionText", data: "jiu" });
    f.event(boundary);
    const next = replaceSocket(f);
    f.input("新的粘贴", { isComposing: false, inputType, data: "新的粘贴" });
    assert.deepStrictEqual(next.sent, ["co,end,新的粘贴"], boundary + ":" + inputType);
    assert.strictEqual(f.window.selkiesRecoverPendingInput(), "");
    f.state.assist.value = "迟到旧提交";
    f.event("compositionend", { data: "迟到旧提交" });
    f.tick();
    f.input("迟到旧提交", { isComposing: false, inputType: "insertFromComposition", data: "迟到旧提交" });
    assert.deepStrictEqual(next.sent, ["co,end,新的粘贴"]);
    assert.strictEqual(f.window.selkiesRecoverPendingInput(), "迟到旧提交");
  }
}

// New backpressure retains ordering after a reconnect, without being tied to
// the old connection or including an old queued Enter.
{
  const f = fixture();
  f.socket.bufferedAmount = 262144;
  compose(f, "旧文字");
  const next = replaceSocket(f);
  next.socket.bufferedAmount = 262144;
  compose(f, "新文字");
  next.socket.send("kd,97"); next.socket.send("ku,97");
  next.socket.send("kd,65293"); next.socket.send("ku,65293");
  next.socket.bufferedAmount = 0;
  f.tick();
  assert.deepStrictEqual(next.sent, ["co,end,新文字", "kd,97", "ku,97", "kd,65293", "ku,65293"]);
  assert.strictEqual(f.window.selkiesRecoverPendingInput(), "旧文字");
}

// The existing repair action resets input, but cannot silently resend either
// previously quarantined text or old native key actions on the next keypress.
{
  const f = fixture();
  f.socket.bufferedAmount = 262144;
  compose(f, "修复前");
  f.context.queueAssistKeyCommand(f.socket, "kd,65293");
  f.context.queueAssistKeyCommand(f.socket, "ku,65293");
  const next = replaceSocket(f);
  repair(f);
  compose(f, "修复后");
  f.tick();
  assert.deepStrictEqual(next.sent, ["co,end,修复后"]);
  assert.strictEqual(f.window.selkiesRecoverPendingInput(), "修复前");
}

// Repair retires interrupted preedit. A late end stays recoverable, while
// fresh explicit preedit does not inherit that retired transport binding.
for (const freshPreedit of [false, true]) {
  const f = fixture();
  f.event("compositionstart");
  f.input("jiu", { isComposing: true, inputType: "insertCompositionText", data: "jiu" });
  const next = replaceSocket(f);
  repair(f);
  if (freshPreedit) {
    f.input("xin", { isComposing: true, inputType: "insertCompositionText", data: "xin" });
  }
  const text = freshPreedit ? "新预编辑" : "迟到提交";
  f.state.assist.value = text;
  f.event("compositionend", { data: text });
  assert.deepStrictEqual(next.sent, freshPreedit ? ["co,end," + text] : []);
  assert.strictEqual(f.window.selkiesRecoverPendingInput(), freshPreedit ? "" : text);
}

console.log("PASS IME reconnect isolation: new input, offline gaps, partial sends, composition boundaries, FIFO and repair");
