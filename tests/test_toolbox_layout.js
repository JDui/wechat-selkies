// Exercise the shipped toolbox markup and renderer without browser dependencies.
// The small DOM below parses the generated HTML so moved controls must still be
// reachable by their real selectors, rather than a prebuilt control fixture.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { fixture: imeFixture, createClock } = require("./helpers/ime_fixture");

const source = fs.readFileSync(path.join(__dirname, "../root/usr/share/selkies/selkies-dashboard/src/selkies-runtime-overrides.js"), "utf8");
function block(startName, endName) {
  const start = source.indexOf("  function " + startName + "(");
  const end = source.indexOf("  function " + endName + "(", start);
  assert(start >= 0 && end > start);
  return source.slice(start, end);
}

class Element {
  constructor(tag) {
    this.tagName = tag.toLowerCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.open = false;
    this.htmlWrites = 0;
    this.nodeType = 1;
    this.classList = { contains: name => String(this.className || this.getAttribute("class") || "").split(/\s+/).includes(name) };
  }
  get parentElement() { return this.parentNode; }
  get textContent() { return (this.text || "") + this.children.map(node => node.textContent).join(""); }
  set textContent(value) { this.text = value; this.children = []; }
  appendChild(child) {
    if (child.parentNode) child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = String(value);
    if (name === "open") this.open = true;
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  matches(selector) {
    if (selector[0] === ".") return this.classList.contains(selector.slice(1));
    if (selector[0] === "#") return (this.id || this.getAttribute("id")) === selector.slice(1);
    if (/^[\w-]+$/.test(selector)) return this.tagName === selector;
    const attribute = /^\[([\w-]+)(?:=['"]([^'"]*)['"])?\]$/.exec(selector);
    assert(attribute, "unsupported selector: " + selector);
    return this.getAttribute(attribute[1]) !== null &&
      (attribute[2] === undefined || this.getAttribute(attribute[1]) === attribute[2]);
  }
  querySelectorAll(selector) { return this.descendants().filter(node => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (selector.split(",").some(part => node.matches(part))) return node;
    }
    return null;
  }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  async dispatch(type) {
    const event = { target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} };
    for (const callback of this.listeners[type] || []) await callback(event);
  }
  set innerHTML(html) {
    this.htmlWrites++;
    this.children = [];
    const stack = [this];
    for (const token of html.match(/<[^>]+>|[^<]+/g) || []) {
      if (!token.startsWith("<")) {
        const parent = stack[stack.length - 1];
        parent.text = (parent.text || "") + token;
        continue;
      }
      if (token.startsWith("</")) {
        assert.strictEqual(stack.pop().tagName, token.slice(2, -1), "markup must remain correctly nested");
        continue;
      }
      const tag = /^<([\w-]+)/.exec(token)[1];
      const node = new Element(tag);
      const attributes = token.slice(tag.length + 1, -1);
      for (const match of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(match[1], match[2] || "");
      stack[stack.length - 1].appendChild(node);
      if (!["input", "hr", "br"].includes(tag)) stack.push(node);
    }
    assert.strictEqual(stack.length, 1, "all toolbox elements must close");
  }
}

function fixture(saved = new Map()) {
  const body = new Element("body");
  const head = new Element("head");
  const document = {
    body, head, activeElement: null,
    createElement: tag => new Element(tag),
    getElementById: id => [...body.descendants(), ...head.descendants()].find(node => node.id === id) || null,
    querySelectorAll: selector => body.querySelectorAll(selector),
  };
  const actions = { copy: 0, notification: 0, audio: 0 };
  const context = vm.createContext({
    document, window: {},
    getStoredValue: key => saved.get(key) ?? null,
    setStoredValue: (key, value) => saved.set(key, String(value)),
    resolveSidebarHost: () => body,
    ensureLocalLinkUiStyle() {},
    mountSidebarToolboxSection: section => { if (section.parentNode !== body) body.appendChild(section); },
    notificationPassthroughEnabled: false, notificationCenterEnabled: true,
    dockNetworkMonitorEnabled: false, autoSplitEnabled: false,
    legacyUploadFallbackEnabled: false, adaptiveSleepEnabled: true,
    adaptiveSleepIdleSeconds: 900, lanDiscoveryEnabled: false, lanBroadcastName: "AXISNSBOX-000",
    bottomActionClipboardButtonsEnabled: true, bottomActionDockPosition: "bottom",
    qqIdleBlurSeconds: 600, inputSamplingMultiplier: 1,
    formatInputSamplingLabel: value => value + "x",
    formatInputSamplingRates: () => "sampling rates",
    copyUnsentAssistInput: async () => { actions.copy++; },
    triggerPassthroughNotificationTest: () => { actions.notification++; },
    triggerWechatAudioNotificationTest: () => { actions.audio++; },
  });
  vm.runInContext(block("ensureDebugToolsSection", "applyInputSamplingMultiplier") +
    block("renderDebugToolsSection", "ensureGlassThemeStyle"), context);
  context.renderDebugToolsSection();
  const section = document.getElementById("selkies-debug-tools-section");
  const groups = section.querySelectorAll("[data-debug-group]");
  return { context, document, section, groups, saved, actions };
}

function controls(root) {
  return root.descendants().filter(node => ["input", "select", "button"].includes(node.tagName));
}
function listenerCount(root) {
  return controls(root).reduce((count, node) => count + Object.values(node.listeners).flat().length, 0);
}

function checkNativeKeyboard(section) {
  const bundle = fs.readFileSync(path.join(__dirname, "../root/usr/share/selkies/selkies-dashboard/assets/index-CzFxBFXa.js"), "utf8");
  function method(name, next) {
    const start = bundle.search(new RegExp(name + "\\([^)]*\\)\\{"));
    const end = bundle.indexOf(next + "(", start);
    assert(start >= 0 && end > start);
    return bundle.slice(start, end);
  }
  const keysyms = { Space: 32, Enter: 65293, Tab: 65289 };
  const nativeClass = /\bys="([^"]+)"/.exec(bundle)[1];
  const keyboard = new Function("ys", "Yi", "jn", "Oa", "y", "return ({" +
    method("_targetHasClass", "getWindowResolution") + "," +
    method("_handleKeyDown", "_handleKeyPress") + "," +
    method("_handleKeyUp", "_updateCompositionText") + "});")(
    nativeClass, { getKeyCode: event => event.code, getKeysym: event => keysyms[event.code] },
    event => { event.preventDefault(); event.stopPropagation(); },
    { isMac: () => false, isIOS: () => false, isWindows: () => false }, {}
  );
  const sent = [];
  keyboard._keyDownList = {};
  keyboard._guac_markEvent = () => true;
  keyboard._sendKeyEvent = function (keysym, code, down) {
    if (down) this._keyDownList[code] = keysym;
    else delete this._keyDownList[code];
    sent.push([code, down]);
  };
  const summary = section.querySelector("[data-debug-group]").children[0];
  for (const target of [summary, summary.children[0]]) {
    for (const code of Object.keys(keysyms)) {
      const event = { target, code, preventDefault() { throw Error("local navigation was cancelled"); }, stopPropagation() { throw Error("local navigation was swallowed"); } };
      keyboard._handleKeyDown(event);
      keyboard._handleKeyUp(event);
    }
  }
  assert.deepStrictEqual(sent, [], "the actual bundle handlers must not send toolbox navigation to the remote desktop");
  const remote = new Element("canvas");
  remote.id = "videoCanvas";
  const event = { target: remote, code: "Enter", preventDefault() {}, stopPropagation() {} };
  keyboard._handleKeyDown(event);
  keyboard._handleKeyUp(event);
  assert.deepStrictEqual(sent, [["Enter", true], ["Enter", false]], "the remote keyboard path remains active");
}

function checkFocusRecovery(section) {
  const clock = createClock();
  const f = imeFixture({ clock });
  const intervals = [];
  f.window.setInterval = callback => { intervals.push(callback); return intervals.length; };
  Object.assign(f.context, {
    imeFocusTimer: null, lastUiInteractionAt: 0,
    ensureLocalLinkUiStyle() {}, hasVisibleStreamSurface: () => true,
    normalizeKeyboardAssist: () => f.state.assist,
  });
  f.state.assist.removeAttribute = () => {};
  f.state.assist.focus = () => { f.document.activeElement = f.state.assist; };
  f.document.body = new Element("body");
  vm.runInContext(block("isFormLikeElement", "normalizeKeyboardAssist") +
    block("focusKeyboardAssist", "startClientAwakeHeartbeat"), f.context);
  f.context.bindImeFocusRecovery();
  clock.advance(10000);
  const summary = section.querySelector("[data-debug-group]").children[0];
  for (const target of [summary, summary.children[0]]) {
    f.document.activeElement = summary;
    f.event("pointerdown", { target });
    clock.advance(100);
    assert.strictEqual(f.document.activeElement, summary, "clicking a summary or its label must keep local focus");
    intervals.forEach(callback => callback());
    clock.advance(1);
    assert.strictEqual(f.document.activeElement, summary, "background recovery must respect focused summaries");
    f.event("focus", { target: f.window });
    clock.advance(100);
    assert.strictEqual(f.document.activeElement, summary, "window focus recovery must respect focused summaries");
  }
  const remote = new Element("canvas");
  remote.id = "videoCanvas";
  f.event("pointerdown", { target: remote });
  assert.strictEqual(f.document.activeElement, f.state.assist, "clicking the remote surface still restores the IME anchor");
}

(async () => {
  const f = fixture();
  assert.deepStrictEqual(f.groups.map(group => group.open), [true, false, false, false]);
  assert.deepStrictEqual(f.groups.map(group => controls(group).length), [4, 3, 5, 5]);
  assert.strictEqual(controls(f.section).length, 17, "all existing controls remain available");
  assert(controls(f.section).every(node => Object.keys(node.listeners).length > 0), "every moved control keeps its event binding");
  assert.strictEqual(listenerCount(f.section), 19);
  assert.strictEqual(f.section.querySelectorAll("[data-dll]").length, 0, "dynamic throttling keeps its independent card");
  assert(f.groups.every(group => group.children[0].tagName === "summary"), "groups use native keyboard-accessible summaries");
  assert(f.groups.every(group => group.getAttribute("name") === null), "multiple groups can stay open together");

  f.groups[0].open = false;
  await f.groups[0].dispatch("toggle");
  f.groups[1].open = true;
  await f.groups[1].dispatch("toggle");
  f.groups[2].open = true;
  await f.groups[2].dispatch("toggle");
  const originalControls = controls(f.section);
  for (let i = 0; i < 10; i++) f.context.renderDebugToolsSection();
  assert.deepStrictEqual(f.groups.map(group => group.open), [false, true, true, false], "polling preserves independently opened groups");
  assert.strictEqual(f.section.htmlWrites, 1, "polling must not rebuild the controls");
  assert.deepStrictEqual(controls(f.section), originalControls);
  assert.strictEqual(listenerCount(f.section), 19, "polling must not duplicate handlers");
  assert(f.groups.every(group => group.listeners.toggle.length === 1));

  const broadcast = f.section.querySelector('[data-debug-input="lan-broadcast-name"]');
  f.document.activeElement = broadcast;
  broadcast.value = "UNSAVED-DRAFT";
  f.context.lanDiscoveryEnabled = true;
  f.context.notificationPassthroughEnabled = true;
  f.context.adaptiveSleepEnabled = false;
  f.context.renderDebugToolsSection();
  assert.strictEqual(broadcast.value, "UNSAVED-DRAFT", "a changed setting must not overwrite focused input");
  assert.strictEqual(f.section.querySelector('[data-debug-row="lan-broadcast-name"]').getAttribute("data-hidden"), "0");
  assert.strictEqual(f.section.querySelector('[data-debug-row="idle-focus-seconds"]').getAttribute("data-hidden"), "0");
  assert.strictEqual(f.section.querySelector('[data-debug-select="adaptive-sleep-idle-seconds"]').disabled, true);
  assert.deepStrictEqual(f.groups.map(group => group.open), [false, true, true, false], "value updates preserve open groups too");
  assert.strictEqual(listenerCount(f.section), 19);

  await f.section.querySelector('[data-debug-action="copy-unsent-input"]').dispatch("click");
  await f.section.querySelector('[data-debug-action="notification-test"]').dispatch("click");
  await f.section.querySelector('[data-debug-action="wechat-audio-test"]').dispatch("click");
  assert.deepStrictEqual(f.actions, { copy: 1, notification: 1, audio: 1 }, "relocated actions still dispatch exactly once");
  const reloaded = fixture(f.saved);
  assert.deepStrictEqual(reloaded.groups.map(group => group.open), [false, true, true, false], "reload restores each saved choice");
  const invalid = fixture(new Map([["toolbox_group_interface_open", "invalid"], ["toolbox_group_maintenance_open", "invalid"]]));
  assert.deepStrictEqual(invalid.groups.map(group => group.open), [true, false, false, false], "invalid saved values retain defaults");
  checkNativeKeyboard(f.section);
  checkFocusRecovery(f.section);

  vm.runInContext(fs.readFileSync(path.join(__dirname, "../root/usr/share/selkies/selkies-dashboard/src/selkies-runtime-cleanups.js"), "utf8"), f.context);
  assert.strictEqual(controls(f.section).length, 16, "the existing cleanup still removes the legacy audio test");
  assert.strictEqual(f.section.querySelector('[data-debug-action="wechat-audio-test"]'), null);
  const testButton = f.section.querySelector('[data-debug-action="notification-test"]');
  assert.strictEqual(testButton.parentElement.children.length, 1, "notification test is the only remaining action in its row");
  assert(f.document.getElementById("selkies-toolbox-style").textContent.includes(".selkies-tool-actions>.selkies-repair-btn:only-child{grid-column:1/-1}"), "a lone test action spans the row");
  assert(f.section.querySelectorAll(".selkies-repair-note").some(note => note.textContent === "测试会在 5 秒倒计时后触发。"));
  f.context.renderDebugToolsSection();
  assert.strictEqual(controls(f.section).length, 16, "polling does not recreate the removed legacy action");
  console.log("PASS toolbox layout: grouping, bindings, polling, saved expansion, local keyboard/focus and legacy cleanup");
})().catch(error => { console.error(error); process.exitCode = 1; });
