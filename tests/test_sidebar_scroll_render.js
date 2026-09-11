// Regression test for the scroll-preserving list renderer in
// selkies-runtime-overrides.js.
//
// The notification list re-renders every 3s and the link history every 2s. Both
// used to wipe innerHTML unconditionally, which collapsed scrollHeight for one
// frame so the browser clamped scrollTop back to 0 - the list visibly bounced to
// the top while the user was scrolling it. This test extracts the shipped
// helpers and drives them against a scroll model that reproduces that clamping.
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const target = path.join(
  __dirname,
  "..",
  "root",
  "usr",
  "share",
  "selkies",
  "selkies-dashboard",
  "src",
  "selkies-runtime-overrides.js"
);
const source = fs.readFileSync(target, "utf8");

const start = source.indexOf("  function renderScrollableList(list, signature, renderContent) {");
const end = source.indexOf("  function renderNotificationCenterHistory() {");
assert(start > 0, "renderScrollableList block start not found");
assert(end > start, "renderScrollableList block end not found");
const block = source.slice(start, end);

const api = new Function(
  block +
    "return { renderScrollableList: renderScrollableList, scrollListSignature: scrollListSignature };"
)();

const wheelGuardStart = source.indexOf("  function protectSidebarWheel(root) {");
const wheelGuardEnd = source.indexOf("  function ensureNotificationCenterStyle() {");
assert(wheelGuardStart > 0, "protectSidebarWheel block start not found");
assert(wheelGuardEnd > wheelGuardStart, "protectSidebarWheel block end not found");
const wheelGuardBlock = source.slice(wheelGuardStart, wheelGuardEnd);
const wheelApi = new Function(
  wheelGuardBlock + "return { protectSidebarWheel: protectSidebarWheel };"
)();

// Minimal element model. Clearing innerHTML collapses the content height and
// scrollTop is clamped *eagerly* whenever the content height changes - exactly
// the browser behaviour that caused the jump-to-top bug.
function makeList(options) {
  const opts = options || {};
  const rowHeight = 40;
  const list = {
    dataset: {},
    clientHeight: opts.clientHeight === undefined ? 300 : opts.clientHeight,
    scrollHeight: opts.contentRows ? opts.contentRows * rowHeight : 0,
  };
  let children = [];
  let top = opts.scrollTop || 0;

  const clamp = () => {
    const max = Math.max(0, list.scrollHeight - list.clientHeight);
    top = Math.max(0, Math.min(top, max));
  };
  clamp();

  Object.defineProperty(list, "scrollTop", {
    get() {
      return top;
    },
    set(value) {
      top = value;
      clamp();
    }
  });
  Object.defineProperty(list, "firstChild", {
    get() {
      return children.length ? children[0] : null;
    }
  });
  Object.defineProperty(list, "innerHTML", {
    get() {
      return "";
    },
    set(value) {
      if (value === "") {
        children = [];
        list.scrollHeight = 0;
        clamp();
      }
    }
  });
  list.appendChild = function (node) {
    children.push(node);
    list.scrollHeight += rowHeight;
    clamp();
    return node;
  };
  list.childCount = function () {
    return children.length;
  };
  list.maxScrollTop = function () {
    return Math.max(0, list.scrollHeight - list.clientHeight);
  };
  return list;
}

const items = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: "e" + i, ts: 1700000000000 + i }));

let passed = 0;
const renderRows = (count) => (list) => {
  for (let i = 0; i < count; i++) list.appendChild({});
};

// 1. First render populates the list.
{
  const list = makeList({});
  let calls = 0;
  api.renderScrollableList(list, "sig-a", (l) => {
    calls++;
    renderRows(20)(l);
  });
  assert.strictEqual(calls, 1, "first render must build the list");
  assert.strictEqual(list.childCount(), 20);
  passed++;
}

// 2. Unchanged content is not re-rendered at all (this is what stops the
//    periodic 2s/3s ticks from disturbing the scroll position).
{
  const list = makeList({});
  let calls = 0;
  const render = (l) => {
    calls++;
    renderRows(20)(l);
  };
  api.renderScrollableList(list, "sig-a", render);
  list.scrollTop = 250;
  api.renderScrollableList(list, "sig-a", render);
  api.renderScrollableList(list, "sig-a", render);
  assert.strictEqual(calls, 1, "identical content must not re-render");
  assert.strictEqual(list.scrollTop, 250, "scroll position must survive");
  passed++;
}

// 3. Changed content re-renders but keeps the scroll offset.
{
  const list = makeList({});
  api.renderScrollableList(list, "sig-a", renderRows(20));
  list.scrollTop = 250;
  assert.strictEqual(list.scrollTop, 250, "precondition: scrolled mid-list");
  api.renderScrollableList(list, "sig-b", renderRows(20));
  assert.strictEqual(list.scrollTop, 250, "scroll offset must be restored after a rebuild");
  passed++;
}

// 4. Regression guard: without preservation the rebuild would clamp to 0.
{
  const list = makeList({});
  api.renderScrollableList(list, "sig-a", renderRows(20));
  list.scrollTop = 250;
  list.innerHTML = ""; // the old unconditional wipe
  renderRows(20)(list);
  assert.strictEqual(list.scrollTop, 0, "unconditional wipe is what pinned the list to the top");
  passed++;
}

// 5. A list parked at the bottom follows new content instead of being yanked up.
{
  const list = makeList({});
  api.renderScrollableList(list, "sig-a", renderRows(20));
  list.scrollTop = list.scrollHeight; // stick to bottom
  assert.strictEqual(list.scrollTop, list.maxScrollTop(), "precondition: parked at the bottom");
  assert.ok(list.scrollTop > 0, "precondition: list is actually scrolled");
  api.renderScrollableList(list, "sig-b", renderRows(24));
  assert.strictEqual(
    list.scrollTop,
    list.maxScrollTop(),
    "should stay pinned to the bottom after more rows arrive"
  );
  passed++;
}

// 6. A shorter viewport against a tall list still restores a mid-list offset.
{
  const list = makeList({ clientHeight: 120 });
  api.renderScrollableList(list, "sig-a", renderRows(30));
  list.scrollTop = 400;
  assert.strictEqual(list.scrollTop, 400);
  api.renderScrollableList(list, "sig-b", renderRows(30));
  assert.strictEqual(list.scrollTop, 400);
  passed++;
}

// 7. Not scrolled (top) stays at the top.
{
  const list = makeList({});
  api.renderScrollableList(list, "sig-a", renderRows(20));
  assert.strictEqual(list.scrollTop, 0);
  api.renderScrollableList(list, "sig-b", renderRows(20));
  assert.strictEqual(list.scrollTop, 0);
  passed++;
}

// 8. Empty-state placeholder counts as content, so the empty list is skippable.
{
  const list = makeList({});
  let calls = 0;
  const render = (l) => {
    calls++;
    l.appendChild({ className: "selkies-notification-center-empty" });
  };
  api.renderScrollableList(list, "empty", render);
  api.renderScrollableList(list, "empty", render);
  assert.strictEqual(calls, 1, "placeholder counts as rendered content");
  passed++;
}

// 9. A missing list is a no-op rather than a crash.
{
  api.renderScrollableList(null, "sig", () => {
    throw new Error("render must not run for a missing list");
  });
  passed++;
}

// 10. Signatures are stable for identical content and change when content changes.
{
  const a = items(3);
  assert.strictEqual(
    api.scrollListSignature(a, 0),
    api.scrollListSignature(items(3), 0),
    "same content must produce the same signature"
  );
  assert.notStrictEqual(
    api.scrollListSignature(a, 0),
    api.scrollListSignature([...a, { id: "new", ts: 1 }], 0),
    "added entries must change the signature"
  );
  assert.notStrictEqual(
    api.scrollListSignature(a, 0),
    api.scrollListSignature([{ id: "e0b", ts: 1700000000000 }, a[1], a[2]], 0),
    "edited entries must change the signature"
  );
  passed++;
}

// 11. The time bucket lets derived labels ("3 分钟前") refresh at a bounded rate.
{
  const a = items(3);
  const now = Date.now();
  assert.strictEqual(
    api.scrollListSignature(a, 60000),
    api.scrollListSignature(a, 60000),
    "same minute bucket must be identical"
  );
  const bucket = Math.floor(now / 60000);
  const nextBucketSignature = api.scrollListSignature(a, 60000).split("|")[0];
  assert.strictEqual(
    nextBucketSignature,
    String(bucket),
    "signature must carry the current minute bucket"
  );
  passed++;
}

// 12. Unserializable input degrades gracefully instead of throwing.
{
  const circular = {};
  circular.self = circular;
  const sig = api.scrollListSignature([circular], 0);
  assert.strictEqual(typeof sig, "string", "signature must stay a string");
  assert.ok(sig.length > 0);
  passed++;
}

// 13. A native sidebar stops wheel propagation without cancelling its native
//     scrolling, and repeated mount scans do not install duplicate listeners.
{
  const listeners = [];
  const sidebar = {
    addEventListener(type, listener, options) {
      listeners.push({ type, listener, options });
    }
  };
  wheelApi.protectSidebarWheel(sidebar);
  wheelApi.protectSidebarWheel(sidebar);
  assert.strictEqual(listeners.length, 1, "wheel protection must be idempotent");
  assert.strictEqual(listeners[0].type, "wheel");
  assert.strictEqual(listeners[0].options.passive, true, "listener must remain passive");

  let stopped = 0;
  let prevented = 0;
  listeners[0].listener({
    stopPropagation() { stopped++; },
    preventDefault() { prevented++; }
  });
  assert.strictEqual(stopped, 1, "wheel must not reach the remote input layer");
  assert.strictEqual(prevented, 0, "native sidebar scrolling must not be cancelled");
  passed++;
}

// ---------------------------------------------------------------------------
// Host pinning + grouped mount.
//
// "动态节流" and "妙妙小工具" are appended to the upstream sidebar. Two things
// used to move them around while the user was scrolling: the host was
// re-resolved from scratch on every tick (and could return a *different*
// element), and each card appended itself straight onto whatever host had just
// been resolved. Detaching those (large) cards shrinks the sidebar's
// scrollHeight, the browser clamps scrollTop, and the list visibly bounces back
// to the sections above. These checks pin both behaviours down.
// ---------------------------------------------------------------------------
const pinStart = source.indexOf("  var sidebarHostCache = null;");
const pinEnd = source.indexOf("  function ensureDynamicLatencySection() {");
assert(pinStart > 0, "sidebar host pinning block start not found");
assert(pinEnd > pinStart, "sidebar host pinning block end not found");
const pinBlock = source.slice(pinStart, pinEnd);

const makePinApi = () =>
  new Function(
    pinBlock +
      "return { resolveSidebarHost: resolveSidebarHost," +
      " ensureSidebarToolboxGroup: ensureSidebarToolboxGroup," +
      " mountSidebarToolboxSection: mountSidebarToolboxSection," +
      " findSidebarScrollContainer: findSidebarScrollContainer };"
  )();

// A tiny layout model: appending a node that still lives elsewhere *moves* it,
// and any content-height change eagerly clamps the scroller's offset - exactly
// the browser behaviour that turns a re-parent into a visible bounce.
function createSidebarModel() {
  const created = [];
  const bodyEl = { tagName: "body", children: [], parentElement: null };
  const docEl = { tagName: "html", children: [], parentElement: bodyEl };
  let host = null;

  const measure = (node) => {
    if (node.height) return node.height;
    let total = 0;
    for (let i = 0; i < node.children.length; i++) total += measure(node.children[i]);
    return total;
  };

  const scroller = {
    tagName: "div",
    id: "sidebar-scroller",
    __overflowY: "auto",
    clientHeight: 300,
    isConnected: true,
    children: [],
    parentElement: bodyEl,
    scrollTop: 0,
    appends: 0,
    get scrollHeight() {
      return measure(this.children[0] || { children: [], height: 0 });
    }
  };

  const syncScroll = () => {
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.max(0, Math.min(scroller.scrollTop, max));
  };

  const makeEl = (tag) => {
    const el = {
      tagName: tag,
      id: "",
      className: "",
      children: [],
      parentElement: null,
      isConnected: true,
      clientHeight: 0,
      height: 0,
      __overflowY: "visible",
      appends: 0,
      get scrollHeight() {
        return measure(this);
      },
      appendChild(node) {
        if (node.parentElement) {
          const prev = node.parentElement;
          const i = prev.children.indexOf(node);
          if (i >= 0) prev.children.splice(i, 1);
        }
        this.children.push(node);
        node.parentElement = this;
        this.appends++;
        syncScroll();
        return node;
      }
    };
    created.push(el);
    return el;
  };

  host = makeEl("div");
  host.id = "native-sidebar";
  host.height = 0;
  scroller.children = [host];
  host.parentElement = scroller;

  const doc = {
    body: bodyEl,
    documentElement: docEl,
    head: { children: [], appendChild(n) { this.children.push(n); return n; } },
    createElement: makeEl,
    getElementById(id) {
      for (let i = 0; i < created.length; i++) if (created[i].id === id) return created[i];
      return null;
    }
  };

  return {
    doc,
    host,
    scroller,
    makeEl,
    measure,
    syncScroll,
    childIds(node) {
      return node.children.map((c) => c.id || c.tagName);
    }
  };
}

function installDom(model) {
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    findLocalLinkSidebarHost: globalThis.findLocalLinkSidebarHost
  };
  let resolvedHost = model.host;
  globalThis.document = model.doc;
  globalThis.window = {
    getComputedStyle: (node) => ({ overflowY: (node && node.__overflowY) || "visible" })
  };
  globalThis.findLocalLinkSidebarHost = () => resolvedHost;
  return {
    setResolvedHost(next) {
      resolvedHost = next;
    },
    restore() {
      globalThis.document = previous.document;
      globalThis.window = previous.window;
      globalThis.findLocalLinkSidebarHost = previous.findLocalLinkSidebarHost;
    }
  };
}

// 14. The sidebar host is pinned: re-resolving only happens once the cached host
//     is really detached from the document.
{
  const model = createSidebarModel();
  const dom = installDom(model);
  try {
    const api = makePinApi();
    const other = model.makeEl("div");
    other.id = "other-panel";
    other.isConnected = true;

    const first = api.resolveSidebarHost();
    assert.strictEqual(first, model.host, "first resolve returns the native sidebar");

    dom.setResolvedHost(other);
    assert.strictEqual(
      api.resolveSidebarHost(),
      model.host,
      "a still-connected host must stay pinned even if the scan would find another element"
    );

    model.host.isConnected = false;
    assert.strictEqual(
      api.resolveSidebarHost(),
      other,
      "once the pinned host is detached the scan runs again"
    );
    passed++;
  } finally {
    dom.restore();
  }
}

// 15. Both cards share one group, and the sidebar host only ever receives that
//     single group node - not the cards themselves.
{
  const model = createSidebarModel();
  const dom = installDom(model);
  try {
    const api = makePinApi();
    const latency = model.makeEl("div");
    latency.id = "selkies-dynamic-latency-section";
    latency.height = 420;
    const toolbox = model.makeEl("div");
    toolbox.id = "selkies-debug-tools-section";
    toolbox.height = 560;

    api.mountSidebarToolboxSection(latency);
    api.mountSidebarToolboxSection(toolbox);

    assert.deepStrictEqual(
      model.childIds(model.host),
      ["selkies-sidebar-toolbox-group"],
      "the host must hold exactly one grouped node"
    );
    const group = model.host.children[0];
    assert.deepStrictEqual(
      model.childIds(group),
      ["selkies-dynamic-latency-section", "selkies-debug-tools-section"],
      "both cards must live inside the group, in mount order"
    );
    assert.strictEqual(latency.parentElement, group);
    assert.strictEqual(toolbox.parentElement, group);
    passed++;
  } finally {
    dom.restore();
  }
}

// 16. Re-rendering a card does not re-append anything. This is what stops the
//     6s ticks from re-ordering (or briefly detaching) the grouped cards.
{
  const model = createSidebarModel();
  const dom = installDom(model);
  try {
    const api = makePinApi();
    const latency = model.makeEl("div");
    latency.id = "selkies-dynamic-latency-section";
    latency.height = 420;
    const toolbox = model.makeEl("div");
    toolbox.id = "selkies-debug-tools-section";
    toolbox.height = 560;

    api.mountSidebarToolboxSection(latency);
    api.mountSidebarToolboxSection(toolbox);
    const hostAppends = model.host.appends;
    const groupAppends = model.host.children[0].appends;

    for (let i = 0; i < 5; i++) {
      api.mountSidebarToolboxSection(latency);
      api.mountSidebarToolboxSection(toolbox);
    }
    assert.strictEqual(model.host.appends, hostAppends, "steady-state re-render must not touch the host");
    assert.strictEqual(model.host.children[0].appends, groupAppends, "steady-state re-render must not re-parent cards");
    passed++;
  } finally {
    dom.restore();
  }
}

// 17. The grouped mount preserves the sidebar's scroll offset, and it does so
//     even when the host would otherwise be re-resolved to a different panel.
{
  const model = createSidebarModel();
  const dom = installDom(model);
  try {
    const api = makePinApi();
    const latency = model.makeEl("div");
    latency.id = "selkies-dynamic-latency-section";
    latency.height = 420;
    const toolbox = model.makeEl("div");
    toolbox.id = "selkies-debug-tools-section";
    toolbox.height = 560;

    api.mountSidebarToolboxSection(latency);
    api.mountSidebarToolboxSection(toolbox);

    const native = model.makeEl("div");
    native.id = "native-settings";
    native.height = 900;
    model.host.appendChild(native); // native settings sit above our cards

    model.scroller.scrollTop = 400;
    model.syncScroll();
    assert.ok(model.scroller.scrollTop > 0, "precondition: the sidebar is scrolled down");

    const other = model.makeEl("div");
    other.id = "transient-panel";
    other.isConnected = true;
    dom.setResolvedHost(other); // what a fresh scan used to return mid-transition

    api.mountSidebarToolboxSection(latency);
    api.mountSidebarToolboxSection(toolbox);

    assert.strictEqual(model.scroller.scrollTop, 400, "the pinned host keeps the cards in place, so the offset survives");
    assert.ok(
      model.childIds(model.host).indexOf("selkies-sidebar-toolbox-group") >= 0,
      "the group must stay in the pinned sidebar"
    );
    assert.strictEqual(other.children.length, 0, "cards must not migrate to the transient panel");
    passed++;
  } finally {
    dom.restore();
  }
}

// 18. Contrast guard: re-parenting a card onto another host is what produced the
//     bounce. Moving the big blocks away collapses the sidebar and the offset is
//     clamped away - the exact failure the grouped mount avoids.
{
  const model = createSidebarModel();
  const dom = installDom(model);
  try {
    const latency = model.makeEl("div");
    latency.id = "selkies-dynamic-latency-section";
    latency.height = 420;
    const native = model.makeEl("div");
    native.id = "native-settings";
    // Deliberately shorter than the offset: once the card leaves, the sidebar
    // has nothing left to scroll and the offset cannot survive.
    native.height = 150;

    model.host.appendChild(native);
    model.host.appendChild(latency);
    model.scroller.scrollTop = 270;
    model.syncScroll();
    assert.strictEqual(model.scroller.scrollTop, 270, "precondition: scrolled past the native section");

    const other = model.makeEl("div");
    other.id = "transient-panel";
    other.appendChild(latency); // the old `host.appendChild(section)` against a fresh host
    assert.strictEqual(model.host.children.length, 1, "the card really left the sidebar");
    assert.strictEqual(
      model.scroller.scrollTop,
      0,
      "losing the card collapses the sidebar and clamps the offset - the reported bounce"
    );
    passed++;
  } finally {
    dom.restore();
  }
}

// ---------------------------------------------------------------------------
// Stall-detector body-text scan.
//
// `readBodyStatusText()` temporarily hides every injected overlay so the native
// "waiting for stream" banner is not masked by our own UI. It runs on several
// watchdogs (1s / 3s / 4s / 5s). Two of the excluded nodes - "动态节流" and
// "妙妙小工具" - live *inside* the settings sidebar, so hiding them with
// `display: none` collapsed the sidebar's scrollHeight on every scan and the
// browser clamped scrollTop: the reported bounce. `visibility: hidden` still
// keeps the text out of `innerText` while leaving layout (and the scroll
// offset) alone.
// ---------------------------------------------------------------------------
const excludeStart = source.indexOf("  var BODY_STATUS_EXCLUDE_IDS = [");
const excludeEnd = source.indexOf("  function isWaitingForStreamVisible() {");
assert(excludeStart > 0, "BODY_STATUS_EXCLUDE_IDS block start not found");
assert(excludeEnd > excludeStart, "BODY_STATUS_EXCLUDE_IDS block end not found");
const excludeBlock = source.slice(excludeStart, excludeEnd);
const makeExcludeApi = () =>
  new Function(
    excludeBlock +
      "return { readBodyStatusText: readBodyStatusText, BODY_STATUS_EXCLUDE_IDS: BODY_STATUS_EXCLUDE_IDS };"
  )();

function createScanModel() {
  const scroller = { clientHeight: 300, scrollTop: 1200, scrollHeight: 1880 };
  let clampCount = 0;

  const makeStyle = () => {
    let display = "";
    let visibility = "";
    return {
      get display() {
        return display;
      },
      set display(value) {
        display = value;
        reclamp();
      },
      get visibility() {
        return visibility;
      },
      set visibility(value) {
        visibility = value;
      }
    };
  };

  const makeEl = (id, height, text) => ({
    id,
    height,
    text: text || "",
    style: makeStyle()
  });

  const excluded = [
    makeEl("selkies-dynamic-latency-section", 420, "动态节流 闲置降载"),
    makeEl("selkies-debug-tools-section", 560, "妙妙小工具 通知剪贴板广播上传"),
    makeEl("selkies-notification-center", 0, "通知中心"),
    makeEl("selkies-activity-layer", 0, ""),
    makeEl("selkies-local-link-prompt", 0, ""),
    makeEl("selkies-adaptive-sleep-overlay", 0, ""),
    makeEl("selkies-bottom-action-dock-shell", 0, ""),
    makeEl("selkies-link-history-section", 0, "链接跳转历史")
  ];
  const inSidebar = [excluded[0], excluded[1]];
  const NATIVE_HEIGHT = 900;

  function reclamp() {
    const visible = inSidebar.reduce((sum, el) => sum + (el.style.display === "none" ? 0 : el.height), 0);
    scroller.scrollHeight = NATIVE_HEIGHT + visible;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (scroller.scrollTop > max) {
      scroller.scrollTop = max;
      clampCount++;
    }
  }
  reclamp();

  const body = {
    get innerText() {
      const parts = ["Waiting for stream"];
      inSidebar.forEach((el) => {
        if (el.style.visibility !== "hidden" && el.style.display !== "none") parts.push(el.text);
      });
      excluded.slice(2).forEach((el) => {
        if (el.style.visibility !== "hidden" && el.style.display !== "none" && el.text) parts.push(el.text);
      });
      return parts.join(" ");
    },
    get textContent() {
      return this.innerText;
    }
  };

  const doc = {
    body,
    documentElement: { tagName: "html" },
    getElementById(id) {
      for (let i = 0; i < excluded.length; i++) if (excluded[i].id === id) return excluded[i];
      return null;
    }
  };

  return { doc, scroller, excluded, clampCount: () => clampCount };
}

function installScanDom(model) {
  const previous = globalThis.document;
  globalThis.document = model.doc;
  return {
    restore() {
      globalThis.document = previous;
    }
  };
}

// 19. A scan excludes our overlays from the text, and costs the sidebar nothing:
//     no clamp, no offset change.
{
  const model = createScanModel();
  const dom = installScanDom(model);
  try {
    const api = makeExcludeApi();
    const text = api.readBodyStatusText();
    assert.ok(text.indexOf("Waiting for stream") >= 0, "native status text must still be read");
    assert.ok(
      text.indexOf("动态节流") < 0 && text.indexOf("妙妙小工具") < 0,
      "our own sidebar cards must stay out of the native text scan"
    );
    assert.ok(
      text.indexOf("通知中心") < 0 && text.indexOf("链接跳转历史") < 0,
      "the injected overlays must stay excluded as before"
    );
    assert.strictEqual(model.clampCount(), 0, "exclusion must not change layout at all");
    assert.strictEqual(model.scroller.scrollTop, 1200, "the sidebar scroll offset must survive a scan");
    passed++;
  } finally {
    dom.restore();
  }
}

// 20. Every excluded node is released again, and the exclusion is re-entrant
//     (watchdogs can fire back to back without leaving anything hidden).
{
  const model = createScanModel();
  const dom = installScanDom(model);
  try {
    const api = makeExcludeApi();
    api.readBodyStatusText();
    api.readBodyStatusText();
    model.excluded.forEach((el) => {
      assert.strictEqual(el.style.visibility, "", `${el.id} must be restored after the scan`);
      assert.notStrictEqual(el.style.display, "none", `${el.id} must never be display:none`);
    });
    assert.strictEqual(model.scroller.scrollTop, 1200, "offset still intact after repeated scans");
    passed++;
  } finally {
    dom.restore();
  }
}

// 21. Contrast guard: the old `display: none` exclusion is exactly what collapsed
//     the sidebar and threw away the offset, so the two big cards must be the
//     ones that matter here.
{
  const model = createScanModel();
  const latency = model.excluded[0];
  const before = model.scroller.scrollTop;
  latency.style.display = "none"; // the pre-fix behaviour
  assert.ok(model.clampCount() > 0, "hiding an in-sidebar card must force a clamp");
  assert.ok(model.scroller.scrollTop < before, "and that clamp is what moved the user's view");
  assert.strictEqual(model.scroller.scrollTop, 1160, "the view lands above the hidden card");
  passed++;
}

console.log(`sidebar-scroll: ${passed} checks passed`);
