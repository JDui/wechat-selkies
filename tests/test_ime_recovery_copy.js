// Recovering text is an explicit local clipboard write, with no network
// replay and no loss of the stored text if clipboard permission is denied.
const assert = require("assert");
const vm = require("vm");
const { fixture, source } = require("./helpers/ime_fixture");

function loadBetween(f, startName, endName) {
  const start = source.indexOf("  " + startName);
  const end = source.indexOf("  " + endName, start);
  assert(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), f.context);
}

function setup(writeText) {
  const f = fixture({ navigator: { clipboard: { writeText } } });
  loadBetween(f, "function clientClipboardPermissionDepth(", "function withClientClipboardTransferPermission(");
  loadBetween(f, "function copyTextToClipboard(", "async function writePayloadToClientClipboard(");
  loadBetween(f, "async function copyUnsentAssistInput(", "function repairImeAndClipboardLight(");
  return f;
}

(async () => {
  const copied = [];
  const f = setup(async text => {
    assert.strictEqual(f.context.clientClipboardWriteAllowed(), true);
    copied.push(text);
  });
  f.socket.bufferedAmount = 262144;
  f.input("待取回的文字");
  f.context.queueAssistKeyCommand(f.socket, "kd,65293");
  f.context.queueAssistKeyCommand(f.socket, "ku,65293");
  assert.strictEqual(await f.context.copyUnsentAssistInput(), true);
  assert.deepStrictEqual(copied, ["待取回的文字"]);
  assert.strictEqual(f.context.clientClipboardWriteAllowed(), false);
  assert.strictEqual(f.window.selkiesRecoverPendingInput(), "待取回的文字");
  f.socket.bufferedAmount = 0;
  f.tick();
  assert.deepStrictEqual(f.sent, []);
  assert(f.notices.some(([, notice]) => notice.title === "未发送文字已复制" && notice.kind === "success"));

  const denied = setup(async () => { throw new Error("clipboard denied"); });
  denied.socket.bufferedAmount = 262144;
  denied.input("失败也不能丢失");
  assert.strictEqual(await denied.context.copyUnsentAssistInput(), false);
  assert.strictEqual(denied.context.clientClipboardWriteAllowed(), false);
  assert.strictEqual(denied.window.selkiesRecoverPendingInput(), "失败也不能丢失");
  denied.socket.bufferedAmount = 0;
  denied.tick();
  assert.deepStrictEqual(denied.sent, []);
  assert(denied.notices.some(([, notice]) => notice.title === "复制未完成" && notice.kind === "warning"));

  const empty = setup(() => { throw new Error("must not overwrite clipboard with an empty value"); });
  assert.strictEqual(await empty.context.copyUnsentAssistInput(), false);
  assert.deepStrictEqual(empty.sent, []);
  assert(empty.notices.some(([, notice]) => notice.title === "没有未发送文字"));

  const partialCopied = [];
  const partial = setup(async text => partialCopied.push(text));
  const text = "中文𠮷".repeat(80);
  partial.socket.send = packet => { partial.sent.push(packet); partial.socket.bufferedAmount = 262144; };
  partial.input(text);
  const accepted = partial.sent[0].slice(7);
  assert.strictEqual(await partial.context.copyUnsentAssistInput(), true);
  assert.strictEqual(accepted + partialCopied[0], text);
  console.log("PASS IME local recovery copy: permission scope, errors, empty buffer, partial delivery and no replay");
})().catch(error => { console.error(error); process.exitCode = 1; });
