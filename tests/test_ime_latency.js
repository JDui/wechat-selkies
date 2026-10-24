// Virtual time models separate transport delay, ordered server work and client
// event-loop stalls. This is not a measurement of real RTT or CPU utilization.
const assert = require("assert");
const { fixture, createClock } = require("./helpers/ime_fixture");
const results = [];
function test(name, fn) {
  try { const metrics = fn(); results.push({ name, status: "PASS", ...metrics }); }
  catch (e) { results.push({ name, status: "FAIL", error: e.message }); }
}

function link({ rtt, jitter, cpuDelay, backlogMs = 0 }) {
  const clock = createClock(), f = fixture({ clock });
  const submissions = [], applied = [], work = [];
  let active = false, text = "", sentCount = 0, lastArrival = 0;
  function processNext() {
    if (active || !work.length) return;
    active = true; const msg = work.shift();
    clock.setTimeout(() => {
      applied.push(msg);
      if (msg.startsWith("co,end,")) text += msg.slice(7);
      if (msg.startsWith("kd,")) {
        const key = Number(msg.slice(3));
        if (key === 65293) { submissions.push(text); text = ""; }
        else if (key >= 32 && key < 127) text += String.fromCodePoint(key);
      }
      active = false; processNext();
    }, cpuDelay + (msg.startsWith("co,end,") ? Array.from(msg.slice(7)).length * 12 : 0));
  }
  function nativeSend(msg) {
    assert.strictEqual(f.socket.readyState, 1);
    const bytes = Buffer.byteLength(msg); f.socket.bufferedAmount += bytes;
    // TCP preserves message order even when jitter would otherwise invert it.
    const arrival = Math.max(lastArrival + 1, clock.now() + rtt / 2 + ((sentCount++ % 3) * jitter));
    lastArrival = arrival;
    clock.setTimeout(() => { f.socket.bufferedAmount -= bytes; work.push(msg); processNext(); }, arrival - clock.now());
  }
  f.socket.send = msg => {
    // Same interception hook used by the production WebSocket wrapper.
    if (typeof f.context.queueAssistKeyCommand === "function" && f.context.queueAssistKeyCommand(f.socket, msg)) return;
    nativeSend(msg);
  };
  if (backlogMs) {
    f.socket.bufferedAmount += 262144;
    clock.setTimeout(() => { f.socket.bufferedAmount -= 262144; }, backlogMs);
  }
  // Minimal downstream keyboard receiver, after the capture guard. A physical
  // event stopped by the guard does not reach this receiver.
  f.window.addEventListener("keydown", e => {
    const keysym = e.key === "Enter" ? 65293 : e.key.codePointAt(0);
    f.socket.send("kd," + keysym); e.preventDefault();
  });
  f.window.addEventListener("keyup", e => {
    const keysym = e.key === "Enter" ? 65293 : e.key.codePointAt(0);
    f.socket.send("ku," + keysym);
  });
  const commit = word => {
    f.event("compositionstart"); f.input("preedit", { isComposing: true });
    f.state.assist.value = word; f.event("compositionend", { data: word });
    f.input(word, { data: word, inputType: "insertFromComposition", isComposing: false });
  };
  const key = key => { f.event("keydown", { key, code: key }); f.event("keyup", { key, code: key }); };
  return { clock, f, commit, key, submissions, applied, getText: () => text };
}

for (const scenario of [
  { rtt: 0, jitter: 0, cpuDelay: 0, backlogMs: 0 },
  { rtt: 500, jitter: 80, cpuDelay: 100, backlogMs: 0 },
  { rtt: 2000, jitter: 300, cpuDelay: 500, backlogMs: 5000 },
  { rtt: 10000, jitter: 1500, cpuDelay: 2000, backlogMs: 20000 }
]) {
  test(`RTT ${scenario.rtt}ms / server delay ${scenario.cpuDelay}ms / backlog ${scenario.backlogMs}ms`, () => {
    const l = link(scenario), words = ["连续选词", "😀𠮷", "最后一词"];
    for (const word of words) l.commit(word);
    l.key("a"); l.key("Enter"); l.commit("下一句"); l.key("Enter");
    l.clock.advance(180000);
    assert.deepStrictEqual(l.submissions, [words.join("") + "a", "下一句"]);
    assert.strictEqual(l.getText(), "");
    assert.strictEqual(l.f.window.selkiesRecoverPendingInput(), "");
    assert.strictEqual(l.f.timerCount(), 0);
    return { simulatedMs: l.clock.now(), messages: l.applied.length };
  });
}
test("client stalls 15s across consecutive end events and cleanup timers", () => {
  const l = link({ rtt: 2000, jitter: 200, cpuDelay: 1000, backlogMs: 10000 });
  for (let i = 0; i < 20; i++) l.commit("词" + i + "😀");
  l.clock.stall(15000); // expired timers are only run once the client resumes.
  l.commit("恢复"); l.key("Enter"); l.clock.advance(180000);
  assert.deepStrictEqual(l.submissions, [Array.from({ length: 20 }, (_, i) => "词" + i + "😀").join("") + "恢复"]);
  assert.strictEqual(l.f.timerCount(), 0);
});
test("backlog drains between keydown and keyup without dropping or duplicating either", () => {
  const l = link({ rtt: 500, jitter: 50, cpuDelay: 300, backlogMs: 1000 });
  l.commit("前文"); l.f.event("keydown", { key: "a", code: "KeyA" });
  l.clock.advance(1200); l.f.event("keyup", { key: "a", code: "KeyA" }); l.key("Enter");
  l.clock.advance(30000);
  assert.deepStrictEqual(l.submissions, ["前文a"]);
  assert.strictEqual(l.applied.filter(x => x === "kd,97").length, 1);
  assert.strictEqual(l.applied.filter(x => x === "ku,97").length, 1);
});
test("modifier key press/release stays paired after queued text", () => {
  const l = link({ rtt: 2000, jitter: 300, cpuDelay: 200, backlogMs: 5000 });
  l.commit("先输入文字");
  const chord = ["kd,65507", "kd,99", "ku,99", "ku,65507", "kr"];
  chord.forEach(msg => l.f.socket.send(msg));
  l.clock.advance(60000);
  assert.deepStrictEqual(l.applied, ["co,end,先输入文字", ...chord]);
  assert.strictEqual(l.f.timerCount(), 0);
});

for (const r of results) console.log(r.status + " " + r.name + (r.error ? "\n" + r.error : ""));
console.log("IME_LATENCY_SUMMARY " + JSON.stringify({ total: results.length,
  passed: results.filter(r => r.status === "PASS").length,
  failed: results.filter(r => r.status === "FAIL").length }));
process.exitCode = results.some(r => r.status === "FAIL") ? 1 : 0;
