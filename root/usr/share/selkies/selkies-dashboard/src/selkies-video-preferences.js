(function () {
  "use strict";
  // Hydrate before the module bundle reads its React/transport initial state.
  var names = ["encoder", "framerate", "h264_crf", "h264_paintover_crf",
    "use_paint_over_quality", "h264_streaming_mode", "h264_fullcolor", "use_cpu"];
  var prefix = location.href.split("#")[0].replace(/[^a-zA-Z0-9.-_]/g, "_") + "_";
  var base = new URL("../", document.currentScript.src).pathname;
  var keys = names.concat(names.map(function (name) { return name + "_display2"; }));
  var nativeSet = Storage.prototype.setItem;
  var ready = false;
  function cacheKey(name) { return "selkies.videoPreferences:" + base + ":" + name; }
  function write(name, value) {
    nativeSet.call(localStorage, cacheKey(name), String(value));
    nativeSet.call(localStorage, prefix + name, String(value));
  }
  // An origin/path-stable cache also works offline and after changing query args.
  keys.forEach(function (name) {
    var cached = localStorage.getItem(cacheKey(name));
    if (cached !== null) write(name, cached);
  });
  Storage.prototype.setItem = function (key, value) {
    var name = String(key).startsWith(prefix) ? String(key).slice(prefix.length) : "";
    var previous = this === localStorage ? this.getItem(key) : null;
    var result = nativeSet.call(this, key, value);
    if (this === localStorage && keys.includes(name)) {
      nativeSet.call(this, cacheKey(name), String(value));
      if (ready && previous !== String(value) && window.selkiesPreferences) {
        window.selkiesPreferences.save(name, value);
      }
    }
    return result;
  };
  window.selkiesVideoPreferences = {
    ready: (async function () {
      try {
        var preferences = await window.selkiesPreferences.load();
        keys.forEach(function (name) {
          if (Object.prototype.hasOwnProperty.call(preferences, name)) write(name, preferences[name]);
          else {
            var value = localStorage.getItem(prefix + name);
            if (value !== null) window.selkiesPreferences.save(name, value);
          }
        });
      } catch (_err) { /* Keep the local cache; pending writes retry separately. */ }
      finally { ready = true; }
    })()
  };
})();
