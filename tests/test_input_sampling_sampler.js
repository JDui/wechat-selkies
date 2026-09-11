// Regression test for the input sampling governor in selkies-runtime-overrides.js.
// It extracts the real function source from the shipped file and exercises it, so
// the test cannot silently drift from the implementation.
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const target = path.join(
  __dirname,
  "..",
  "root",
  "usr",
  "share",
  "selkies",
  "selkies-dashboard",
  "src",
  "selkies-runtime-overrides.js"
);
const source = fs.readFileSync(target, "utf8");

const start = source.indexOf("  function sanitizeInputSamplingMultiplier(value) {");
const end = source.indexOf("  function installSingleSessionWebSocketGuard() {");
assert(start > 0, "sampler block start not found");
assert(end > start, "sampler block end not found");
const block = source.slice(start, end);

// Mirror the constants declared alongside the state in the real file.
const scope = `
  var INPUT_SAMPLING_RELATIVE_BASE_HZ = 60;
  var INPUT_SAMPLING_ABSOLUTE_BASE_HZ = 125;
  var INPUT_SAMPLING_MIN_MULTIPLIER = 0.5;
  var INPUT_SAMPLING_MAX_MULTIPLIER = 2;
  var INPUT_SAMPLING_SCROLL_BUTTON_MASK = (1 << 3) | (1 << 4) | (1 << 6) | (1 << 7);
  var inputSamplingMultiplier = 1;
  var window = { setTimeout: setTimeout, clearTimeout: clearTimeout };
  ${block}
  return {
    createInputSampler: createInputSampler,
    setMultiplier: function (value) { inputSamplingMultiplier = sanitizeInputSamplingMultiplier(value); },
    sanitize: sanitizeInputSamplingMultiplier,
    baseHz: inputSamplingBaseHz,
    rates: formatInputSamplingRates,
    label: formatInputSamplingLabel
  };
`;
const api = new Function(scope)();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeSampler() {
  const sent = [];
  const fakeWs = {};
  const sampler = api.createInputSampler(fakeWs, function (payload) {
    sent.push(payload);
  });
  return { sent, sampler };
}

(async () => {
  let passed = 0;

  // 1. Baseline definition: 1x is 60 Hz relative / 125 Hz absolute.
  assert.strictEqual(api.baseHz("m2,3,4,0,0"), 60);
  assert.strictEqual(api.baseHz("m,10,20,0,0"), 125);
  assert.strictEqual(api.baseHz("kd,65"), 0);
  assert.strictEqual(api.baseHz("SETTINGS,{}"), 0);
  assert.strictEqual(api.rates(1), "\u89e6\u63a7\u677f 60Hz / \u9f20\u6807 125Hz");
  assert.strictEqual(api.rates(2), "\u89e6\u63a7\u677f 120Hz / \u9f20\u6807 250Hz");
  assert.strictEqual(api.rates(0.5), "\u89e6\u63a7\u677f 30Hz / \u9f20\u6807 63Hz");
  passed++;

  // 2. Clamping and rounding of the slider value.
  assert.strictEqual(api.sanitize(0.1), 0.5);
  assert.strictEqual(api.sanitize(9), 2);
  assert.strictEqual(api.sanitize("abc"), 1);
  assert.strictEqual(api.sanitize("1.25"), 1.25);
  assert.strictEqual(api.sanitize(null), 1);
  passed++;

  // 3. Non-pointer traffic must never be swallowed by the governor.
  {
    const { sent, sampler } = makeSampler();
    assert.strictEqual(sampler.send("kd,65"), false, "keys must pass through natively");
    assert.strictEqual(sampler.send("m,5,5,0,0"), true, "pointer must be handled by the sampler");
    assert.strictEqual(sent.length, 0, "first sample is scheduled, not sent yet");
    sampler.flush();
    assert.deepStrictEqual(sent, ["m,5,5,0,0"]);
    passed++;
  }

  // 4. Coalescing: a burst inside one slot collapses to the newest position.
  {
    const { sent, sampler } = makeSampler();
    api.setMultiplier(1); // 125 Hz absolute -> 8 ms slot
    sampler.send("m,1,1,0,0");
    sampler.flush();
    sent.length = 0;
    sampler.send("m,2,2,0,0");
    sampler.send("m,3,3,0,0");
    sampler.send("m,9,9,0,0");
    sampler.flush();
    assert.deepStrictEqual(sent, ["m,9,9,0,0"], "only the freshest sample should survive");
    passed++;
  }

  // 5. Relative (trackpad) samples accumulate their delta instead of being dropped.
  {
    const { sent, sampler } = makeSampler();
    api.setMultiplier(1);
    sampler.send("m2,1,2,0,0");
    sampler.flush();
    sent.length = 0;
    sampler.send("m2,3,4,0,0");
    sampler.send("m2,5,6,0,0");
    sampler.flush();
    assert.deepStrictEqual(sent, ["m2,8,10,0,0"], "relative deltas must sum, not overwrite");
    passed++;
  }

  // 6. Trailing edge: the final position is always delivered even without a flush call.
  {
    const { sent, sampler } = makeSampler();
    api.setMultiplier(1);
    sampler.send("m,1,1,0,0");
    sampler.flush();
    sent.length = 0;
    sampler.send("m,1,1,0,0");
    sampler.send("m,7,7,0,0");
    await sleep(60);
    assert.deepStrictEqual(sent, ["m,7,7,0,0"], "trailing sample must be flushed by the timer");
    passed++;
  }

  // 7. Button transitions are never delayed by the governor.
  {
    const { sent, sampler } = makeSampler();
    api.setMultiplier(1);
    sampler.send("m,1,1,0,0");
    sampler.flush();
    sent.length = 0;
    sampler.send("m,1,1,0,0"); // would normally wait for the slot
    sampler.send("m,1,1,1,0"); // mousedown -> mask change
    assert.deepStrictEqual(sent, ["m,1,1,1,0"], "mousedown must be sent immediately");
    passed++;
  }

  // 8. Higher multiplier shortens the slot (more samples tolerated per second).
  {
    const { sent, sampler } = makeSampler();
    api.setMultiplier(2); // 250 Hz absolute -> 4 ms slot
    sampler.send("m,1,1,0,0");
    sampler.flush();
    sent.length = 0;
    sampler.send("m,1,1,0,0");
    await sleep(12);
    sampler.send("m,2,2,0,0");
    await sleep(20);
    assert.ok(sent.length >= 2, "2x should admit more samples than 1x");
    assert.strictEqual(sent[sent.length - 1], "m,2,2,0,0");
    passed++;
  }

  // 9. Label formatting for the sidebar readout.
  assert.strictEqual(api.label(1), "1.0\u00d7");
  assert.strictEqual(api.label(1.5), "1.5\u00d7");
  assert.strictEqual(api.label(2), "2.0\u00d7");
  assert.strictEqual(api.label(0.5), "0.5\u00d7");
  passed++;

  // 10. Wheel notches must bypass the governor entirely and keep their
  // scroll_magnitude. Regression: an earlier revision rebuilt these as
  // "m2,0,0,<mask>,0", which made the server fall back to Alt+Left /
  // Alt+Right navigation instead of scrolling.
  {
    const { sent, sampler } = makeSampler();
    api.setMultiplier(1);
    assert.strictEqual(sampler.send("m2,0,0,16,1"), false, "wheel must be forwarded by the caller");
    assert.strictEqual(sampler.send("m2,0,0,0,1"), false, "wheel release must be forwarded too");
    assert.deepStrictEqual(
      sent,
      [],
      "the governor itself must not emit or rewrite wheel messages"
    );
    passed++;
  }

  // 11. End-to-end through the real wrapper shape: scroll_magnitude survives.
  {
    const sent = [];
    const sampler = api.createInputSampler({}, (p) => sent.push(p));
    const dispatch = (m) => {
      if (!sampler.send(m)) sent.push(m);
    };
    dispatch("m2,0,0,16,3"); // wheel up, magnitude 3
    dispatch("m2,0,0,0,3"); // release
    assert.deepStrictEqual(
      sent,
      ["m2,0,0,16,3", "m2,0,0,0,3"],
      "wheel magnitude must never be rewritten to 0"
    );
    passed++;
  }

  // 12. Wheel bursts are never coalesced: each notch is a discrete event.
  {
    const sent = [];
    const sampler = api.createInputSampler({}, (p) => sent.push(p));
    const dispatch = (m) => {
      if (!sampler.send(m)) sent.push(m);
    };
    for (let i = 0; i < 5; i++) {
      dispatch("m2,0,0,8,2"); // wheel down, magnitude 2
      dispatch("m2,0,0,0,2");
    }
    assert.strictEqual(sent.length, 10, "every wheel notch must reach the wire");
    assert.strictEqual(sent.filter((m) => m === "m2,0,0,8,2").length, 5);
    passed++;
  }

  // 13. Horizontal wheel buttons (bits 6/7) are discrete events as well.
  {
    const sent = [];
    const sampler = api.createInputSampler({}, (p) => sent.push(p));
    const dispatch = (m) => {
      if (!sampler.send(m)) sent.push(m);
    };
    dispatch("m2,0,0,64,1"); // scroll left
    dispatch("m2,0,0,128,1"); // scroll right
    assert.deepStrictEqual(sent, ["m2,0,0,64,1", "m2,0,0,128,1"]);
    passed++;
  }

  // 14. Ordering: a pending pointer sample is flushed before the wheel event,
  // and it must not inherit the wheel button mask.
  {
    const sent = [];
    const sampler = api.createInputSampler({}, (p) => sent.push(p));
    const dispatch = (m) => {
      if (!sampler.send(m)) sent.push(m);
    };
    api.setMultiplier(1);
    dispatch("m,7,9,0,0"); // pointer sample becomes pending
    dispatch("m2,0,0,16,1"); // wheel up arrives in the same slot
    assert.deepStrictEqual(
      sent,
      ["m,7,9,0,0", "m2,0,0,16,1"],
      "pointer must be flushed first and must not carry the wheel mask"
    );
    passed++;
  }

  // 15. Structural invariant: every emitted message has exactly 4 payload
  // fields (the server unpacks toks[1:] into x, y, mask, scroll).
  {
    const { sent, sampler } = makeSampler();
    api.setMultiplier(1.5);
    sampler.send("m,3,4,0,0");
    sampler.send("m,5,6,1,0");
    sampler.send("m2,1,1,0,0");
    sampler.send("m2,2,2,0,0");
    sampler.flush();
    assert.ok(sent.length > 0, "expected some samples");
    for (const message of sent) {
      const tokens = message.split(",");
      assert.strictEqual(tokens.length, 5, `malformed frame: ${message}`);
      assert.ok(tokens[0] === "m" || tokens[0] === "m2", `bad prefix: ${message}`);
      for (let i = 1; i < tokens.length; i++) {
        assert.ok(Number.isInteger(Number(tokens[i])), `non-integer field in ${message}`);
      }
    }
    passed++;
  }

  console.log(`input-sampling: ${passed} checks passed`);
})().catch((error) => {
  console.error("input-sampling FAILED:", error.message);
  process.exit(1);
});
