(() => {
  const health = window.__selkiesStreamHealth;
  const connection = health && health.connection('primary');
  if (!connection || connection.role !== 'controller' || document.hidden) throw Error('Open the primary controller first');
  if (window.stopCodecProbe) throw Error('A probe is already running');
  const previous = health.onFrameRendered, samples = [];
  const snapshot = () => health.diagnostics().displays.find(display => display.displayId === 'primary');
  const start = snapshot(), begin = performance.now();
  let pending = null, expired = 0, coalesced = 0, interrupted = false;
  function input(event) {
    if (!event.isTrusted || document.hidden || event.repeat) return;
    const now = performance.now();
    if (pending !== null && now - pending <= 2000) { coalesced++; return; }
    if (pending !== null) expired++;
    pending = now;
  }
  function render(displayId, frameId) {
    try {
      if (displayId === 'primary' && pending !== null) {
        const elapsed = performance.now() - pending;
        if (elapsed <= 2000 && samples.length < 1024) samples.push(elapsed); else expired++;
        pending = null;
      }
    } finally { if (previous) previous.call(this, displayId, frameId); }
  }
  function hidden() { interrupted = true; pending = null; }
  function lifecycle(event) {
    if (typeof event.data === 'string' && (event.data === 'PIPELINE_RESETTING primary' ||
        event.data === 'VIDEO_STOPPED' || event.data.startsWith('ROLE_UPDATE,'))) hidden();
  }
  function stop() {
    clearTimeout(timer);
    document.removeEventListener('keydown', input, true);
    document.removeEventListener('pointerdown', input, true);
    document.removeEventListener('visibilitychange', hidden);
    connection.socket.removeEventListener('close', hidden);
    connection.socket.removeEventListener('message', lifecycle);
    const intact = health.onFrameRendered === render;
    if (intact) health.onFrameRendered = previous;
    delete window.stopCodecProbe;
    const end = snapshot(), duration = (performance.now() - begin) / 1000;
    samples.sort((left, right) => left - right);
    const percentile = fraction => samples.length ? samples[Math.ceil(samples.length * fraction) - 1] : null;
    const current = health.connection('primary');
    const valid = !!(intact && !interrupted && end?.active && current?.role === 'controller' && current.socket === connection.socket);
    const report = {valid, seconds: duration, input_windows: samples.length, coalesced, expired, pending: pending !== null,
      input_to_next_canvas_draw_mean_ms: samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : null,
      p50_ms: percentile(0.5), p95_ms: percentile(0.95),
      received_fps: valid ? (end.packetsReceived - start.packetsReceived) / duration : null,
      drawn_fps: valid ? (end.framesRendered - start.framesRendered) / duration : null,
      drop_incidents: valid ? end.dropCount - start.dropCount : null, stall_incidents: valid ? end.stallCount - start.stallCount : null};
    console.log(JSON.stringify(report));
    return report;
  }
  document.addEventListener('keydown', input, true);
  document.addEventListener('pointerdown', input, true);
  document.addEventListener('visibilitychange', hidden);
  connection.socket.addEventListener('close', hidden);
  connection.socket.addEventListener('message', lifecycle);
  health.onFrameRendered = render;
  window.stopCodecProbe = stop;
  const timer = setTimeout(stop, 80000);
})();
