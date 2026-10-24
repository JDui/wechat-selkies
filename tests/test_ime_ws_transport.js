// Real loopback WebSocket transport + delayed Python receiver. Network delay
// is injected at application receive, not measured physical-network RTT.
const assert = require("assert");
const path = require("path");
const { spawn } = require("child_process");
const { createInterface } = require("readline");
const { once } = require("events");
const { fixture } = require("./helpers/ime_fixture");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function scenario(port, readDelay, holdMs) {
  const timers = new Set();
  const clock = {
    now: Date.now,
    setTimeout(fn, delay) {
      const id = setTimeout(() => { timers.delete(id); fn(); }, delay); timers.add(id); return id;
    },
    clearTimeout(id) { clearTimeout(id); timers.delete(id); }, count: () => timers.size
  };
  const f = fixture({ clock }), socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const started = Date.now();
  let hold = holdMs ? 262144 : 0;
  const getBuffered = Object.getOwnPropertyDescriptor(WebSocket.prototype, "bufferedAmount").get;
  Object.defineProperty(socket, "bufferedAmount", { get: () => getBuffered.call(socket) + hold });
  let timeout;
  try {
    await once(socket, "open");
    const nativeSend = socket.send.bind(socket);
    f.state.socket = socket;
    socket.send = msg => {
      if (!f.context.queueAssistKeyCommand(socket, msg)) nativeSend(msg);
    };
    nativeSend(JSON.stringify({ read_delay_ms: readDelay }));
    if (holdMs) clock.setTimeout(() => { hold = 0; }, holdMs);
    const commit = text => {
      f.event("compositionstart"); f.input("pinyin", { isComposing: true });
      f.event("compositionend", { data: text });
      f.input(text, { data: text, inputType: "insertFromComposition" });
    };
    f.window.addEventListener("keydown", e => {
      socket.send("kd," + (e.key === "Enter" ? 65293 : e.key.codePointAt(0))); e.preventDefault();
    });
    f.window.addEventListener("keyup", e => socket.send("ku," + (e.key === "Enter" ? 65293 : e.key.codePointAt(0))));
    const key = key => { f.event("keydown", { key, code: key }); f.event("keyup", { key, code: key }); };
    commit("连续"); commit("选词😀𠮷"); key("a"); key("Enter"); commit("第二句"); key("Enter");
    for (let i = 0; i < 500 && f.context.assistPendingPackets.length; i++) await pause(10);
    assert.strictEqual(f.context.assistPendingPackets.length, 0, "client queue did not drain");
    const result = Promise.race([
      once(socket, "message").then(([event]) => JSON.parse(event.data)),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(Error("receiver timed out")), 20000); })
    ]);
    nativeSend("TEST_END");
    const received = await result;
    assert.deepStrictEqual(received.submissions, ["连续选词😀𠮷a", "第二句"]);
    assert.strictEqual(received.remaining, "");
    console.log(JSON.stringify({ transport: "real loopback WebSocket", injectedReadDelayMs: readDelay,
      simulatedClientBacklogMs: holdMs, elapsedMs: Date.now() - started, messages: received.messages, status: "PASS" }));
  } finally {
    clearTimeout(timeout); for (const id of timers) clearTimeout(id); socket.close();
  }
}

(async () => {
  const server = spawn(process.env.PYTHON || "python", ["-u", path.join(__dirname, "ime_latency_ws_server.py")],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "", serverExit;
  server.stderr.on("data", chunk => { stderr += chunk; });
  const lines = createInterface({ input: server.stdout });
  let startupTimer;
  try {
    const line = await Promise.race([
      once(lines, "line").then(([line]) => line),
      new Promise((_, reject) => { startupTimer = setTimeout(() => reject(Error("server startup timeout: " + stderr)), 5000); }),
      once(server, "exit").then(([code]) => { throw Error("server exited " + code + ": " + stderr); })
    ]);
    clearTimeout(startupTimer);
    const { port } = JSON.parse(line);
    await scenario(port, 100, 0);
    await scenario(port, 500, 1500);
  } finally {
    clearTimeout(startupTimer); lines.close();
    if (server.exitCode === null) { serverExit = once(server, "exit"); server.kill(); await serverExit; }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
