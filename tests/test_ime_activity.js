// The capture guard consumes IME events before document activity listeners.
// Exercise that propagation order with the shipped activity bookkeeping and
// a virtual clock; no native IME, HTTP server, or container is simulated here.
const assert = require("assert");
const vm = require("vm");
const { fixture, source, createClock } = require("./helpers/ime_fixture");

function functionSource(name) {
  const start = source.indexOf("  function " + name + "(");
  const end = source.indexOf("\n  function ", start + 1);
  assert(start >= 0 && end > start, name + " must exist");
  return source.slice(start, end);
}

function activityFixture() {
  const clock = createClock(), f = fixture({ clock });
  const reports = [], notifications = [], restored = [];
  const config = { holdMs: 15000 };
  Object.assign(f.context, {
    lastFrontendInteractionAt: -100000,
    lastUiInteractionAt: -100000,
    adaptiveSleepIdleTimer: 1,
    passthroughIdleTimer: null,
    dynamicLatencyApplied: true,
    dynamicLatencyUntil: 0,
    lastDynamicLatencyConfigSignature: "same",
    getDynamicLatencyConfig: () => config,
    getDynamicLatencyConfigSignature: () => "same",
    syncDynamicLatencySettingsToBackend() {},
    reportFrontendInteractionState() { notifications.push(clock.now()); },
    postContainerSleepActivity() { reports.push(clock.now()); },
    scheduleAdaptiveSleepIdleWarning() {},
    restoreDynamicLatency() {
      restored.push(clock.now());
      f.context.dynamicLatencyApplied = false;
    }
  });
  for (const name of ["noteUiInteraction", "noteFrontendInteraction",
    "markDynamicLatencyInteractive", "isFrontendIdleForPassthrough"]) {
    vm.runInContext(functionSource(name), f.context);
  }
  let documentKeydowns = 0;
  f.document.addEventListener("keydown", () => {
    documentKeydowns += 1;
    f.context.noteUiInteraction();
    f.context.noteFrontendInteraction();
    f.context.markDynamicLatencyInteractive("keyboard");
  });
  clock.advance(1000);
  return { ...f, clock, reports, notifications, restored, config,
    documentKeydowns: () => documentKeydowns };
}

const tests = [];
function test(name, run) {
  try { run(); tests.push({ name, status: "PASS" }); }
  catch (error) { tests.push({ name, status: "FAIL", error: error.message }); }
}

test("IME keycode 229 wakes activity before compositionstart", () => {
  const f = activityFixture();
  const event = f.event("keydown", { key: "Process", code: "KeyZ", keyCode: 229 });
  assert(event.stopped && !event.prevented, "candidate handling stays local");
  assert.strictEqual(f.documentKeydowns(), 0, "document capture must be blocked");
  assert.strictEqual(f.context.lastFrontendInteractionAt, f.clock.now());
  assert.strictEqual(f.context.lastUiInteractionAt, f.clock.now());
  assert.strictEqual(f.context.dynamicLatencyApplied, false);
  assert.strictEqual(f.context.dynamicLatencyUntil, f.clock.now() + f.config.holdMs);
  assert.deepStrictEqual(f.reports, [f.clock.now()]);
  assert.deepStrictEqual(f.sent, []);
});

test("composition start, updates, native input and end keep typing active", () => {
  const f = activityFixture();
  const events = [
    () => f.event("compositionstart"),
    () => f.event("compositionupdate", { data: "zhongwen" }),
    () => f.input("zhongwen", { data: "zhongwen", inputType: "insertCompositionText", isComposing: true }),
    () => { f.state.assist.value = "中文"; f.event("compositionend", { data: "中文" }); }
  ];
  for (let i = 0; i < events.length; i++) {
    f.clock.advance(1000);
    f.context.dynamicLatencyApplied = true;
    events[i]();
    assert.strictEqual(f.context.lastFrontendInteractionAt, f.clock.now(), "event " + i);
    assert.strictEqual(f.context.lastUiInteractionAt, f.clock.now(), "event " + i);
    assert.strictEqual(f.context.dynamicLatencyApplied, false, "event " + i);
    assert.strictEqual(f.context.isFrontendIdleForPassthrough(), false);
  }
  assert.strictEqual(f.reports.length, events.length);
  assert.strictEqual(f.notifications.length, events.length);
  assert.deepStrictEqual(f.sent, ["co,end,中文"], "preedit must not become remote text");
  const reportsBeforeCleanup = f.reports.length;
  f.clock.advance(0);
  assert.strictEqual(f.reports.length, reportsBeforeCleanup, "cleanup is not user activity");
});

test("candidate navigation stays active without preedit input events", () => {
  const f = activityFixture();
  f.event("compositionstart");
  for (let i = 0; i < 6; i++) {
    f.clock.advance(4000);
    f.context.dynamicLatencyApplied = true;
    f.event("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, isComposing: false });
    f.event("keyup", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, isComposing: false });
    assert.strictEqual(f.context.lastFrontendInteractionAt, f.clock.now());
    assert.strictEqual(f.context.dynamicLatencyApplied, false);
    assert.strictEqual(f.context.isFrontendIdleForPassthrough(), false);
  }
  assert.strictEqual(f.documentKeydowns(), 0);
  assert.deepStrictEqual(f.sent, []);
  const lastActivity = f.context.lastFrontendInteractionAt;
  const reportCount = f.reports.length;
  f.clock.advance(60000);
  assert.strictEqual(f.context.lastFrontendInteractionAt, lastActivity,
    "an open candidate window without new events must not synthesize activity");
  assert.strictEqual(f.reports.length, reportCount);
  assert(f.context.isFrontendIdleForPassthrough());
});

test("transport retries and delayed flush do not prolong idle deadlines", () => {
  const f = activityFixture();
  f.socket.bufferedAmount = 262144;
  f.input("暂存文字", { data: "暂存文字", inputType: "insertText", isComposing: false });
  const lastActivity = f.context.lastFrontendInteractionAt;
  const throttleUntil = f.context.dynamicLatencyUntil;
  const reportCount = f.reports.length;
  f.clock.advance(60000);
  assert.strictEqual(f.context.lastFrontendInteractionAt, lastActivity);
  assert.strictEqual(f.context.dynamicLatencyUntil, throttleUntil);
  assert.strictEqual(f.reports.length, reportCount);
  f.socket.bufferedAmount = 0;
  f.clock.advance(120);
  assert.deepStrictEqual(f.sent, ["co,end,暂存文字"]);
  assert.strictEqual(f.context.lastFrontendInteractionAt, lastActivity);
  assert.strictEqual(f.reports.length, reportCount);
});

test("guard activity respects temporary stream reconfiguration suppression", () => {
  const f = activityFixture();
  f.context.dynamicLatencySuppressedUntil = f.clock.now() + 10000;
  f.event("compositionstart");
  assert.strictEqual(f.context.lastFrontendInteractionAt, f.clock.now());
  assert.strictEqual(f.reports.length, 1, "sleep activity is independent of stream changes");
  assert.strictEqual(f.context.dynamicLatencyApplied, true);
  assert.deepStrictEqual(f.restored, []);
  f.clock.advance(10001);
  f.event("compositionupdate", { data: "zhong" });
  assert.strictEqual(f.context.dynamicLatencyApplied, false);
});

for (const result of tests) {
  console.log(result.status + " " + result.name + (result.error ? "\n  " + result.error : ""));
}
const failed = tests.filter(result => result.status === "FAIL").length;
console.log("IME_ACTIVITY_SUMMARY " + JSON.stringify({ total: tests.length, passed: tests.length - failed, failed }));
process.exitCode = failed ? 1 : 0;
