const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../root/usr/share/selkies/selkies-dashboard/src/selkies-preferences.js"), "utf8");
const runtimeSource = fs.readFileSync(path.join(__dirname, "../root/usr/share/selkies/selkies-dashboard/src/selkies-runtime-overrides.js"), "utf8");
const runtimeStorage = {};
const saved = [];
const runtimeScope = {
  window: {
    location: { href: "http://example.test:3000/box/" },
    localStorage: { getItem: key => runtimeStorage[key] ?? null,
      setItem: (key, value) => { runtimeStorage[key] = value; }, removeItem: key => { delete runtimeStorage[key]; } },
    selkiesPreferences: { save: (...args) => saved.push(args) }
  },
  appBasePath: () => "/box/", toolPreferencesReady: false
};
for (const name of ["nativeSelkiesStoragePrefix", "storagePrefix", "legacyStorageKey", "storageKey",
  "getStoredValue", "setStoredValue", "isPersistentToolPreference"]) {
  const start = runtimeSource.indexOf("  function " + name + "(");
  const end = runtimeSource.indexOf("\n  function ", start + 1);
  vm.runInNewContext(runtimeSource.slice(start, end), runtimeScope);
}
runtimeScope.setStoredValue("framerate", 30);
assert.equal(runtimeStorage["http://example.test:3000/box/_framerate"], "30");
runtimeStorage["http://example.test:3000/box/_framerate"] = "45";
assert.equal(runtimeScope.getStoredValue("framerate"), "45", "Read the native UI's latest setting");
runtimeStorage[runtimeScope.legacyStorageKey("auto_split_enabled")] = "true";
assert.equal(runtimeScope.getStoredValue("auto_split_enabled"), "true", "Migrate legacy custom preferences");
runtimeScope.setStoredValue("notification_center_enabled", true);
assert.equal(saved.length, 0, "Bootstrap defaults must not overwrite server preferences");
runtimeScope.toolPreferencesReady = true;
runtimeScope.setStoredValue("notification_center_enabled", false);
assert.equal(saved.length, 1);
console.log("Runtime: native storage keys, user FPS, legacy migration and hydration guard passed");

function client(storage, fetch) {
  const events = {};
  const timers = [];
  const scope = { URL, AbortSignal, fetch,
    document: { currentScript: { src: "https://example.test/box/src/selkies-preferences.js?v=1.59" } },
    localStorage: { getItem: key => storage[key] || null, setItem: (key, value) => { storage[key] = value; } },
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {},
    CustomEvent: class { constructor(type, detail) { this.type = type; this.detail = detail; } },
    window: { addEventListener: (key, fn) => { events[key] = fn; }, dispatchEvent() {} }
  };
  vm.runInNewContext(source, scope);
  return { api: scope.window.selkiesPreferences, flush: events.pagehide, timers };
}

(async () => {
  const storage = {};
  let finish;
  const first = client(storage, (url, options) => {
    assert.equal(url, "/box/api/preferences");
    if (options.method === "POST") return new Promise(resolve => { finish = resolve; });
    return Promise.resolve({ ok: true, json: async () => ({ preferences: { bottom_action_dock_position: "bottom" } }) });
  });
  first.api.save("bottom_action_dock_position", "top");
  const sending = first.flush();
  first.api.save("bottom_action_dock_position", "bottom");
  first.api.save("notification_center_enabled", false);
  assert.equal((await first.api.load()).notification_center_enabled, false);
  assert.deepEqual(JSON.parse(storage["selkies.pendingPreferences:/box/api/preferences"]), {
    bottom_action_dock_position: "bottom", notification_center_enabled: false
  });
  finish({ ok: true, json: async () => ({ preferences: {} }) });
  await sending;
  // A reload must retain changes queued behind an in-flight request.
  let sent;
  const reloaded = client(storage, async (_url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ preferences: sent }) };
  });
  await reloaded.flush();
  assert.deepEqual(sent, { bottom_action_dock_position: "bottom", notification_center_enabled: false });
  assert.equal(storage["selkies.pendingPreferences:/box/api/preferences"], "{}");
  const offline = client(storage, async () => { throw Error("offline"); });
  offline.api.save("notification_center_enabled", true);
  await offline.flush();
  assert.equal(JSON.parse(storage["selkies.pendingPreferences:/box/api/preferences"]).notification_center_enabled, true);
  console.log("Preferences: subfolder URL, in-flight edits, reload recovery and offline retry passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
