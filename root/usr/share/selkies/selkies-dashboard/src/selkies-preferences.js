(function () {
  "use strict";
  var script = document.currentScript;
  // The script lives in src/; retain the deployment subfolder.
  var api = new URL("../api/preferences", script.src).pathname;
  var pending = {};
  var inFlight = {};
  var storageKey = "selkies.pendingPreferences:" + api;
  try {
    var cached = JSON.parse(localStorage.getItem(storageKey) || "{}");
    if (cached && typeof cached === "object" && !Array.isArray(cached)) pending = cached;
  } catch (_err) {}
  var timer;
  var saving = false;
  function cachePending() {
    try { localStorage.setItem(storageKey, JSON.stringify(Object.assign({}, inFlight, pending))); }
    catch (_err) {}
  }
  async function request(options) {
    var response = await fetch(api, Object.assign({ credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(5000) }, options));
    if (!response.ok) throw new Error("设置保存失败 (" + response.status + ")");
    return (await response.json()).preferences || {};
  }
  async function flush() {
    if (saving || !Object.keys(pending).length) return;
    saving = true;
    var batch = pending;
    inFlight = batch;
    pending = {};
    try {
      await request({ method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch) });
    } catch (error) {
      pending = Object.assign(batch, pending);
      window.dispatchEvent(new CustomEvent("selkies-preferences-error", { detail: error.message }));
    } finally {
      inFlight = {};
      cachePending();
      saving = false;
      if (Object.keys(pending).length) timer = setTimeout(flush, 3000);
    }
  }
  window.selkiesPreferences = {
    load: async function () {
      var local = Object.assign({}, inFlight, pending);
      return Object.assign(await request(), local, inFlight, pending);
    },
    save: function (key, value) {
      pending[key] = value;
      cachePending();
      clearTimeout(timer);
      timer = setTimeout(flush, 150);
    }
  };
  window.addEventListener("pagehide", flush);
  if (Object.keys(pending).length) timer = setTimeout(flush, 150);
})();
