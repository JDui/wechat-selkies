const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname,
  "../root/usr/share/selkies/selkies-dashboard/src/selkies-video-preferences.js"), "utf8");

(async () => {
  class Storage {
    constructor() { this.values = new Map(); }
    getItem(key) { return this.values.get(key) ?? null; }
    setItem(key, value) { this.values.set(String(key), String(value)); }
  }
  const localStorage = new Storage(), sessionStorage = new Storage(), saves = [];
  const preferences = { encoder: "h265enc", framerate: 45, h264_crf: 24, h264_paintover_crf: 16,
    use_paint_over_quality: true, h264_streaming_mode: false, h264_fullcolor: false, use_cpu: false,
    encoder_display2: "av1enc", framerate_display2: 30 };
  const location = { href: "https://example.test/box/?_pin=changed#display2" };
  const prefix = location.href.split("#")[0].replace(/[^a-zA-Z0-9.-_]/g, "_") + "_";
  localStorage.setItem(prefix + "framerate", 30);
  const window = { selkiesPreferences: { load: async () => preferences,
    save: (key, value) => { saves.push([key, value]); preferences[key] = value; } } };
  vm.runInNewContext(source, { Storage, localStorage, window, location, URL,
    document: { currentScript: { src: "https://example.test/box/src/selkies-video-preferences.js" } } });
  await window.selkiesVideoPreferences.ready;
  for (const [key, value] of Object.entries(preferences)) {
    assert.equal(localStorage.getItem(prefix + key), String(value));
    assert.equal(localStorage.getItem("selkies.videoPreferences:/box/:" + key), String(value));
  }
  assert.equal(saves.length, 0, "Hydration must not write stale browser defaults back to the server");
  localStorage.setItem(prefix + "h264_crf", 26);
  localStorage.setItem(prefix + "h264_crf", 26);
  sessionStorage.setItem(prefix + "h264_crf", 40);
  localStorage.setItem(prefix + "framerate_display2", 60);
  localStorage.setItem(prefix + "encoder", "av1enc");
  localStorage.setItem(prefix + "encoder", "av1enc");
  assert.equal(localStorage.getItem("selkies.videoPreferences:/box/:encoder"), "av1enc");
  assert.deepEqual(saves, [["h264_crf", 26], ["framerate_display2", 60], ["encoder", "av1enc"]]);
  window.selkiesVideoPreferences.rememberLive("primary", "frame_feedback_mode", "observe");
  window.selkiesVideoPreferences.rememberLive("display2", "live_paint_mode", "false");
  const bundle = fs.readFileSync(path.join(__dirname,
    "../root/usr/share/selkies/selkies-dashboard/assets/index-CzFxBFXa.js"), "utf8");
  const helper = bundle.split("\n").find(line => line.startsWith("const axiDebounceSettings="));
  let timer, sent;
  const scope = { clearTimeout() {}, setTimeout: fn => { timer = fn; }, receive: patch => { sent = patch; } };
  vm.runInNewContext(helper + "\nthis.send = axiDebounceSettings(receive, 500);", scope);
  scope.send({ framerate: 45 }); scope.send({ h264_crf: 24 }); scope.send({ use_paint_over_quality: true });
  timer();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), { framerate: 45, h264_crf: 24, use_paint_over_quality: true },
    "Rapid changes to different settings must merge instead of discarding all but the last change");
  const av1 = fs.readFileSync(path.join(__dirname,
    "../root/usr/share/selkies/selkies-dashboard/src/selkies-av1.js"), "utf8");
  Object.assign(location, { hash: "#display2", origin: "https://example.test" });
  Object.assign(window, { isSecureContext: false, postMessage() {}, dispatchEvent() {} });
  const document = { body: { appendChild() {} }, createElement: () => ({ setAttribute() {}, style: {}, remove() {} }) };
  vm.runInNewContext(av1, { window, location, document, localStorage,
    console: { warn() {} }, performance: { now: () => 0 }, setTimeout() { return 1; }, clearTimeout() {},
    Event: class Event { constructor(type) { this.type = type; } } });
  await window.selkiesAv1.ready;
  assert.equal(window.selkiesAv1.normalizeEncoder("av1enc", null, false), "x264enc");
  assert.equal(localStorage.getItem(prefix + "encoder_display2"), "x264enc");
  assert.equal(localStorage.getItem("selkies.videoPreferences:/box/:encoder_display2"), "x264enc");
  assert.equal(preferences.encoder_display2, "x264enc");
  assert.equal(localStorage.getItem(prefix + "framerate_display2"), "60", "fallback preserves other video preferences");
  const reloadStorage = new Storage();
  const reloadLocation = { href: "https://example.test/box/?_pin=next-login#display2" };
  const reloadPrefix = reloadLocation.href.split("#")[0].replace(/[^a-zA-Z0-9.-_]/g, "_") + "_";
  const reloadWindow = { selkiesPreferences: { load: async () => preferences, save() { assert.fail("rehydration must not re-save or retry AV1"); } } };
  vm.runInNewContext(source, { Storage, localStorage: reloadStorage, window: reloadWindow, location: reloadLocation, URL,
    document: { currentScript: { src: "https://example.test/box/src/selkies-video-preferences.js" } } });
  await reloadWindow.selkiesVideoPreferences.ready;
  assert.deepEqual({ ...reloadWindow.selkiesVideoPreferences.liveSettings("primary") }, { frame_feedback_mode: "observe" });
  assert.deepEqual({ ...reloadWindow.selkiesVideoPreferences.liveSettings("display2") }, { live_paint_mode: "false" });
  assert.equal(reloadStorage.getItem(reloadPrefix + "encoder_display2"), "x264enc");
  assert.equal(reloadStorage.getItem(reloadPrefix + "framerate_display2"), "60");
  console.log("Video preferences: HEVC/AV1 persistence, persisted fallback across fresh login, secondary display and hydration passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
