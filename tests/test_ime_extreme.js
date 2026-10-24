// Adversarial event traces against the real guard. Each failure remains a
// failure; this suite deliberately does not bless the current implementation.
const assert = require("assert");
const { fixture } = require("./helpers/ime_fixture");
const results = [];
function test(name, run, kind = "event-trace") {
  try {
    run(); results.push({ name, kind, status: "PASS" });
  } catch (error) {
    results.push({ name, kind, status: "FAIL", error: error.message });
  }
}
const delivered = f => f.sent.map(s => s.slice(7)).join("");
const pending = f => f.window.selkiesRecoverPendingInput();
function start(f, preedit = "pinyin") {
  f.event("compositionstart"); f.input(preedit, { isComposing: true, inputType: "insertCompositionText" });
}
function end(f, text, dom = text) {
  f.state.assist.value = dom; f.event("compositionend", { data: text });
}
function final(f, text, isComposing = false) {
  f.input(text, { data: text, inputType: "insertFromComposition", isComposing });
}

for (const dom of ["", "pinyin", "中", "中文"]) {
  test("end snapshots committed word with DOM=" + JSON.stringify(dom), () => {
    const f = fixture(); start(f); end(f, "中文", dom);
    assert.strictEqual(delivered(f), "中文"); f.tick();
    assert.strictEqual(delivered(f), "中文");
  });
}
for (const mode of ["input-before-end", "input-after-end", "late-input", "late-isComposing", "no-final-input"]) {
  test("commit order: " + mode, () => {
    const f = fixture(); start(f);
    if (mode === "input-before-end") final(f, "选词");
    end(f, "选词");
    if (mode.startsWith("late")) f.tick();
    if (mode !== "input-before-end" && mode !== "no-final-input") final(f, "选词", mode === "late-isComposing");
    f.tick(); assert.strictEqual(delivered(f), "选词");
  });
}
test("100 identical compositions without timer turns", () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) { start(f); end(f, "好"); }
  f.tick(); assert.strictEqual(delivered(f), "好".repeat(100));
});
test("cancellation discards stale preedit, next word survives", () => {
  const f = fixture(); start(f, "quxiao"); end(f, "", "quxiao"); f.tick();
  start(f); end(f, "继续"); final(f, "继续");
  assert.strictEqual(delivered(f), "继续");
});
test("missing compositionstart still accepts end snapshot", () => {
  const f = fixture(); f.input("pinyin", { isComposing: true }); end(f, "恢复"); f.tick();
  assert.strictEqual(delivered(f), "恢复");
});
test("legacy end without data uses current value", () => {
  const f = fixture(); start(f); f.state.assist.value = "兼容";
  f.event("compositionend"); f.tick(); assert.strictEqual(delivered(f), "兼容");
});

for (const inputType of ["insertFromPaste", "insertReplacementText", "insertText"]) {
  test("independent same-text insertion after end-only commit: " + inputType, () => {
    const f = fixture(); start(f); end(f, "中文"); f.tick();
    // Context-menu paste / mobile insertion has no physical keydown and is not
    // the missing final composition input. It is a second intentional insert.
    f.input("中文", { data: inputType === "insertFromPaste" ? null : "中文", inputType });
    assert.strictEqual(delivered(f), "中文中文");
  });
}
test("independent different-text context-menu paste survives", () => {
  const f = fixture(); start(f); end(f, "第一词"); f.tick();
  f.input("另一段", { data: null, inputType: "insertFromPaste" });
  assert.strictEqual(delivered(f), "第一词另一段");
});
test("input appended before cleanup sends suffix only", () => {
  const f = fixture(); start(f); end(f, "中文");
  f.input("中文后缀", { data: "后缀", inputType: "insertText" });
  assert.strictEqual(delivered(f), "中文后缀");
});
test("remounted assist does not inherit old same-text duplicate marker", () => {
  const f = fixture(); start(f); end(f, "同文"); f.tick();
  f.state.assist = { id: "keyboard-input-assist", value: "" };
  f.input("同文", { data: null, inputType: "insertFromPaste" });
  assert.strictEqual(delivered(f), "同文同文");
});
test("remount before cleanup does not strip the new element's matching prefix", () => {
  const f = fixture(); start(f); end(f, "同文");
  f.state.assist = { id: "keyboard-input-assist", value: "" };
  f.input("同文新内容", { data: null, inputType: "insertFromPaste" });
  assert.strictEqual(delivered(f), "同文同文新内容");
});
test("interrupted composition: blur without end then plain input", () => {
  const f = fixture(); start(f, "unfinished");
  // Fault injection: compositionend was lost during focus/window teardown.
  // Preedit must not leak, but a later non-composing insert must recover.
  f.event("blur", { target: f.window }); f.event("focus", { target: f.window });
  assert.strictEqual(f.state.assist.value, "", "unfinished pinyin must not prefix the next input");
  f.input("恢复", { data: "恢复", inputType: "insertText", isComposing: false });
  assert.strictEqual(delivered(f), "恢复");
}, "lost-event-recovery");
test("interrupted composition: remount without end then plain input", () => {
  const f = fixture(); start(f, "unfinished");
  f.state.assist = { id: "keyboard-input-assist", value: "" };
  f.input("新框", { data: "新框", inputType: "insertText", isComposing: false });
  assert.strictEqual(delivered(f), "新框");
}, "lost-event-recovery");

for (const key of ["Enter", "Backspace", " ", "ArrowDown", "Escape"]) {
  test("candidate key keeps local default: " + JSON.stringify(key), () => {
    const f = fixture(); start(f);
    const e = f.event("keydown", { key, code: key, keyCode: key === "Enter" ? 13 : 229 });
    assert(e.stopped && !e.prevented); end(f, "选词");
    assert(f.event("keyup", { key, code: key }).stopped);
    assert.strictEqual(delivered(f), "选词");
  });
}
test("ordinary form does not join remote input", () => {
  const f = fixture(), target = { id: "settings", value: "本地" };
  for (const type of ["compositionstart", "compositionend", "keydown", "input"]) {
    const e = f.event(type, { target, data: "本地", key: "a" }); assert(!e.stopped);
  }
  assert.strictEqual(delivered(f), "");
});
for (const boundary of [262143, 262144, 262145]) {
  test("buffer threshold=" + boundary, () => {
    const f = fixture(); f.socket.bufferedAmount = boundary; f.input("队列");
    assert.strictEqual(delivered(f), boundary < 262144 ? "队列" : "");
    assert.strictEqual(delivered(f) + pending(f), "队列");
    f.socket.bufferedAmount = 0; f.tick(); assert.strictEqual(delivered(f), "队列");
  });
}
test("buffer fills after first chunk and resumes once", () => {
  const f = fixture(), text = "😀𠮷中".repeat(180);
  f.socket.send = data => { f.sent.push(data); f.socket.bufferedAmount = 262144; };
  f.input(text); assert.strictEqual(f.sent.length, 1);
  for (let i = 0; i < 10 && pending(f); i++) { f.socket.bufferedAmount = 0; f.tick(); }
  assert.strictEqual(delivered(f), text); assert.strictEqual(pending(f), "");
});
for (const failAt of [1, 2, 4]) {
  test("synchronous send failure on chunk " + failAt, () => {
    const f = fixture(), text = "中文😀".repeat(250); let calls = 0;
    f.socket.send = data => { if (++calls === failAt) throw Error("queue full"); f.sent.push(data); };
    f.input(text); assert.strictEqual(delivered(f) + pending(f), text);
    f.tick(); assert.strictEqual(delivered(f), text); assert.strictEqual(pending(f), "");
  });
}
test("100 failed retries keep exact text and one retry timer", () => {
  const f = fixture(); f.socket.send = () => { throw Error("busy"); }; f.input("不能丢");
  for (let i = 0; i < 100; i++) { f.tick(); assert.strictEqual(f.timerCount(), 1); }
  assert.strictEqual(pending(f), "不能丢"); assert.strictEqual(f.warnings.length, 1);
  assert(!JSON.stringify(f.warnings).includes("不能丢"));
  f.socket.send = text => f.sent.push(text); f.tick();
  assert.strictEqual(delivered(f), "不能丢"); assert.strictEqual(f.timerCount(), 0);
});
test("no connection accepts multiple local commits in order when first connection opens", () => {
  const f = fixture(); f.state.socket = null;
  for (const text of ["一", "二", "三"]) { start(f); end(f, text); final(f, text); }
  assert.strictEqual(pending(f), "一二三"); f.state.socket = f.socket; f.tick();
  assert.strictEqual(delivered(f), "一二三");
});
test("replacement connection holds unsent remainder rather than replaying", () => {
  const f = fixture(), text = "词".repeat(300);
  f.socket.send = data => { f.sent.push(data); f.socket.bufferedAmount = 262144; };
  f.input(text); const accepted = delivered(f), retained = pending(f), otherSent = [];
  f.state.socket = { readyState: 1, bufferedAmount: 0, send: text => otherSent.push(text) };
  f.tick(); assert.deepStrictEqual(otherSent, []);
  assert.strictEqual(accepted + retained, text); assert.strictEqual(pending(f), retained);
});
test("combining marks, variation selectors, RTL, ZWJ and newlines survive chunk boundaries", () => {
  const f = fixture(), text = "a\u0301👩‍👩‍👧‍👦✈️中文𠮷عربي\n\t,".repeat(120);
  start(f); end(f, text); final(f, text);
  assert.strictEqual(delivered(f), text);
  assert(f.sent.every(s => Array.from(s.slice(7)).length <= 128));
});

// Bounded reproducible generated traces. Each iteration's authoritative commit
// is independent of the transport; the oracle never reads production state.
for (const seed of [1, 7, 42, 257]) {
  test("generated 250-commit trace seed=" + seed, () => {
    const f = fixture(); let randomState = seed >>> 0, expected = "";
    const random = n => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState % n; };
    const words = ["好", "连续选词", "😀𠮷", "a\u0301", "，。", "长句".repeat(70)];
    for (let i = 0; i < 250; i++) {
      const word = words[random(words.length)], cancelled = random(9) === 0, mode = random(5);
      f.socket.bufferedAmount = random(4) === 0 ? 262144 : 0;
      start(f, "preedit-" + i);
      if (mode === 0) final(f, cancelled ? "" : word);
      end(f, cancelled ? "" : word, random(2) ? word : "");
      if (!cancelled) expected += word;
      if (mode === 1) final(f, cancelled ? "" : word);
      if (mode === 2 || mode === 3) { f.tick(); final(f, cancelled ? "" : word, mode === 3); }
      assert.strictEqual(delivered(f) + pending(f), expected, "commit=" + i + " mode=" + mode);
      if (random(3) === 0) f.tick();
    }
    f.socket.bufferedAmount = 0; f.tick();
    assert.strictEqual(delivered(f), expected); assert.strictEqual(pending(f), "");
  }, "generated-trace");
}

const failures = results.filter(r => r.status === "FAIL");
for (const r of results) console.log(`${r.status} [${r.kind}] ${r.name}${r.error ? "\n  " + r.error.replace(/\n/g, "\n  ") : ""}`);
console.log("IME_EXTREME_SUMMARY " + JSON.stringify({ total: results.length,
  passed: results.length - failures.length, failed: failures.length, generatedCommits: 1000 }));
process.exitCode = failures.length ? 1 : 0;
