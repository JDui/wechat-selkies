// Targeted event replays; these do not emulate an iPad OS keyboard.
const assert = require("assert");
const vm = require("vm");
const { fixture, source, createClock } = require("./helpers/ime_fixture");
const ipad = { platform: "MacIntel", maxTouchPoints: 5, userAgent: "Macintosh Safari" };

for (const key of ["a", "1", " ", "😀", "Unidentified", "Dead"]) {
  const f = fixture({ navigator: ipad });
  for (const type of ["keydown", "keyup"]) {
    const e = f.event(type, { key, code: "", isComposing: false });
    assert(e.stopped && !e.prevented, key + " must retain native editing");
  }
  f.input("a1", { inputType: "insertText", data: "a1", isComposing: false });
  assert.deepStrictEqual(f.sent, ["co,end,a1"]);
}
{
  const f = fixture({ navigator: ipad });
  for (const key of ["Enter", "Backspace", "ArrowLeft"]) {
    assert(!f.event("keydown", { key }).stopped, "remote action must remain available");
  }
  assert(!f.event("keydown", { key: "c", metaKey: true }).stopped);
  assert(!fixture().event("keydown", { key: "a", code: "KeyA" }).stopped);
}

for (const finishAfterBlur of [false, true]) {
  const f = fixture({ navigator: ipad });
  f.event("compositionstart");
  f.input("ni", { isComposing: true, inputType: "insertCompositionText" });
  f.event("focusout");
  assert.strictEqual(f.state.assist.value, "");
  assert.deepStrictEqual(f.sent, []);
  if (finishAfterBlur) {
    f.event("compositionend", { data: "你" });
    f.input("你", { data: "你", inputType: "insertFromComposition", isComposing: false });
  }
  f.input("a", { data: "a", inputType: "insertText", isComposing: false });
  f.input("1", { data: "1", inputType: "insertText", isComposing: false });
  assert.deepStrictEqual(f.sent, finishAfterBlur ? ["co,end,你", "co,end,a", "co,end,1"] : ["co,end,a", "co,end,1"]);
}
{
  const f = fixture();
  f.event("compositionstart");
  f.input("ni", { isComposing: true });
  f.event("focusout", { target: { id: "settings" } });
  assert.strictEqual(f.context.assistComposing, true);
  f.state.assist = { id: "keyboard-input-assist", value: "" };
  assert(!f.event("keydown", { key: "a", code: "KeyA" }).stopped);
  assert.strictEqual(f.context.assistComposing, false);
}
for (const appended of [false, true]) {
  const f = fixture();
  f.event("compositionstart");
  f.state.assist.value = "a";
  f.event("compositionend", { data: "a" });
  f.event("beforeinput", { data: "a", inputType: "insertText", isComposing: false });
  f.input(appended ? "aa" : "a", { data: "a", inputType: "insertText", isComposing: false });
  f.tick();
  assert.deepStrictEqual(f.sent, appended ? ["co,end,a", "co,end,a"] : ["co,end,a"]);
}

// Exercise the actual focus functions with a clock and minimal DOM surface.
const clock = createClock();
const listeners = {};
const body = {};
function target(remote, form) {
  return { closest: selector => selector === "#overlayInput,#stream,#videoCanvas" ? (remote ? {} : null) : (form ? {} : null) };
}
const overlay = target(true, true), settings = target(false, true);
let focuses = 0;
const document = {
  body, hidden: false, activeElement: body,
  getElementById: () => assist,
  addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); }
};
const assist = { ...target(false, true), removeAttribute() {}, focus() { focuses++; document.activeElement = assist; } };
const context = vm.createContext({
  document, Date: { now: clock.now },
  window: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval() {}, addEventListener() {} },
  normalizeKeyboardAssist: () => assist, ensureLocalLinkUiStyle() {}, installAssistInputGuard() {},
  noteUiInteraction() {}, noteAssistInput() {}, hasVisibleStreamSurface: () => true,
  imeFocusTimer: null, imeCompositionActive: false, assistComposing: false,
  lastAssistInputAt: 0, lastUiInteractionAt: 0, ASSIST_TYPING_COOLDOWN_MS: 2000
});
vm.runInContext(source.slice(source.indexOf("  function isFormLikeElement("), source.indexOf("  function normalizeKeyboardAssist(")) +
  source.slice(source.indexOf("  function isRemoteKeyboardSurface("), source.indexOf("  function startClientAwakeHeartbeat(")), context);
context.bindImeFocusRecovery();
const e = { target: overlay, button: 0, prevented: false, preventDefault() { this.prevented = true; } };
listeners.pointerdown[0](e);
assert.strictEqual(document.activeElement, assist, "remote gesture focuses synchronously during cooldown");
listeners.mousedown[0](e);
assert(e.prevented, "readonly overlay must not steal mouse focus");
assert.strictEqual(focuses, 1, "already focused composition anchor is not refocused");
document.activeElement = settings;
listeners.pointerdown[0]({ target: settings });
context.focusKeyboardAssist();
assert.strictEqual(document.activeElement, settings, "settings retain focus");
document.activeElement = overlay;
context.focusKeyboardAssist();
clock.advance(1999);
assert.strictEqual(document.activeElement, overlay);
clock.advance(1);
assert.strictEqual(document.activeElement, assist, "background recovery retries after cooldown");
console.log("PASS iPad input: native text routing, element blur/remount recovery, repeated character, focus and cooldown");
