// Exercise the shipped assist guard with a split IME commit. This models
// browser event order only; it does not capture a native IME session.
const assert = require("assert");
const { fixture, createClock } = require("./helpers/ime_fixture");

const failures = [];
let passed = 0;

function check(name, run) {
  try {
    run();
    passed += 1;
    console.log("PASS " + name);
  } catch (error) {
    failures.push({ name, message: error.message });
    console.error("FAIL " + name + ": " + error.message);
  }
}

function delivered(f) {
  return f.sent.map(packet => packet.startsWith("co,end,") ? packet.slice(7) : packet);
}

function replaySplitCommit(inputType) {
  const f = fixture();
  const prefix = "你";
  const remainder = "好，今天的会议改到下午三点。";
  const fullText = prefix + remainder;

  f.event("compositionstart");
  f.input("nihao，今天的会议改到下午三点", {
    isComposing: true, inputType: "insertCompositionText", data: "nihao，今天的会议改到下午三点"
  });

  // Hypothesis under test: the IME confirms a prefix before compositionend,
  // then reports only the remaining text as compositionend.data.
  f.input(prefix, { isComposing: false, inputType, data: prefix });
  f.state.assist.value = fullText;
  f.event("compositionend", { data: remainder });

  // Some event paths deliver one more input as an acknowledgement of the end
  // data. It must not duplicate the remainder or the confirmed prefix.
  f.state.assist.value = fullText;
  f.event("input", { isComposing: false, inputType: "insertFromComposition", data: remainder });
  f.tick();

  assert.deepStrictEqual(delivered(f), [fullText]);
}

check("pre-end insertText prefix plus compositionend remainder is delivered once", () => {
  replaySplitCommit("insertText");
});

check("pre-end insertFromComposition prefix plus compositionend remainder is delivered once", () => {
  replaySplitCommit("insertFromComposition");
});

check("compositionend data that already includes a confirmed prefix is not duplicated", () => {
  const f = fixture();
  const prefix = "你";
  const text = prefix + "好，今天的会议改到下午三点。";
  f.event("compositionstart");
  f.input("nihao", { isComposing: true, inputType: "insertCompositionText", data: "nihao" });
  f.input(prefix, { isComposing: false, inputType: "insertText", data: prefix });
  f.state.assist.value = text;
  f.event("compositionend", { data: text });
  f.state.assist.value = text;
  f.event("input", { isComposing: false, inputType: "insertFromComposition", data: text });
  assert.deepStrictEqual(delivered(f), [text]);
});

check("insertFromComposition acknowledgement after cleanup does not duplicate", () => {
  const f = fixture();
  const text = "确认后的长句完整保留。";
  f.event("compositionstart");
  f.input("pinyin", { isComposing: true, inputType: "insertCompositionText", data: "pinyin" });
  f.state.assist.value = text;
  f.event("compositionend", { data: text });
  f.tick();

  f.state.assist.value = text;
  f.event("input", { isComposing: false, inputType: "insertFromComposition", data: text });
  assert.deepStrictEqual(delivered(f), [text]);
});

check("cancelled preedit is discarded", () => {
  const f = fixture();
  f.event("compositionstart");
  f.input("尚未确认的拼音草稿", {
    isComposing: true, inputType: "insertCompositionText", data: "尚未确认的拼音草稿"
  });
  f.event("compositionend", { data: "" });
  f.tick();
  assert.deepStrictEqual(delivered(f), []);
});

check("confirmed prefix survives cancellation while unconfirmed preedit is discarded", () => {
  const f = fixture();
  const prefix = "你";
  f.event("compositionstart");
  f.input("nihao草稿", { isComposing: true, inputType: "insertCompositionText", data: "nihao草稿" });
  f.input(prefix, { isComposing: false, inputType: "insertText", data: prefix });
  f.state.assist.value = prefix;
  f.event("compositionend", { data: "" });
  f.tick();
  assert.deepStrictEqual(delivered(f), [prefix]);
});

check("empty compositionend does not accept confirmed text when the DOM does not support it", () => {
  const f = fixture();
  f.event("compositionstart");
  f.input("nihao草稿", { isComposing: true, inputType: "insertCompositionText", data: "nihao草稿" });
  f.input("你", { isComposing: false, inputType: "insertText", data: "你" });
  f.state.assist.value = "其他可见内容";
  f.event("compositionend", { data: "" });
  f.tick();
  assert.deepStrictEqual(delivered(f), []);
});

check("different unconfirmed preedit is never used as a prefix", () => {
  const f = fixture();
  const preedit = "草稿拼音";
  const committed = "最终提交内容";
  f.event("compositionstart");
  f.input(preedit, { isComposing: true, inputType: "insertCompositionText", data: preedit });
  f.state.assist.value = preedit + committed;
  f.event("compositionend", { data: committed });
  f.tick();
  assert.deepStrictEqual(delivered(f), [committed]);
});

check("non-matching DOM does not justify merging a confirmed prefix with end data", () => {
  const f = fixture();
  const prefix = "你";
  const remainder = "好，今天的会议改到下午三点。";
  f.event("compositionstart");
  f.input("nihao草稿", { isComposing: true, inputType: "insertCompositionText", data: "nihao草稿" });
  f.input(prefix, { isComposing: false, inputType: "insertText", data: prefix });
  f.state.assist.value = "草稿" + remainder;
  f.event("compositionend", { data: remainder });
  f.tick();
  assert.deepStrictEqual(delivered(f), [remainder]);
});

check("explicit beforeinput starts a distinct same-text insert after cleanup", () => {
  const f = fixture();
  const text = "相同内容也可能是用户新输入。";
  f.event("compositionstart");
  f.input("pinyin", { isComposing: true, inputType: "insertCompositionText", data: "pinyin" });
  f.state.assist.value = text;
  f.event("compositionend", { data: text });
  f.tick();

  f.event("beforeinput", { isComposing: false, inputType: "insertText", data: text });
  f.state.assist.value = text;
  f.event("input", { isComposing: false, inputType: "insertText", data: text });
  assert.deepStrictEqual(delivered(f), [text, text]);
});

check("two intentional identical commits remain two commits", () => {
  const f = fixture();
  for (let i = 0; i < 2; i += 1) {
    f.event("compositionstart");
    f.input("hao", { isComposing: true, inputType: "insertCompositionText", data: "hao" });
    f.event("compositionend", { data: "好" });
    f.tick();
  }
  assert.deepStrictEqual(delivered(f), ["好", "好"]);
});

check("multiple confirmed fragments preserve emoji and repeated characters before end remainder", () => {
  const f = fixture();
  const confirmed = "嗯嗯😀";
  const remainder = "再补一句。";
  const fullText = confirmed + remainder;
  f.event("compositionstart");
  f.input("en en emoji", { isComposing: true, inputType: "insertCompositionText", data: "en en emoji" });
  f.input("嗯", { isComposing: false, inputType: "insertText", data: "嗯" });
  f.input("嗯😀", { isComposing: false, inputType: "insertFromComposition", data: "嗯😀" });
  f.state.assist.value = fullText;
  f.event("compositionend", { data: remainder });
  f.tick();
  assert.deepStrictEqual(delivered(f), [fullText]);
});

check("backpressure retry does not mix a confirmed prefix into the next composition", () => {
  const clock = createClock();
  const f = fixture({ clock });
  f.socket.bufferedAmount = 262144;

  const first = "旧前缀旧余文";
  f.event("compositionstart");
  f.input("jiu", { isComposing: true, inputType: "insertCompositionText", data: "jiu" });
  f.input("旧前缀", { isComposing: false, inputType: "insertText", data: "旧前缀" });
  f.state.assist.value = first;
  f.event("compositionend", { data: "旧余文" });
  clock.advance(0); // Run commit cleanup while transport retry remains delayed.
  assert.deepStrictEqual(f.sent, []);

  const second = "新句子";
  f.event("compositionstart");
  f.input("xin", { isComposing: true, inputType: "insertCompositionText", data: "xin" });
  f.state.assist.value = second;
  f.event("compositionend", { data: second });
  clock.advance(0);
  assert.strictEqual(f.window.selkiesRecoverPendingInput(), first + second);

  f.socket.bufferedAmount = 0;
  clock.advance(120);
  assert.deepStrictEqual(delivered(f), [first, second]);
});

check("cancellation and remounted assist do not inherit a prior confirmed prefix", () => {
  const cancelled = fixture();
  cancelled.event("compositionstart");
  cancelled.input("lao", { isComposing: true, inputType: "insertCompositionText", data: "lao" });
  cancelled.input("旧确认", { isComposing: false, inputType: "insertText", data: "旧确认" });
  cancelled.state.assist.value = "旧确认";
  cancelled.event("compositionend", { data: "" });
  cancelled.tick();

  cancelled.event("compositionstart");
  cancelled.input("xin", { isComposing: true, inputType: "insertCompositionText", data: "xin" });
  cancelled.state.assist.value = "新提交";
  cancelled.event("compositionend", { data: "新提交" });
  cancelled.tick();
  assert.deepStrictEqual(delivered(cancelled), ["旧确认", "新提交"]);

  const remounted = fixture();
  remounted.event("compositionstart");
  remounted.input("lao", { isComposing: true, inputType: "insertCompositionText", data: "lao" });
  remounted.input("旧前缀", { isComposing: false, inputType: "insertText", data: "旧前缀" });
  remounted.state.assist = { id: "keyboard-input-assist", value: "新输入" };
  remounted.event("input", { isComposing: false, inputType: "insertText", data: "新输入" });
  assert.deepStrictEqual(delivered(remounted), ["新输入"]);
});

if (failures.length) {
  console.error("\n" + failures.length + " failed; " + passed + " passed");
  process.exitCode = 1;
} else {
  console.log("\nAll " + passed + " partial-commit checks passed");
}
