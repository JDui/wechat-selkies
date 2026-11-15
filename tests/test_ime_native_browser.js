// Chromium's native editing/IME events plus the shipped Selkies input class.
// CDP simulates the browser editing pipeline, not a Windows OS IME engine.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { source } = require("./helpers/ime_fixture");
const runtime = process.env.CODEX_NODE_MODULES || path.join(os.homedir(),
  ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules");
const { chromium } = require(path.join(runtime, "playwright"));
const bundle = fs.readFileSync(path.join(__dirname,
  "../root/usr/share/selkies/selkies-dashboard/assets/index-CzFxBFXa.js"), "utf8");
const classStart = bundle.indexOf("class iu{");
const prefixEnd = bundle.indexOf("class Ay{", classStart);
assert(classStart > 0 && prefixEnd > classStart, "shipped input-class boundary changed");
const guardStart = source.indexOf("  var ASSIST_TYPING_COOLDOWN_MS");
const guardEnd = source.indexOf("  function focusKeyboardAssist(", guardStart);
assert(guardStart > 0 && guardEnd > guardStart);

async function setup(browser, appleTouch = false) {
  const page = await browser.newPage({ hasTouch: appleTouch });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.setContent('<div style="width:800px;height:600px"><input id="overlayInput" readonly>' +
    '<video id="stream" contenteditable="true"></video><input id="keyboard-input-assist"><input id="settings"></div>');
  if (appleTouch) await page.evaluate(() => {
    // Exercise our iPad branch in Chromium; this is not native WebKit validation.
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
    Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 });
  });
  await page.evaluate(guard => {
    window.sent = []; window.events = [];
    for (const type of ["keydown", "keyup", "beforeinput", "input", "compositionstart", "compositionupdate", "compositionend"]) {
      window.addEventListener(type, e => window.events.push({ type, target: e.target.id,
        data: e.data, key: e.key, code: e.code, isComposing: e.isComposing,
        inputType: e.inputType, value: e.target.value }), true);
    }
    const socket = { readyState: 1, bufferedAmount: 0, send: text => window.sent.push(text) };
    // var is required because the shipped guard updates this flag.
    window.getPrimaryOpenDataSocket = () => socket;
    window.setActivityTask = () => {}; window.completeActivityTask = () => {};
    window.eval("var imeCompositionActive = false;\n" + guard + "\ninstallAssistInputGuard();");
  }, source.slice(guardStart, guardEnd));
  await page.addScriptTag({ content: bundle.slice(0, prefixEnd) + "\nwindow.__InputClass = iu;" });
  await page.evaluate(() => {
    const inst = new window.__InputClass(document.getElementById("overlayInput"), msg => window.sent.push(msg));
    inst.attach_context(); window.webrtcInput = inst;
    // Include the bundle's legacy target listener, which can otherwise clear
    // the assist and/or forward a second copy after the capture guard.
    const assist = document.getElementById("keyboard-input-assist");
    assist.addEventListener("input", () => { if (assist.value) { inst._typeString(assist.value); assist.value = ""; } });
    assist.focus();
  });
  if (appleTouch) await page.evaluate(focusSource => {
    window.ensureLocalLinkUiStyle = () => {};
    window.noteUiInteraction = () => {};
    window.hasVisibleStreamSurface = () => true;
    window.eval("var imeFocusTimer = null, lastUiInteractionAt = 0;\n" + focusSource + "\nbindImeFocusRecovery();");
  }, source.slice(source.indexOf("  function isFormLikeElement("), source.indexOf("  // Own assist events")) +
     source.slice(source.indexOf("  function isRemoteKeyboardSurface("), source.indexOf("  function startClientAwakeHeartbeat(")));
  return { page, cdp: await page.context().newCDPSession(page), errors };
}

async function compose(cdp, text, key = "Space") {
  await cdp.send("Input.imeSetComposition", { text: "zhongwenchangjuhouxuan", selectionStart: 22, selectionEnd: 22 });
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: key === "Space" ? " " : "1",
    code: key, windowsVirtualKeyCode: key === "Space" ? 32 : 49 });
  await cdp.send("Input.insertText", { text });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: key === "Space" ? " " : "1",
    code: key, windowsVirtualKeyCode: key === "Space" ? 32 : 49 });
}

(async () => {
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  try {
    for (const key of ["Space", "Digit1"]) {
      const { page, cdp, errors } = await setup(browser);
      const words = ["首字需要完整保留的一整段中文", "首字需要完整保留的一整段中文", "另一个候选长句😀𠮷"];
      try {
        for (const text of words) await compose(cdp, text, key);
        const result = await page.evaluate(() => ({ sent, events }));
        const text = result.sent.filter(s => s.startsWith("co,end,")).map(s => s.slice(7)).join("");
        if (process.env.IME_TRACE) console.log(JSON.stringify({ key, sent: result.sent, events: result.events, errors }));
        assert.strictEqual(text, words.join(""), "native IME commit lost or duplicated text");
        assert.deepStrictEqual(errors, []);
        console.log("PASS native Chromium repeated long commits: " + key);
      } finally { await page.close(); }
    }
    const { page, errors } = await setup(browser, true);
    try {
      await page.keyboard.type("a11");
      await page.locator("#overlayInput").click();
      assert.strictEqual(await page.evaluate(() => document.activeElement.id), "keyboard-input-assist");
      await page.keyboard.type("b2");
      await page.evaluate(() => {
        const assist = document.getElementById("keyboard-input-assist");
        assist.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        assist.value = "ni";
        document.getElementById("settings").focus();
        focusKeyboardAssist();
      });
      assert.strictEqual(await page.evaluate(() => document.activeElement.id), "settings");
      assert.strictEqual(await page.evaluate(() => assistComposing), false);
      const box = await page.locator("#overlayInput").boundingBox();
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      assert.strictEqual(await page.evaluate(() => document.activeElement.id), "keyboard-input-assist");
      await page.keyboard.type("c3");
      const packets = await page.evaluate(() => sent);
      assert.strictEqual(packets.filter(s => s.startsWith("co,end,")).map(s => s.slice(7)).join(""), "a11b2c3");
      assert(!packets.some(s => /^(kd|ku),(49|50|51|97|98|99)$/.test(s)), "text must not also take legacy key path");
      assert.deepStrictEqual(errors, []);
      console.log("PASS Chromium iPad profile: native text, mouse/touch focus, element blur recovery, no duplicate keys");
    } finally { await page.close(); }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
