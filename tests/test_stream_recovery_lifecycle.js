const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const runtime = fs.readFileSync(path.join(__dirname,
  "../root/usr/share/selkies/selkies-dashboard/src/selkies-runtime-overrides.js"), "utf8");
function shipped(name) {
  const start = runtime.indexOf("  function " + name + "(");
  assert(start >= 0, name);
  const tail = runtime.slice(start + 2), end = tail.search(/\n  (?:async )?function /);
  assert(end > 0, name + " end");
  return tail.slice(0, end);
}

function fixture() {
  let at = 1000000, serial = 0;
  const timers = new Map(), history = new Map(), sent = [], finished = [], diagnostics = [];
  const noop = () => {};
  let connection = { socket: {}, displayId: "primary", role: "controller" };
  const document = { hidden: false };
  const window = {
    __selkiesStreamHealth: { connection: () => connection },
    setTimeout(callback, delay) {
      const id = ++serial, timer = { callback, at: at + delay };
      timers.set(id, timer); history.set(id, timer); return id;
    },
    clearTimeout(id) { timers.delete(id); },
    location: { reload() { scope.reloads++; } }
  };
  const scope = vm.createContext({ window, document, console, Date: { now: () => at },
    pendingFullResetTimer: null, PAGE_STALL_COOLDOWN_MS: 300000, FULL_RESET_GRACE_MS: 9000,
    STREAM_REBUILD_MAX_MS: 24000, softRecoverAttempts: 2, streamRecoveryStage: 0,
    streamRecoveryStartedAt: at - 50000, lastFrameProgressAt: at - 100000,
    lastVideoPipelineActive: true, streamRestartGeneration: 0, streamRestartTimer: null,
    streamRestartVerifyTimer: null, streamRecoveryInFlight: false, pipelineResetNoticeTimer: null,
    waitingSinceMs: 0, imeCompositionActive: false, dynamicLatencyApplied: false,
    autoRebuildTimerIds: [], reloads: 0, transportBusy: false, likelyStalled: true,
    getLastPageStallReloadAt: () => 0, markPageStallReloadAt: noop,
    setStoredValue: noop, setActivityTask: noop,
    isTransportBusy: () => scope.transportBusy,
    isStreamLikelyStalled: () => scope.likelyStalled,
    recordUploadDiagnostic: (name, detail) => diagnostics.push({ name, detail }),
    flushUploadDiagnostics: noop,
    finishStreamRecoveryActivity: (detail, kind) => finished.push({ detail, kind }),
    noteUiInteraction: noop, clearAllHighLoadState: noop, restoreDynamicLatency: noop,
    clearEncoderResetTimers: noop, clearStreamRecoveryNoticeTimer: noop,
    suppressDynamicLatency: noop, sendDynamicLatencyState: noop,
    sendRawDataCommand: message => sent.push(message), armStreamRebuildWatchdog: noop,
    resetClientClipboardRuntime: noop, scheduleKeyboardAssistFocus: noop
  });
  for (const name of ["clearAutoRebuildTimers", "cancelPendingFullReset",
    "scheduleGuardedFullReset", "restartStreamingPipelines"]) vm.runInContext(shipped(name), scope);
  function advance(ms) {
    const end = at + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      at = next[1].at; timers.delete(next[0]); next[1].callback();
    }
    at = end;
  }
  return { scope, window, document, sent, finished, diagnostics, history, advance,
    replaceConnection(value = { socket: {}, displayId: "primary", role: "controller" }) { connection = value; } };
}

// The manual repair path must wait for a new presented frame, not VIDEO_STARTED.
const pending = fixture();
pending.scope.restartStreamingPipelines("test", { allowReload: false });
pending.advance(900);
assert.equal(pending.finished.length, 0, "active capture alone does not prove a recovered picture");
assert.equal(pending.sent.filter(value => value === "FORCE_STREAM_RECOVER,primary").length, 2);
pending.advance(2600);
assert.equal(pending.finished.length, 0);
pending.advance(2860);
assert.equal(pending.finished.at(-1).kind, "warning", "no presentation keeps the result uncertain");

const rendered = fixture();
rendered.scope.restartStreamingPipelines("test", { allowReload: false });
rendered.advance(300);
rendered.scope.lastFrameProgressAt = rendered.scope.Date.now();
rendered.advance(600);
assert.equal(rendered.finished.at(-1).kind, "success");
assert.equal(rendered.sent.filter(value => value === "FORCE_STREAM_RECOVER,primary").length, 1);

const resetAfterFrame = fixture();
resetAfterFrame.scope.restartStreamingPipelines("test", { allowReload: false });
resetAfterFrame.advance(300);
resetAfterFrame.scope.lastFrameProgressAt = resetAfterFrame.scope.Date.now();
resetAfterFrame.advance(300);
resetAfterFrame.scope.streamRecoveryStartedAt = resetAfterFrame.scope.Date.now();
resetAfterFrame.advance(300);
assert.equal(resetAfterFrame.finished.length, 0, "a picture before the latest reset is not recovery of the new pipeline");

// Hiding the tab cannot discard the START paired with an already sent manual
// STOP. Automatic page reloads remain separately restricted to visible pages.
const hiddenRepair = fixture();
hiddenRepair.scope.restartStreamingPipelines("test", { allowReload: false });
hiddenRepair.advance(3500); hiddenRepair.document.hidden = true;
hiddenRepair.advance(300); hiddenRepair.document.hidden = false;
hiddenRepair.advance(200);
assert(hiddenRepair.sent.includes("START_VIDEO"));
assert(hiddenRepair.sent.includes("START_AUDIO"));

// Recovery callbacks from an old connection must never reset a replacement.
const replaced = fixture();
replaced.scope.restartStreamingPipelines("test", { allowReload: true });
const beforeReplacement = replaced.sent.length;
replaced.replaceConnection(); replaced.advance(20000);
assert.equal(replaced.sent.length, beforeReplacement);
assert.equal(replaced.scope.reloads, 0);

// A second manual repair invalidates even nested timers from the first attempt.
const superseded = fixture();
superseded.scope.restartStreamingPipelines("first", { allowReload: false });
superseded.advance(3500);
superseded.scope.restartStreamingPipelines("second", { allowReload: false });
const atSecondStart = superseded.sent.length;
superseded.advance(260);
assert.equal(superseded.sent.length, atSecondStart, "the old nested START_VIDEO is retired");

// A scheduled last-resort reload is bound to the original visible video session.
for (const change of ["hidden", "busy", "replacement", "closed", "paused", "new-recovery"]) {
  const test = fixture();
  assert(test.scope.scheduleGuardedFullReset("test", 100000));
  if (change === "hidden") test.document.hidden = true;
  if (change === "busy") test.scope.transportBusy = true;
  if (change === "replacement") test.replaceConnection();
  if (change === "closed") test.replaceConnection(null);
  if (change === "paused") test.scope.lastVideoPipelineActive = false;
  if (change === "new-recovery") test.scope.streamRecoveryStartedAt++;
  test.advance(9000);
  assert.equal(test.scope.reloads, 0, change + " invalidates the old page reset");
  assert(test.diagnostics.some(item => item.detail.cause === "recovery-context-changed"));
  if (change === "new-recovery") assert.equal(test.finished.length, 0, "an old reset cannot finish the new attempt");
}

const healthy = fixture();
assert(healthy.scope.scheduleGuardedFullReset("test", 100000));
healthy.advance(8000); healthy.scope.lastFrameProgressAt = healthy.scope.Date.now();
healthy.scope.likelyStalled = false; healthy.advance(1000);
assert.equal(healthy.scope.reloads, 0);
assert.equal(healthy.finished.at(-1).kind, "success");

const unrecovered = fixture();
assert(unrecovered.scope.scheduleGuardedFullReset("test", 100000));
unrecovered.advance(9000);
assert.equal(unrecovered.scope.reloads, 1, "a still-current stalled session retains the last-resort reset");

const retiredTimer = fixture();
assert(retiredTimer.scope.scheduleGuardedFullReset("first", 100000));
const oldCallback = retiredTimer.history.get(retiredTimer.scope.pendingFullResetTimer).callback;
retiredTimer.scope.cancelPendingFullReset();
assert(retiredTimer.scope.scheduleGuardedFullReset("second", 100000));
const newTimer = retiredTimer.scope.pendingFullResetTimer;
oldCallback();
assert.equal(retiredTimer.scope.pendingFullResetTimer, newTimer);
assert.equal(retiredTimer.scope.reloads, 0, "a cancelled callback cannot run against a newer timer");

console.log("Stream recovery lifecycle: actual presentation, stale repairs, session-bound reloads and cancellation passed.");
