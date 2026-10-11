// Slow responses and disconnects must not accumulate periodic HTTP requests.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "../root/usr/share/selkies/selkies-dashboard/src/selkies-runtime-overrides.js"), "utf8");
function functionSource(name) {
  const start = source.indexOf("  function " + name + "(");
  assert(start >= 0, name + " not found");
  const end = source.indexOf("\n  function ", start + 1);
  assert(end > start, name + " end not found");
  return source.slice(start, end);
}
async function settle() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}
function harness(names) {
  const requests = [];
  const intervals = [];
  const listeners = {};
  const context = {
    now: 10000, redirects: 0,
    notificationPollTimer: null, notificationPollInFlight: false,
    notificationCursor: 0, notificationCursorKey: "notification-cursor",
    localLinkPollTimer: null, localLinkPollInFlight: false,
    localLinkCursor: 0, localLinkCursorKey: "link-cursor",
    LOCAL_LINK_OPEN_ENABLED: true, LOCAL_LINK_POLL_INTERVAL_MS: 800,
    adaptiveSleepStatusInFlight: false,
    notificationActivityInFlight: false, notificationActivityPending: false,
    lastNotificationActivityReportAt: 0,
    adaptiveSleepActivityInFlight: false, adaptiveSleepActivityPending: false,
    adaptiveSleepLastActivityPostAt: 0,
    sessionCheckInFlight: false, lastSessionCheckAt: 0,
    activeUnreadClearRequest: null, activeUnreadClearLastAt: 0,
    wechatUnread: true, qqUnread: false, pendingUnreadClearApp: "",
    WS_SESSION_ID: "", WS_SESSION_EPOCH: 0,
    Promise, encodeURIComponent,
    AbortSignal: { timeout(ms) {
      assert.strictEqual(ms, 5000, "reuse the existing preferences timeout");
      const controller = new AbortController();
      context.nextController = controller;
      return controller.signal;
    } },
    notificationApiPath: suffix => "notifications/" + suffix,
    localLinkApiPath: suffix => "links/" + suffix,
    containerSleepApiPath: suffix => "sleep/" + suffix,
    authBasePath: () => "auth/", withSessionIdentity: url => url,
    parseTimestamp: value => Number(value) || 0,
    setStoredValue() {}, recordSessionClientNotification() {},
    setUnreadState() {}, clearPendingUnreadClearState() {},
    scheduleAutoSplitForPinSession() {}, syncUnreadDockState() {}, renderDebugToolsSection() {},
    applyNotificationEvents() {}, applyLocalLinkEvents() {}, applyAdaptiveSleepStatus() {},
    startLocalLinkHistoryMount() {}, reportFrontendInteractionState() {},
    loadNotificationBridgeState: () => Promise.resolve(),
    forcePinLogin: () => { context.redirects += 1; },
    document: { hidden: false, addEventListener: (name, fn) => { listeners[name] = fn; } },
    window: {
      fetch(url, options) {
        const request = { url, options, controller: context.nextController };
        requests.push(request);
        return new Promise((resolve, reject) => {
          request.respond = (payload, status = 200) => resolve({
            ok: status >= 200 && status < 300, status,
            json: () => Promise.resolve(payload)
          });
          request.stallBody = () => resolve({ ok: true, status: 200, json: () => new Promise((_resolve, bodyReject) => {
            options.signal.addEventListener("abort", () => bodyReject(new Error("body aborted")), { once: true });
          }) });
          request.reject = reject;
          options.signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
        });
      },
      setInterval(fn) { intervals.push(fn); return intervals.length; },
      setTimeout() {},
      addEventListener: (name, fn) => { listeners[name] = fn; },
      sessionStorage: { setItem() {} }
    }
  };
  context.Date = { now: () => context.now };
  vm.createContext(context);
  vm.runInContext(names.map(functionSource).join("\n"), context);
  return { context, requests, intervals, listeners };
}

async function checkPoller(names, start, trigger) {
  const state = harness(names);
  const { context, requests } = state;
  context[start]();
  for (let i = 0; i < 30; i += 1) trigger(state);
  assert.strictEqual(requests.length, 1, start + " must keep one request in flight");
  requests[0].stallBody();
  await settle();
  trigger(state);
  assert.strictEqual(requests.length, 1, "a pending response body also holds the gate");
  requests[0].controller.abort();
  await settle();
  trigger(state);
  assert.strictEqual(requests.length, 2, "timeout releases the gate for the next cycle");
  requests[1].respond({ ok: true, events: [], latest_id: 0 });
  await settle();
  trigger(state);
  assert.strictEqual(requests.length, 3, "success releases the gate");
  requests[2].reject(new Error("offline"));
  await settle();
  trigger(state);
  assert.strictEqual(requests.length, 4, "network failure releases the gate");
  requests[3].respond(null);
  await settle();
}

async function checkActivity(name) {
  const { context, requests } = harness([name]);
  context[name](true);
  context.now += 2000;
  for (let i = 0; i < 30; i += 1) context[name](true);
  assert.strictEqual(requests.length, 1, "activity updates must coalesce while pending");
  requests[0].controller.abort();
  await settle();
  assert.strictEqual(requests.length, 2, "flush the latest activity once after timeout");
  assert.strictEqual(JSON.parse(requests[1].options.body).ts, context.now, "flush current activity time");
  requests[1].respond(null);
  await settle();
  assert.strictEqual(requests.length, 2, "a cleared pending flag must not retry indefinitely");
  context[name](false);
  assert.strictEqual(requests.length, 2, "retain the existing 900 ms activity throttle");
}

(async () => {
  await checkPoller(["startNotificationEventPoller"], "startNotificationEventPoller", state => state.intervals[0]());
  await checkPoller(["pollLocalLinkEvents", "startLocalLinkEventPoller"], "startLocalLinkEventPoller", state => {
    state.intervals[0]();
    state.listeners.focus();
    state.listeners.visibilitychange();
  });
  await checkPoller(["loadContainerSleepStatus", "pollAdaptiveSleepStatus"], "pollAdaptiveSleepStatus", state => state.context.pollAdaptiveSleepStatus());
  await checkPoller(["fetchActiveRemoteApp", "clearUnreadFromActiveRemoteApp"], "clearUnreadFromActiveRemoteApp", state => {
    state.context.now += 300;
    state.context.clearUnreadFromActiveRemoteApp();
  });
  await checkActivity("reportFrontendInteractionState");
  await checkActivity("postContainerSleepActivity");

  const { context, requests } = harness(["refreshSessionIdentity"]);
  context.refreshSessionIdentity(true);
  for (let i = 0; i < 30; i += 1) context.refreshSessionIdentity(true);
  assert.strictEqual(requests.length, 1, "focus events must not stack session requests");
  requests[0].controller.abort();
  await settle();
  assert.strictEqual(context.redirects, 0, "timeout must not log out a valid session");
  context.refreshSessionIdentity(true);
  requests[1].respond({ ok: true, session_id: "session", session_epoch: 3 });
  await settle();
  assert.strictEqual(context.WS_SESSION_ID, "session");
  context.refreshSessionIdentity(true);
  requests[2].respond(null, 401);
  await settle();
  assert.strictEqual(context.redirects, 1, "preserve the existing unauthorized redirect");
  console.log("runtime polling bounds regression checks passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
