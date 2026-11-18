(function () {
  "use strict";

  var MAX_PACKET_BYTES = 16 * 1024 * 1024;
  var MAX_QUEUED_BYTES = 32 * 1024 * 1024;
  var MAX_QUEUED_FRAMES = 48;
  var MAX_OBUS = 4096;
  var PROBE_TIMEOUT_MS = 3000;
  var OUTPUT_TIMEOUT_MS = 8000;
  var support = { supported: false, reason: "probing" };
  var fallingBack = false;
  var prefix = location.href.split("#")[0].replace(/[^a-zA-Z0-9.-_]/g, "_") + "_";
  var suffix = location.hash.startsWith("#display2") ? "_display2" : "";
  var sharedPage = /^#(?:shared|player[234])$/.test(location.hash);
  var activeSession = null;
  var lastSession = null;

  function bytesOf(data) {
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new Uint8Array(data);
  }

  function BitReader(data) {
    this.bytes = data;
    this.position = 0;
  }
  BitReader.prototype.read = function (count) {
    if (count < 0 || count > 32 || this.position + count > this.bytes.length * 8) {
      throw new Error("Truncated AV1 sequence header");
    }
    var value = 0;
    for (var i = 0; i < count; i += 1) {
      value = value * 2 + ((this.bytes[this.position >> 3] >> (7 - (this.position & 7))) & 1);
      this.position += 1;
    }
    return value;
  };
  BitReader.prototype.uvlc = function () {
    var leading = 0;
    while (this.read(1) === 0) {
      leading += 1;
      if (leading === 32) return 0xffffffff;
    }
    return Math.pow(2, leading) - 1 + this.read(leading);
  };

  // WebCodecs AV1 takes one temporal unit in low-overhead OBU format, not IVF
  // or Annex-B. Bound every LEB128 and payload before looking into a header.
  function obus(data) {
    var bytes = bytesOf(data);
    if (!bytes.length || bytes.length > MAX_PACKET_BYTES) throw new Error("Invalid AV1 payload length");
    var result = [];
    var position = 0;
    while (position < bytes.length) {
      if (result.length >= MAX_OBUS) throw new Error("AV1 temporal unit has too many OBUs");
      var header = bytes[position++];
      if (header & 0x81) throw new Error("Invalid AV1 OBU header");
      var type = (header >> 3) & 15;
      if (header & 4) {
        if (position >= bytes.length || (bytes[position] & 7)) throw new Error("Invalid AV1 OBU extension");
        position += 1;
      }
      if (!(header & 2)) throw new Error("AV1 OBU is missing its size");
      var size = 0;
      var complete = false;
      for (var i = 0; i < 8; i += 1) {
        if (position >= bytes.length) throw new Error("Truncated AV1 OBU size");
        var next = bytes[position++];
        size += (next & 127) * Math.pow(128, i);
        if (!Number.isSafeInteger(size) || size > MAX_PACKET_BYTES) throw new Error("AV1 OBU is too large");
        if (!(next & 128)) { complete = true; break; }
      }
      if (!complete || size > bytes.length - position) throw new Error("Truncated AV1 OBU payload");
      result.push({ type: type, data: bytes.subarray(position, position + size) });
      position += size;
    }
    return result;
  }

  function parseSequence(data) {
    var units = obus(data);
    var sequence = null;
    for (var unit of units) {
      if (unit.type === 3 || unit.type === 6) break;
      if (unit.type === 1) { sequence = unit.data; break; }
    }
    if (!sequence || sequence.length > 4096) throw new Error("AV1 keyframe has no sequence header");
    var bits = new BitReader(sequence);
    var profile = bits.read(3);
    if (profile !== 0) throw new Error("AV1 requires Main profile");
    var stillPicture = bits.read(1);
    var reduced = bits.read(1);
    if (reduced && !stillPicture) throw new Error("Invalid AV1 still-picture header");
    var level = 0;
    var tier = 0;
    if (reduced) {
      level = bits.read(5);
    } else {
      var decoderModel = false;
      var bufferDelayBits = 0;
      if (bits.read(1)) {
        bits.read(32);
        bits.read(32);
        if (bits.read(1)) bits.uvlc();
        decoderModel = !!bits.read(1);
        if (decoderModel) {
          bufferDelayBits = bits.read(5) + 1;
          bits.read(32);
          bits.read(5);
          bits.read(5);
        }
      }
      var initialDisplayDelay = bits.read(1);
      var operatingPoints = bits.read(5) + 1;
      for (var point = 0; point < operatingPoints; point += 1) {
        bits.read(12);
        var pointLevel = bits.read(5);
        var pointTier = pointLevel > 7 ? bits.read(1) : 0;
        if (point === 0) { level = pointLevel; tier = pointTier; }
        if (decoderModel && bits.read(1)) {
          bits.read(bufferDelayBits);
          bits.read(bufferDelayBits);
          bits.read(1);
        }
        if (initialDisplayDelay && bits.read(1)) bits.read(4);
      }
    }
    var widthBits = bits.read(4) + 1;
    var heightBits = bits.read(4) + 1;
    var width = bits.read(widthBits) + 1;
    var height = bits.read(heightBits) + 1;
    if (!reduced && bits.read(1)) { bits.read(4); bits.read(3); }
    bits.read(1);
    bits.read(1);
    bits.read(1);
    if (!reduced) {
      bits.read(1);
      bits.read(1);
      bits.read(1);
      bits.read(1);
      var orderHint = bits.read(1);
      if (orderHint) { bits.read(1); bits.read(1); }
      var screenTools = bits.read(1) ? 2 : bits.read(1);
      if (screenTools && !bits.read(1)) bits.read(1);
      if (orderHint) bits.read(3);
    }
    bits.read(1);
    bits.read(1);
    bits.read(1);
    var bitDepth = bits.read(1) ? 10 : 8;
    var monochrome = bits.read(1);
    var primaries = 2;
    var transfer = 2;
    var matrix = 2;
    if (bits.read(1)) {
      primaries = bits.read(8);
      transfer = bits.read(8);
      matrix = bits.read(8);
    }
    var chromaX = 1;
    var chromaY = 1;
    if (monochrome) {
      bits.read(1);
    } else if (primaries === 1 && transfer === 13 && matrix === 0) {
      chromaX = chromaY = 0;
      bits.read(1);
    } else {
      bits.read(1);
      bits.read(2);
      bits.read(1);
    }
    bits.read(1);
    if (bitDepth !== 8 || monochrome || !chromaX || !chromaY) {
      throw new Error("AV1 requires 8-bit 4:2:0 video");
    }
    if (width > 8192 || height > 8192) throw new Error("AV1 sequence dimensions exceed the supported limit");
    if (level > 23 && level !== 31) throw new Error("Invalid AV1 sequence level");
    var firstFrame = units.find(function (item) { return item.type === 3 || item.type === 6; });
    if (firstFrame && !reduced) {
      var frameBits = new BitReader(firstFrame.data);
      if (frameBits.read(1) || frameBits.read(2) !== 0 || !frameBits.read(1)) {
        throw new Error("AV1 keyframe is not a shown KEY_FRAME");
      }
    }
    return {
      codec: "av01.0." + String(level).padStart(2, "0") + (tier ? "H" : "M") + ".08",
      width: width, height: height, profile: profile, level: level, tier: tier,
      bitDepth: bitDepth, reduced: !!reduced, hasKeyframe: !!firstFrame,
      signature: Array.from(sequence).join(",")
    };
  }

  function parsePacket(data) {
    var bytes = bytesOf(data);
    if (bytes.length <= 10 || bytes.length > MAX_PACKET_BYTES + 10) throw new Error("Invalid AV1 video packet length");
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint8(0) !== 6 || view.getUint8(1) > 1) throw new Error("Invalid AV1 video packet header");
    var packet = { key: view.getUint8(1) === 1, frameId: view.getUint16(2), y: view.getUint16(4),
      width: view.getUint16(6), height: view.getUint16(8), data: bytes.subarray(10) };
    return validatePacket(packet);
  }

  function validatePacket(packet) {
    if (typeof packet.key !== "boolean" || !Number.isInteger(packet.frameId) || packet.frameId < 0 || packet.frameId > 65535 ||
        packet.y !== 0 || !Number.isInteger(packet.width) || !Number.isInteger(packet.height) ||
        packet.width < 1 || packet.height < 1 || packet.width > 8192 || packet.height > 8192) {
      throw new Error("Invalid AV1 full-frame geometry");
    }
    if (!(packet.data instanceof Uint8Array) || !packet.data.length || packet.data.length > MAX_PACKET_BYTES) {
      throw new Error("Invalid AV1 payload length");
    }
    return packet;
  }

  function withTimeout(promise, milliseconds, message) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error(message)); }, milliseconds);
      Promise.resolve(promise).then(function (value) { clearTimeout(timer); resolve(value); },
        function (error) { clearTimeout(timer); reject(error); });
    });
  }

  function decoderConfig(sequence) {
    return { codec: sequence.codec, codedWidth: sequence.width, codedHeight: sequence.height,
      optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" };
  }

  function reasonText(reason) {
    var messages = {
      "insecure-context": "当前连接不是安全上下文，浏览器未开放 WebCodecs",
      "webcodecs-unavailable": "当前浏览器内核未提供 WebCodecs 视频解码",
      "codec-unsupported": "当前浏览器未接受 AV1 解码配置",
      "probe-timeout": "AV1 能力检测超时"
    };
    return messages[reason] || String(reason && reason.message || reason || "解码不可用");
  }

  function fallback(reason, shared) {
    if (fallingBack) return;
    fallingBack = true;
    setTimeout(function () { fallingBack = false; }, 2000);
    var detail = reasonText(reason);
    console.warn("AV1 fallback:", detail);
    var viewer = shared === undefined ? sharedPage : shared;
    if (!viewer) {
      try { localStorage.setItem(prefix + "encoder" + suffix, "x264enc"); } catch (_err) {}
      if (window.selkiesPreferences) window.selkiesPreferences.save("encoder" + suffix, "x264enc");
      window.dispatchEvent(new Event("selkies-av1-fallback"));
      window.postMessage({ type: "settings", settings: { encoder: "x264enc",
        displayId: suffix ? "display2" : "primary" } }, location.origin);
    }
    var notice = document.createElement("div");
    notice.setAttribute("role", "status");
    notice.textContent = viewer ? "无法显示共享的 AV1 画面：" + detail + "。请在主控端切换 H.264。" :
      "AV1 暂不可用，已切回 H.264：" + detail + "。其他视频设置已保留。";
    notice.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:20000;background:#253443;color:white;padding:12px 18px;border-radius:10px;max-width:85vw";
    if (document.body) document.body.appendChild(notice);
    setTimeout(function () { notice.remove(); }, 8000);
  }

  // A successful probe is a decoder capability, not proof of hardware use.
  var ready = (async function () {
    if (!window.isSecureContext) { support.reason = "insecure-context"; return; }
    if (!window.VideoDecoder || !window.VideoFrame) { support.reason = "webcodecs-unavailable"; return; }
    try {
      var answer = await withTimeout(VideoDecoder.isConfigSupported(decoderConfig({
        codec: "av01.0.08M.08", width: 1920, height: 1080
      })), PROBE_TIMEOUT_MS, "probe-timeout");
      support.supported = !!answer.supported;
      support.reason = support.supported ? "supported" : "codec-unsupported";
    } catch (error) {
      support.reason = error.message === "probe-timeout" ? "probe-timeout" : "probe-error";
    }
  })();

  function createDecoder(options) {
    options = options || {};
    var decoder = null;
    var sequence = null;
    var dimensions = null;
    var pending = [];
    var pendingBytes = 0;
    var inFlight = new Map();
    var inFlightBytes = 0;
    var generation = 0;
    var nextTimestamp = 0;
    var watchdog = null;
    var closed = false;
    var failed = false;
    var framesDecoded = 0;
    var lastCodec = null;
    var lastOutput = null;

    function clearWatchdog() { clearTimeout(watchdog); watchdog = null; }
    function expectFrame() {
      if (closed || failed || watchdog !== null) return;
      watchdog = setTimeout(function () { fail(new Error("AV1 decoder produced no frame before timeout")); }, OUTPUT_TIMEOUT_MS);
    }
    function dispose() {
      generation += 1;
      clearWatchdog();
      pending = [];
      pendingBytes = 0;
      inFlight.clear();
      inFlightBytes = 0;
      sequence = null;
      dimensions = null;
      if (decoder && decoder.state !== "closed") {
        try { decoder.close(); } catch (_err) {}
      }
      decoder = null;
    }
    function fail(error) {
      if (closed || failed) return;
      failed = true;
      dispose();
      if (options.error) options.error(error);
      else fallback(error, options.shared);
    }
    function output(frame, epoch) {
      if (closed || failed || epoch !== generation) { frame.close(); return; }
      var packet = inFlight.get(frame.timestamp);
      if (!packet) { frame.close(); fail(new Error("AV1 output has no matching input frame")); return; }
      inFlight.delete(frame.timestamp);
      inFlightBytes -= packet.byteLength;
      clearWatchdog();
      if (inFlight.size || pending.length) expectFrame();
      try {
        var visible = frame.visibleRect || { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
        if (visible.width < packet.width || visible.height < packet.height) throw new Error("AV1 decoded frame is smaller than its source geometry");
        // VA-API may pad the coded extent. Keep source pixels and mouse geometry
        // intact instead of stretching the padded picture back to the desktop.
        if (visible.width !== packet.width || visible.height !== packet.height ||
            frame.displayWidth !== packet.width || frame.displayHeight !== packet.height) {
          var cropped = new VideoFrame(frame, { visibleRect: { x: visible.x, y: visible.y,
            width: packet.width, height: packet.height }, displayWidth: packet.width, displayHeight: packet.height });
          frame.close();
          frame = cropped;
        }
        framesDecoded += 1;
        lastOutput = { width: packet.width, height: packet.height };
        if (options.output) options.output(frame, packet);
        else frame.close();
      } catch (error) { frame.close(); fail(error); }
    }
    function decode(packet) {
      var timestamp = ++nextTimestamp;
      // Keep only output geometry after handing the compressed bytes to the
      // decoder, but include its outstanding bytes in the same queue budget.
      inFlight.set(timestamp, { key: packet.key, frameId: packet.frameId, y: packet.y,
        width: packet.width, height: packet.height, byteLength: packet.data.byteLength });
      inFlightBytes += packet.data.byteLength;
      expectFrame();
      decoder.decode(new EncodedVideoChunk({ type: packet.key ? "key" : "delta", timestamp: timestamp, data: packet.data }));
    }
    function configure(parsed, packet) {
      dispose();
      sequence = parsed;
      lastCodec = parsed.codec;
      dimensions = { width: packet.width, height: packet.height };
      var epoch = generation;
      decoder = new VideoDecoder({ output: function (frame) { output(frame, epoch); },
        error: function (error) { if (epoch === generation) fail(error); } });
      var current = decoder;
      expectFrame();
      var config = decoderConfig(parsed);
      withTimeout(VideoDecoder.isConfigSupported(config), PROBE_TIMEOUT_MS, "AV1 decoder configuration timed out")
        .then(function (answer) {
          if (closed || failed || epoch !== generation) return;
          if (!answer.supported) throw new Error("AV1 sequence configuration is unsupported");
          current.configure(config);
          while (pending.length && epoch === generation && !failed) {
            var next = pending.shift();
            pendingBytes -= next.data.byteLength;
            decode(next);
          }
        }).catch(function (error) { if (epoch === generation) fail(error); });
    }
    function push(data) {
      if (closed || failed) return false;
      try {
        if (!support.supported) throw new Error(reasonText(support.reason));
        var packet = data && data.data instanceof Uint8Array ? validatePacket(data) : parsePacket(data);
        if (packet.key) {
          var parsed = parseSequence(packet.data);
          if (!parsed.hasKeyframe) throw new Error("AV1 keyframe has no frame header");
          if (packet.width > parsed.width || packet.height > parsed.height) throw new Error("AV1 packet geometry exceeds its sequence dimensions");
          if (!decoder || decoder.state === "closed" || !sequence || parsed.signature !== sequence.signature ||
              dimensions.width !== packet.width || dimensions.height !== packet.height) configure(parsed, packet);
        } else {
          if (!decoder || !sequence) return false;
          if (dimensions.width !== packet.width || dimensions.height !== packet.height) {
            throw new Error("AV1 dimensions changed without a keyframe");
          }
        }
        if (pending.length + inFlight.size >= MAX_QUEUED_FRAMES || pendingBytes + inFlightBytes + packet.data.byteLength > MAX_QUEUED_BYTES) {
          throw new Error("AV1 decoder queue exceeded its limit");
        }
        if (decoder.state === "configured") decode(packet);
        else { pending.push(packet); pendingBytes += packet.data.byteLength; }
        return true;
      } catch (error) { fail(error); return false; }
    }
    var api = {
      push: push, expectFrame: expectFrame,
      close: function () {
        closed = true;
        dispose();
        if (activeSession === api) { lastSession = api.diagnostics(); activeSession = null; }
      },
      reset: function () { if (!closed) { failed = false; dispose(); } },
      diagnostics: function () { return { state: closed ? "closed" : failed ? "failed" : decoder ? decoder.state : "waiting-keyframe",
        framesDecoded: framesDecoded, queuedFrames: pending.length + inFlight.size, queuedBytes: pendingBytes + inFlightBytes,
        codec: lastCodec, output: lastOutput && Object.assign({}, lastOutput),
        hardwareAcceleration: "prefer-hardware", hardwareVerified: false }; }
    };
    activeSession = api;
    return api;
  }

  window.selkiesAv1 = {
    ready: ready, supported: function () { return support.supported; },
    diagnostics: function () { return { supported: support.supported, reason: support.reason,
      hardwareAcceleration: "prefer-hardware", hardwareVerified: false,
      session: activeSession ? activeSession.diagnostics() : lastSession && Object.assign({}, lastSession) }; },
    parseSequence: parseSequence, parsePacket: parsePacket, config: decoderConfig,
    createDecoder: createDecoder, fallback: fallback
  };
})();
