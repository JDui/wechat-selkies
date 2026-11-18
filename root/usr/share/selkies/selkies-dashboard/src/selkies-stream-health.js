(function () {
  "use strict";

  // Observe application video progress. WebSocket does not expose IP packet loss.
  // Keep only bounded frame metadata, never payloads, URLs or remote user input.
  if (window.__selkiesStreamHealth) return;
  var TICK_MS = 250;
  var GRACE_MS = 3000;
  var STALL_HINT_MS = 500;
  var PULSE_MS = 2400;
  var COUNT_INTERVAL_MS = 1000;
  var MAX_DISPLAYS = 4;
  var MAX_PENDING = 256;
  var REASONS = {
    drop: new Set(["video_queue_overflow", "transport_closed", "invalid_video_packet"]),
    stall: new Set(["ack_timeout", "render_error", "decoder_error", "decoder_timeout",
      "decoder_queue_overflow", "render_timeout", "event_loop_lag"])
  };
  var NORMAL_CLOSE_CODES = new Set([1000, 1001, 4001, 4002, 4003, 4004, 4029]);
  var displays = new Map();
  var registeredSockets = new WeakSet();
  var selectedDisplay = null;
  var suspended = false;
  var timer = null;
  var lastTick = null;
  var lastChange = "";

  function now() {
    return window.performance && typeof window.performance.now === "function" ? window.performance.now() : Date.now();
  }
  function bump(value) { return Math.min(Number.MAX_SAFE_INTEGER, value + 1); }
  function displayState(displayId) {
    return displays.get(displayId === undefined || displayId === null ? selectedDisplay : displayId) || null;
  }
  function socketState(socket) {
    var found = null;
    displays.forEach(function (state) { if (state.socket === socket) found = state; });
    return found;
  }
  function isCurrentSocket(socket) {
    if (socketState(socket)) return true;
    return registeredSockets.has(socket) ? false : null;
  }
  function visible() { return !document.hidden && !suspended; }
  function running(state) { return !!(state && state.opened && state.active && visible()); }
  function clearWork(state, at, quiet) {
    if (state.feedback) state.feedback = feedbackWindow(state.feedback.token);
    state.pending = [];
    state.pendingSince = null;
    state.lastPacketAt = null;
    state.lastRenderAt = null;
    state.lastActivityAt = null;
    state.graceUntil = at + GRACE_MS;
    if (quiet) {
      state.drop.until = 0;
      state.stall.until = 0;
    }
  }
  function pulseState() { return { until: 0, reason: null, at: null, count: 0, countedAt: null, reasons: {} }; }
  function safeCallback(name, args) {
    try { if (typeof api[name] === "function") api[name].apply(api, args || []); } catch (_error) {}
  }
  function waitTime(state, at) {
    if (!running(state) || !state.pending.length || at < state.graceUntil || state.pendingSince === null) return 0;
    return Math.max(0, at - Math.max(state.pendingSince, state.lastRenderAt === null ? 0 : state.lastRenderAt, state.graceUntil));
  }
  function pulse(state, kind, reason, at) {
    var value = state[kind];
    value.until = at + PULSE_MS;
    value.at = at;
    if (value.countedAt === null || at - value.countedAt >= COUNT_INTERVAL_MS) {
      value.count = bump(value.count);
      value.reasons[reason] = bump(value.reasons[reason] || 0);
      value.countedAt = at;
    }
    value.reason = reason;
  }
  function latestPulse(kind, at) {
    var result = { active: false, reason: null, at: null };
    var active = null;
    displays.forEach(function (state) {
      var value = state[kind];
      if (value.at !== null && (result.at === null || value.at > result.at)) {
        result.reason = value.reason;
        result.at = value.at;
      }
      if (visible() && value.until > at && (!active || value.at > active.at)) {
        active = { active: true, reason: value.reason, at: value.at };
      }
    });
    return active || result;
  }
  function connection(displayId) {
    var state = displayState(displayId);
    return state && state.opened ? { socket: state.socket, displayId: state.displayId, role: state.role } : null;
  }
  function diagnostics() {
    var at = now();
    var drop = latestPulse("drop", at), stall = latestPulse("stall", at);
    var current = displayState();
    var records = [];
    displays.forEach(function (state) {
      records.push({ displayId: state.displayId, role: state.role, connected: state.opened, active: state.active,
        pendingFrames: state.pending.length, stalledForMs: waitTime(state, at),
        packetsReceived: state.packetsReceived, framesRendered: state.framesRendered,
        dropCount: state.drop.count, stallCount: state.stall.count,
        dropReasons: Object.assign({}, state.drop.reasons), stallReasons: Object.assign({}, state.stall.reasons),
        lastPacketAt: state.lastPacketAt, lastRenderAt: state.lastRenderAt, graceRemainingMs: Math.max(0, state.graceUntil - at) });
    });
    return { dropActive: drop.active, stallActive: stall.active, dropReason: drop.reason, stallReason: stall.reason,
      displayId: current ? current.displayId : null, role: current ? current.role : "unknown",
      connected: !!(current && current.opened), suspended: suspended, hidden: !!document.hidden,
      stalledForMs: waitTime(current, at), measurement: "application_video_progress", displays: records };
  }
  function changed() {
    var value = diagnostics();
    var signature = [value.dropActive, value.stallActive, value.dropReason, value.stallReason,
      value.displayId, value.role, value.connected, value.suspended, value.hidden].join("|");
    if (signature === lastChange) return;
    lastChange = signature;
    safeCallback("onChange", [value]);
  }
  function connect(socket, displayId) {
    if (!socket || (typeof socket !== "object" && typeof socket !== "function") ||
        typeof displayId !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(displayId)) return false;
    var registered = socketState(socket);
    if (registered && registered.displayId !== displayId) return false;
    var previous = displays.get(displayId);
    if (previous && previous.socket === socket) return true;
    if (!previous && displays.size >= MAX_DISPLAYS) return false;
    var state = { socket: socket, displayId: displayId, role: "unknown", opened: false, active: true,
      packetsReceived: 0, framesRendered: 0,
      drop: previous ? previous.drop : pulseState(), stall: previous ? previous.stall : pulseState() };
    // Keep a recent real incident visible briefly across recovery. Connecting
    // itself never creates a new failure or increments an incident counter.
    clearWork(state, now(), false);
    displays.set(displayId, state);
    registeredSockets.add(socket);
    selectedDisplay = displayId;
    changed();
    return true;
  }
  function opened(socket) {
    var state = socketState(socket);
    if (!state || state.opened) return false;
    state.opened = true;
    clearWork(state, now(), false);
    changed();
    return true;
  }
  function closed(socket, event) {
    var state = socketState(socket);
    if (!state) return false;
    var at = now();
    var unexpected = running(state) && state.packetsReceived > 0 &&
      !(event && NORMAL_CLOSE_CODES.has(event.code));
    state.opened = false;
    state.feedbackControl = null;
    state.feedback = null;
    clearWork(state, at, true);
    if (unexpected) pulse(state, "drop", "transport_closed", at);
    changed();
    return true;
  }
  function pipeline(socket, active) {
    var state = socketState(socket);
    if (!state || typeof active !== "boolean") return false;
    if (state.active === active) return true;
    state.active = active;
    if (!active) state.feedbackControl = null;
    clearWork(state, now(), !active);
    changed();
    return true;
  }
  function reset(socket) {
    var state = socketState(socket);
    if (!state) return false;
    state.feedback = null;
    state.feedbackControl = null;
    clearWork(state, now(), false);
    changed();
    return true;
  }
  function setRole(socket, role) {
    var state = socketState(socket);
    if (!state || !["unknown", "controller", "viewer"].includes(role)) return false;
    state.role = role;
    if (role !== "controller") { state.feedback = null; state.feedbackControl = null; }
    changed();
    return true;
  }
  function report(kind, reason, displayId) {
    var state = displayState(displayId);
    if ((kind !== "drop" && kind !== "stall") || !REASONS[kind].has(reason) || !running(state)) return false;
    pulse(state, kind, reason, now());
    changed();
    return true;
  }
  function serverEvent(socket, payload) {
    var state = socketState(socket);
    if (!state || !payload || typeof payload !== "object" || payload.display_id !== state.displayId) return false;
    return report(payload.kind, payload.reason, state.displayId);
  }
  function packet(socket, payload) {
    var state = socketState(socket);
    if (!running(state) || !(payload instanceof ArrayBuffer) || payload.byteLength < 1) return false;
    var view = new DataView(payload), type = view.getUint8(0);
    if (![0, 3, 4, 5, 6].includes(type)) return false;
    var legacy = type === 0 || type === 3;
    var legacyWithId = state.role === "controller";
    var header = legacy ? (type === 0 ? 2 : 4) + (legacyWithId ? 2 : 0) : 10;
    if (payload.byteLength <= header || ((type === 0 || type === 4 || type === 5 || type === 6) && view.getUint8(1) > 1)) {
      report("drop", "invalid_video_packet", state.displayId);
      return false;
    }
    if (!legacy && (!view.getUint16(6) || !view.getUint16(8))) {
      report("drop", "invalid_video_packet", state.displayId);
      return false;
    }
    var at = now();
    state.lastPacketAt = state.lastActivityAt = at;
    state.packetsReceived = bump(state.packetsReceived);
    var id = !legacy || legacyWithId ? view.getUint16(2) : null;
    if (!state.pending.some(function (item) { return item.id === id; })) {
      if (!state.pending.length) state.pendingSince = at;
      state.pending.push({ id: id, at: at });
      // Trim observation metadata only. This never discards a video packet.
      if (state.pending.length > MAX_PENDING) state.pending.shift();
    }
    return true;
  }
  function frameRendered(displayId, frameId) {
    var state = displayState(displayId);
    if (!running(state) || !state.pending.length) return false;
    var anonymous = frameId === null || frameId === undefined;
    if (!anonymous && (!Number.isInteger(frameId) || frameId < 0 || frameId > 65535)) return false;
    var index = anonymous ? state.pending.length - 1 : state.pending.findIndex(function (item) { return item.id === frameId; });
    if (index < 0) return false;
    var at = now();
    state.pending.splice(0, index + 1);
    state.pendingSince = state.pending.length ? state.pending[0].at : null;
    state.lastRenderAt = state.lastActivityAt = at;
    state.framesRendered = bump(state.framesRendered);
    safeCallback("onFrameRendered", [state.displayId, anonymous ? null : frameId]);
    changed();
    return true;
  }
  function setSuspended(value) {
    var next = !!value;
    if (next === suspended) return;
    suspended = next;
    var at = now();
    displays.forEach(function (state) { clearWork(state, at, true); });
    lastTick = at;
    changed();
  }
  function visibilityChanged() {
    var at = now();
    displays.forEach(function (state) { clearWork(state, at, true); });
    lastTick = at;
    changed();
  }
  function feedbackWindow(token) {
    return { token: token, received: 0, decoded: 0, drawn: 0, rxId: -1, decodedId: -1, drawnId: -1,
      decoder: null, dirty: false, drawMs: -1, inputAt: null, inputMs: -1, draws: 0, arrivals: 0, outputs: 0 };
  }
  function offer(socket, message) {
    var state = socketState(socket), parts = message.split(",");
    if (!state || state.role === "viewer" || parts.length !== 3 || parts[1] !== state.displayId ||
        !/^[a-f0-9]{32}\.\d{1,10}$/.test(parts[2])) return;
    state.feedback = feedbackWindow(parts[2]);
  }
  function modeStatus(socket, message) {
    var state = socketState(socket), parts = message.split(",");
    if (!state || state.role === "viewer" || parts[1] !== state.displayId ||
        !/^[a-f0-9]{32}\.\d{1,10}$/.test(parts[2]) || !["false","observe","true"].includes(parts[3]) ||
        !["0","1"].includes(parts[4])) return;
    if (parts[3] === "false" || (state.feedback && state.feedback.token !== parts[2])) state.feedback = null;
    state.feedbackControl = {token: parts[2], mode: parts[3], adaptive: parts[4] === "1", failed: parts[5] === "restore_failed"};
  }
  function feedbackControl() {
    var state = displayState();
    return state && state.role === "controller" && running(state) ? state.feedbackControl : null;
  }
  function requestMode(mode) {
    var state = displayState(), control = feedbackControl();
    if (!control || state.socket.readyState !== 1 || !["true","false","observe"].includes(mode) ||
        (mode === "true" && !control.adaptive)) return false;
    try { state.socket.send(["SET_QOE_MODE", state.displayId, control.token, mode].join(",")); return true; }
    catch (_error) { return false; }
  }
  function receipt(socket, id, decoder) {
    var state = socketState(socket);
    if (!state || !state.feedback || state.role !== "controller" || !running(state)) return null;
    var flow = state.feedback;
    flow.arrivals = Math.min(255, flow.arrivals + 1);
    flow.rxId = id; flow.dirty = true; flow.decoder = decoder;
    return { state: state, flow: flow, serial: ++flow.received, id: id, at: now() };
  }
  function progress(ticket, stage, decoder) {
    if (!ticket || ticket.state.feedback !== ticket.flow || !running(ticket.state) ||
        displays.get(ticket.state.displayId) !== ticket.state) return;
    var flow = ticket.flow;
    if (ticket.serial <= flow[stage]) return;
    flow[stage] = ticket.serial; flow[stage + "Id"] = ticket.id; flow.dirty = true;
    if (stage === "decoded") { flow.decoder = decoder; flow.outputs = Math.min(255, flow.outputs + 1); }
    if (stage === "drawn") {
      var at = now();
      flow.drawMs = Math.min(60000, Math.round(at - ticket.at));
      flow.draws = Math.min(255, flow.draws + 1);
      if (flow.inputAt !== null && ticket.at >= flow.inputAt) {
        flow.inputMs = at - flow.inputAt <= 2000 ? Math.round(at - flow.inputAt) : -1;
        flow.inputAt = null;
      }
    }
  }
  function inputSent(socket) {
    var state = socketState(socket);
    if (state && state.feedback && state.role === "controller" && running(state)) {
      var at = now();
      if (state.feedback.inputAt === null || at - state.feedback.inputAt > 2000) state.feedback.inputAt = at;
    }
  }
  function flush(state) {
    var flow = state.feedback;
    if (!flow || !flow.dirty || state.role !== "controller" || state.socket.readyState !== 1) return;
    flow.dirty = false;
    if (state.socket.bufferedAmount > 16384) {
      flow.drawMs = flow.inputMs = -1; flow.draws = flow.arrivals = flow.outputs = 0;
      return;
    }
    var depth = flow.decoder && flow.decoder.decodeQueueSize;
    try {
      state.socket.send(["CLIENT_QOE", state.displayId, flow.token, flow.rxId, flow.decodedId, flow.drawnId,
        Math.min(255, flow.received - flow.decoded), Math.min(255, Math.max(0, flow.decoded - flow.drawn)),
        Number.isInteger(depth) ? Math.min(255, depth) : -1, flow.drawMs, flow.inputMs, flow.draws,
        flow.arrivals, flow.outputs].join(","));
    } catch (_error) {}
    flow.drawMs = flow.inputMs = -1; flow.draws = flow.arrivals = flow.outputs = 0;
  }
  function tick() {
    var at = now(), previousTick = lastTick;
    lastTick = at;
    displays.forEach(function (state) {
      if (!running(state)) return;
      if (previousTick === null || at - previousTick <= 1000) flush(state);
      else if (state.feedback) state.feedback = feedbackWindow(state.feedback.token);
      var loopBlocked = previousTick !== null && at - previousTick - TICK_MS > 500 &&
        previousTick >= state.graceUntil && state.lastActivityAt !== null && previousTick - state.lastActivityAt < 3000;
      if (loopBlocked) {
        // A resumed event loop gets a fresh observation window, not an immediate
        // stream restart based on time spent unable to run callbacks. Keep any
        // received work: a long task does not prove that its frames were drawn.
        state.graceUntil = at + GRACE_MS;
        pulse(state, "stall", "event_loop_lag", at);
      } else if (waitTime(state, at) >= STALL_HINT_MS) {
        pulse(state, "stall", "render_timeout", at);
      }
    });
    changed();
  }
  function start() {
    if (timer !== null) return;
    lastTick = now();
    displays.forEach(function (state) { clearWork(state, lastTick, true); });
    document.addEventListener("visibilitychange", visibilityChanged);
    timer = window.setInterval(tick, TICK_MS);
    changed();
  }

  var api = { connect: connect, opened: opened, closed: closed, packet: packet, pipeline: pipeline, reset: reset,
    offer: offer, receipt: receipt, progress: progress, inputSent: inputSent,
    modeStatus: modeStatus, feedbackControl: feedbackControl, requestMode: requestMode,
    serverEvent: serverEvent, frameRendered: frameRendered, report: report,
    stalledFor: function (displayId) { return waitTime(displayState(displayId), now()); },
    diagnostics: diagnostics, connection: connection, isCurrentSocket: isCurrentSocket,
    setRole: setRole, setSuspended: setSuspended, start: start,
    onFrameRendered: null, onChange: null };
  window.__selkiesStreamHealth = api;
})();
