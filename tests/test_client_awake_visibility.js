// Regression test: an unfocused but visible stream (for example on a second
// monitor) stays awake until the page is actually hidden or disconnected.
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

const predicateStart = source.indexOf("  function isClientPageAwake() {");
const predicateEnd = source.indexOf("  function reportClientAwakeState(forceState) {");
assert(predicateStart > 0, "awake predicate start not found");
assert(predicateEnd > predicateStart, "awake predicate end not found");
const predicateBlock = source.slice(predicateStart, predicateEnd);

function makePredicate(hidden, focused, socketOpen) {
  return new Function(
    "document",
    "hasOpenDataSocket",
    predicateBlock + "return isClientPageAwake();"
  )(
    { hidden, hasFocus: () => focused },
    () => socketOpen
  );
}

assert.strictEqual(makePredicate(false, true, true), true, "focused visible client is awake");
assert.strictEqual(
  makePredicate(false, false, true),
  true,
  "visible second-monitor client must remain awake without keyboard focus"
);
assert.strictEqual(makePredicate(true, false, true), false, "hidden page is not awake");
assert.strictEqual(makePredicate(false, true, false), false, "disconnected page is not awake");

const heartbeatStart = source.indexOf("  function startClientAwakeHeartbeat() {");
const heartbeatEnd = source.indexOf("  function startIdleCleanupWatcher() {");
assert(heartbeatStart > 0, "awake heartbeat start not found");
assert(heartbeatEnd > heartbeatStart, "awake heartbeat end not found");
const heartbeatBlock = source.slice(heartbeatStart, heartbeatEnd);
assert.match(
  heartbeatBlock,
  /window\.addEventListener\("blur", function \(\) \{\s*reportClientAwakeState\(\);\s*\}\);/,
  "blur must recompute visibility instead of forcing the client offline"
);
assert.match(
  heartbeatBlock,
  /window\.addEventListener\("beforeunload", function \(\) \{\s*reportClientAwakeState\(false\);\s*\}\);/,
  "page unload must still force the client offline"
);

console.log("client awake visibility regression checks passed");
