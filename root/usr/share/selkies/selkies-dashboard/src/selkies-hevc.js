(function () {
  "use strict";
  var supported = false;
  var fallingBack = false;
  var prefix = location.href.split("#")[0].replace(/[^a-zA-Z0-9.-_]/g, "_") + "_";
  var suffix = location.hash.startsWith("#display2") ? "_display2" : "";
  var shared = /^#(?:shared|player[234])$/.test(location.hash);
  function codecFromAnnexB(data) {
    var bytes = new Uint8Array(data);
    for (var i = 0; i + 4 < bytes.length; i++) {
      if (bytes[i] || bytes[i + 1]) continue;
      var nal = bytes[i + 2] === 1 ? i + 3 : bytes[i + 2] === 0 && bytes[i + 3] === 1 ? i + 4 : -1;
      if (nal < 0 || ((bytes[nal] >> 1) & 63) !== 33) continue;
      var rbsp = [];
      for (var j = nal + 2; j < bytes.length && rbsp.length < 13; j++) {
        if (j >= nal + 4 && bytes[j] === 3 && bytes[j - 1] === 0 && bytes[j - 2] === 0) continue;
        rbsp.push(bytes[j]);
      }
      if (rbsp.length < 13) throw new Error("Truncated HEVC SPS");
      var compatibility = 0;
      for (var bit = 0; bit < 32; bit++) {
        if (rbsp[2 + (bit >> 3)] & (1 << (7 - (bit & 7)))) compatibility += Math.pow(2, bit);
      }
      var constraints = rbsp.slice(6, 12);
      while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
      return "hev1." + ["", "A", "B", "C"][rbsp[1] >> 6] + (rbsp[1] & 31) + "." +
        compatibility.toString(16).toUpperCase() + "." + ((rbsp[1] & 32) ? "H" : "L") + rbsp[12] +
        (constraints.length ? "." + constraints.map(function (n) { return n.toString(16).toUpperCase(); }).join(".") : "");
    }
    throw new Error("HEVC keyframe has no SPS");
  }
  function config(width, height, data) {
    var codec = "hev1.1.6.L120.B0";
    if (data) codec = codecFromAnnexB(data);
    return { codec: codec, codedWidth: width, codedHeight: height,
      optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" };
  }
  function fallback(reason) {
    if (fallingBack) return;
    fallingBack = true;
    setTimeout(function () { fallingBack = false; }, 2000);
    console.warn("H.265 fallback:", reason);
    if (shared) {
      showNotice("此浏览器无法解码共享的 H.265 画面，请在主控端切换 H.264。");
      return;
    }
    // Persist only the codec change. Never reset FPS/quality/resolution on a
    // codec refusal, and retain pending saves during a network outage.
    try { localStorage.setItem(prefix + "encoder" + suffix, "x264enc"); } catch (_err) {}
    if (window.selkiesPreferences) window.selkiesPreferences.save("encoder" + suffix, "x264enc");
    window.dispatchEvent(new Event("selkies-hevc-fallback"));
    window.postMessage({ type: "settings", settings: { encoder: "x264enc",
      displayId: suffix ? "display2" : "primary" } }, location.origin);
    showNotice();
  }
  var ready = (async function () {
    if (!window.isSecureContext || !window.VideoDecoder) return;
    var timer;
    try {
      var answer = await Promise.race([
        VideoDecoder.isConfigSupported(config(1920, 1080)),
        new Promise(function (_resolve, reject) {
          timer = setTimeout(function () { reject(new Error("HEVC capability probe timed out")); }, 3000);
        })
      ]);
      supported = !!answer.supported;
    }
    catch (_err) { supported = false; }
    finally { clearTimeout(timer); }
  })();
  window.selkiesHevc = { ready: ready, config: config, fallback: fallback,
    supported: function () { return supported; } };
  function showNotice(message) {
    var notice = document.createElement("div");
    notice.setAttribute("role", "status");
    notice.textContent = message || "H.265 暂不可用，已切回 H.264；其他视频设置已保留。";
    notice.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:20000;background:#253443;color:white;padding:12px 18px;border-radius:10px;max-width:85vw";
    document.body.appendChild(notice);
    setTimeout(function () { notice.remove(); }, 8000);
  }
})();
