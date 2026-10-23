(function () {
  "use strict";
  var api = new URL("../api/dock-download/", document.currentScript.src).pathname;
  var client = Array.from(crypto.getRandomValues(new Uint8Array(16)), function (n) { return n.toString(16).padStart(2, "0"); }).join("");
  var holding = false, busy = false, timer, seen = new Set(), notices = new Set(), noticeTimer;
  var notice = null, dragSerial = 0;
  var paths = {
    "client-to-remote": "M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5",
    "remote-to-client": "M12 17V5m-4 4 4-4 4 4M5 16v5h14v-5",
    "wechat-focus": "M14.5 5.4A7 6 0 0 0 2 9c0 1.7.8 3.2 2.2 4.3L3.5 16l3-1.5 2 .4M8 8h.01M12 8h.01M22 14a6 5 0 1 0-3 4.3l2.5 1.2-.6-2.3A5 5 0 0 0 22 14ZM13.5 13h.01M17.5 13h.01",
    "qq-focus": "M7 10V8a5 5 0 0 1 10 0v2l2 5c.5 1.4-.3 2-1.5.8.2 2.5-1.5 4.2-5.5 4.2S6.3 18.3 6.5 15.8C5.3 17 4.5 16.4 5 15ZM10 7.5v1M14 7.5v1M10.5 11h3M9 15c0 3 6 3 6 0",
    "split-toggle": "M3 4h18v16H3ZM12 4v16",
    "dock-collapse": "m6 9 6 6 6-6"
  };
  var style = document.createElement("style");
  style.textContent = "#selkies-bottom-action-dock-shell{--dock-glass:rgba(25,42,60,.24);--dock-edge:rgba(240,250,255,.42)}" +
    "#selkies-bottom-action-dock-shell{width:max-content}" +
    "#selkies-bottom-action-dock-shell #selkies-bottom-action-dock{position:relative;width:auto;height:34px;padding:3px 8px;gap:4px;border-radius:999px;background:linear-gradient(160deg,rgba(255,255,255,.16),rgba(255,255,255,.02) 50%),var(--dock-glass);backdrop-filter:blur(6px) saturate(120%);-webkit-backdrop-filter:blur(6px) saturate(120%);box-shadow:inset 0 1px 1px rgba(255,255,255,.48),inset 0 -1px 1px #ffffff14,0 4px 16px rgba(0,12,30,.16);text-shadow:0 1px 3px #001324a6}" +
    "#selkies-bottom-action-dock .selkies-bottom-dock-btn{flex:0 1 28px;width:28px;min-width:26px;height:26px;padding:4px;border-radius:50%;border-color:transparent;background:transparent;box-shadow:none;color:#f2f9ff}" +
    "#selkies-bottom-action-dock .selkies-bottom-dock-btn:hover{background:rgba(255,255,255,.18);border-color:rgba(255,255,255,.3)}" +
    "#selkies-bottom-action-dock svg{display:block;width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;pointer-events:none;filter:drop-shadow(0 1px 1px #00132466)}" +
    "#selkies-bottom-action-dock-shell[data-position='top'] [data-dock-action='dock-collapse'] svg{transform:rotate(180deg)}" +
    "#selkies-bottom-action-dock-shell[data-pointer-held='1'] #selkies-bottom-action-dock,#selkies-bottom-action-dock-shell[data-pointer-held='1'] #selkies-bottom-split-popover,#selkies-bottom-action-dock-shell[data-pointer-held='1'] #selkies-bottom-dock-collapsed-toggle{pointer-events:none}" +
    "#selkies-dock-download-hint{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);padding:7px 12px;border-radius:14px;border:1px solid rgba(224,246,255,.46);background:linear-gradient(155deg,#ffffff24,#ffffff05),rgba(23,43,61,.32);backdrop-filter:blur(6px) saturate(120%);-webkit-backdrop-filter:blur(6px) saturate(120%);color:#f5fbff;text-shadow:0 1px 3px #001324b3;box-shadow:inset 0 1px 1px #ffffff45,0 4px 14px #001a3026;font:500 11px/1.5 system-ui;white-space:normal;width:max-content;max-width:min(280px,82vw);text-align:center;pointer-events:auto}" +
    "#selkies-bottom-action-dock-shell[data-pointer-held='1'] #selkies-dock-download-hint{pointer-events:none}" +
    "#selkies-dock-download-hint[hidden]{display:none}#selkies-dock-download-hint a{display:block;color:#a5f3fc}" +
    "#selkies-bottom-action-dock-shell[data-position='top'] #selkies-dock-download-hint{top:calc(100% + 12px);bottom:auto}" +
    "#selkies-bottom-action-dock-shell[data-drop-phase='target'] #selkies-bottom-action-dock{border-color:#a5f3fc;animation:axi-drop-breathe 1.4s ease-in-out infinite}" +
    "#selkies-dock-drop-label{position:absolute;inset:0;display:none;align-items:center;justify-content:center;overflow:hidden;border-radius:inherit;color:#e4fbff;font:600 12px/1 system-ui;letter-spacing:1.1px;pointer-events:none;text-shadow:0 1px 3px #00243ba6}" +
    "#selkies-dock-drop-label::after{content:'';position:absolute;inset:0;background:linear-gradient(105deg,transparent 25%,#d5fcff55 50%,transparent 75%);transform:translateX(-100%);animation:axi-drop-flow 1.8s ease-in-out infinite}" +
    "#selkies-bottom-action-dock-shell[data-drop-phase='target'] #selkies-dock-drop-label,#selkies-bottom-action-dock-shell[data-drop-phase='preparing'] #selkies-dock-drop-label{display:flex}" +
    "#selkies-bottom-action-dock-shell[data-drop-phase='target'] #selkies-bottom-action-dock>button,#selkies-bottom-action-dock-shell[data-drop-phase='target'] #selkies-dock-network-monitor,#selkies-bottom-action-dock-shell[data-drop-phase='preparing'] #selkies-bottom-action-dock>button,#selkies-bottom-action-dock-shell[data-drop-phase='preparing'] #selkies-dock-network-monitor{visibility:hidden;pointer-events:none}" +
    "#selkies-bottom-action-dock-shell[data-drop-phase='target'] #selkies-bottom-split-popover,#selkies-bottom-action-dock-shell[data-drop-phase='preparing'] #selkies-bottom-split-popover{visibility:hidden;pointer-events:none;opacity:0}" +
    "@keyframes axi-drop-flow{to{transform:translateX(100%)}}" +
    "@keyframes axi-drop-breathe{50%{box-shadow:inset 0 1px 2px #fff8,0 0 28px #22d3ee99,0 0 8px #38bdf8aa}}" +
    "#selkies-bottom-action-dock-shell[data-collapsed='1']:is([data-drop-phase='target'],[data-drop-phase='preparing']){width:220px;max-width:calc(100vw - 12px)}#selkies-bottom-action-dock-shell[data-collapsed='1']:is([data-drop-phase='target'],[data-drop-phase='preparing']) #selkies-bottom-action-dock{width:100%;opacity:1;visibility:visible;transform:none;pointer-events:none}#selkies-bottom-action-dock-shell:is([data-drop-phase='target'],[data-drop-phase='preparing']) #selkies-bottom-dock-collapsed-toggle{visibility:hidden;pointer-events:none;opacity:0}" +
    "@media(max-width:640px){#selkies-bottom-action-dock-shell{width:max-content;max-width:calc(100vw - 12px)}#selkies-bottom-action-dock-shell #selkies-bottom-action-dock{width:auto;height:32px;padding:2px 7px;gap:3px}#selkies-dock-network-monitor{flex-basis:78px}}" +
    "@media(prefers-reduced-motion:reduce){#selkies-bottom-action-dock-shell[data-drop-phase='target'] #selkies-bottom-action-dock{animation:none;box-shadow:0 0 20px #22d3ee88}#selkies-dock-drop-label::after{animation:none;background:none}}";
  document.head.appendChild(style);

  function surface() {
    var primary = document.getElementById("video");
    var candidates = primary && primary.tagName === "CANVAS" ? [primary] : Array.from(document.querySelectorAll("canvas"));
    return candidates.filter(function (c) {
      var r = c.getBoundingClientRect();
      return c.width > 0 && c.height > 0 && r.width > 100 && r.height > 100;
    }).sort(function (a, b) { return b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height; })[0];
  }
  function geometry(shell) {
    if (document.hidden || shell.getAttribute("data-visible") !== "1") return null;
    var canvas = surface();
    if (!canvas || document.pointerLockElement) return null;
    var r = canvas.getBoundingClientRect();
    var expandedDrop = shell.dataset.dropPhase === "target" || shell.dataset.dropPhase === "preparing";
    var dock = shell.querySelector(shell.getAttribute("data-collapsed") === "1" && !expandedDrop ? "#selkies-bottom-dock-collapsed-toggle" : "#selkies-bottom-action-dock").getBoundingClientRect();
    var left = Math.max(r.left, dock.left - 24), top = Math.max(r.top, dock.top - 24);
    var right = Math.min(r.right, dock.right + 24), bottom = Math.min(r.bottom, dock.bottom + 24);
    if (right <= left || bottom <= top) return null;
    var x = Math.floor((left - r.left) * canvas.width / r.width), y = Math.floor((top - r.top) * canvas.height / r.height);
    return [x, y, Math.ceil((right - r.left) * canvas.width / r.width) - x, Math.ceil((bottom - r.top) * canvas.height / r.height) - y];
  }
  function decorate(shell) {
    Object.keys(paths).forEach(function (action) {
      var button = shell.querySelector('[data-dock-action="' + action + '"]');
      if (!button || (button.dataset.dropIcon && button.querySelector("svg"))) return;
      var label = button.getAttribute("aria-label") || button.textContent;
      button.setAttribute("aria-label", label); button.title = label; button.dataset.dropIcon = "1";
      button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="' + paths[action] + '"></path></svg>';
      if (action === "qq-focus") {
        button.querySelector("svg").innerHTML += '<path d="M7 11.5c3 1.2 7 1.2 10 0M15 12.5l1 4 2-1" stroke="#fb7185" stroke-width="2.2"></path><path d="m8 20-2 1h4m4 0h4l-2-1" stroke="#fde68a"></path>';
      }
    });
    var dock = shell.querySelector("#selkies-bottom-action-dock");
    if (!shell.querySelector("#selkies-dock-drop-label")) {
      var label = document.createElement("span"); label.id = "selkies-dock-drop-label";
      label.setAttribute("role", "status"); label.setAttribute("aria-live", "polite");
      dock.appendChild(label);
    }
    var hint = shell.querySelector("#selkies-dock-download-hint");
    if (!hint) {
      hint = document.createElement("div"); hint.id = "selkies-dock-download-hint";
      hint.setAttribute("role", "status"); hint.setAttribute("aria-live", "polite"); hint.hidden = true;
      shell.appendChild(hint);
    }
    return hint;
  }
  function showNotice(hint, key, message, link, duration) {
    if (notices.has(key)) return;
    notices.add(key);
    if (notices.size > 64) notices.delete(notices.values().next().value);
    clearTimeout(noticeTimer);
    notice = {key: key, message: message, link: link};
    noticeTimer = setTimeout(function () { notice = null; hint.hidden = true; }, duration);
  }
  function friendlyError(message) {
    if (!message || message.indexOf("SELKIES_DROP_SOURCE_ROOTS") !== -1 || message.indexOf("未获下载授权") !== -1) return "此文件暂不支持直接下载，请先另存到下载目录";
    return message;
  }
  function render(shell, state) {
    var hint = decorate(shell), phase = state.phase || "idle", link;
    shell.dataset.dropPhase = phase;
    var active = phase === "target" || phase === "preparing";
    var label = shell.querySelector("#selkies-dock-drop-label");
    var dropText = phase === "target" ? "拖入以下载到本机" : phase === "preparing" ? "正在准备下载…" : "";
    if (label.textContent !== dropText) label.textContent = dropText;
    var jobs = state.jobs || [], latest = jobs[jobs.length - 1];
    if (!active && (phase === "error" || (latest && latest.state === "error"))) {
      var error = latest && latest.state === "error" ? latest.error : state.error;
      var errorKey = state.error_id || error;
      showNotice(hint, "error:" + errorKey, friendlyError(error), null, 4000);
    } else if (phase === "unsupported") showNotice(hint, "unsupported:" + dragSerial, "请拖入已下载的普通文件", null, 4000);
    (state.jobs || []).forEach(function (job) {
      if (job.state === "ready" && job.token) {
        link = api + "file/" + encodeURIComponent(job.id) + "?token=" + encodeURIComponent(job.token);
        if (!seen.has(job.id)) {
          seen.add(job.id);
          var a = document.createElement("a"); a.href = link; a.download = job.name; a.hidden = true;
          document.body.appendChild(a); a.click(); a.remove();
          showNotice(hint, "download:" + job.id, "已发起下载，请查看浏览器下载列表", link, 5000);
        }
      }
    });
    var message = notice ? notice.message : "";
    link = notice ? notice.link : "";
    // Avoid repeatedly announcing unchanged live-region text on every poll.
    if (hint.dataset.message !== message || hint.dataset.link !== (link || "")) {
      hint.textContent = message; hint.dataset.message = message; hint.dataset.link = link || "";
      if (link) { var retry = document.createElement("a"); retry.href = link; retry.download = ""; retry.textContent = "浏览器未开始？点击下载"; hint.appendChild(retry); }
    }
    hint.hidden = active || !message;
  }
  async function tick() {
    clearTimeout(timer);
    var shell = document.getElementById("selkies-bottom-action-dock-shell");
    if (!shell || busy) { timer = setTimeout(tick, 500); return; }
    decorate(shell); shell.dataset.pointerHeld = holding ? "1" : "0";
    busy = true;
    try {
      var response = await fetch(api + "geometry", {method: "POST", credentials: "same-origin", cache: "no-store",
        signal: AbortSignal.timeout(4000), headers: {"Content-Type": "application/json"}, body: JSON.stringify({client: client, rect: geometry(shell)})});
      if (response.ok) render(shell, await response.json());
      else if (response.status === 401) { render(shell, {phase: "idle"}); holding = false; }
      else if (response.status === 409 && holding) render(shell, {phase: "error", error_id: "conflict:" + dragSerial, error: "下载接收区正由另一个页面使用，请关闭该页面后重试"});
    } catch (_) { shell.dataset.dropPhase = "idle"; }
    finally { busy = false; timer = setTimeout(tick, holding ? 100 : document.hidden ? 2000 : 750); }
  }
  document.addEventListener("pointerdown", function (e) {
    if (e.button === 0 && e.target && (e.target.tagName === "CANVAS" || e.target.id === "overlayInput")) {
      holding = true;
      dragSerial += 1;
      var shell = document.getElementById("selkies-bottom-action-dock-shell");
      if (shell) shell.dataset.pointerHeld = "1";
      tick();
    }
  }, true);
  function release() { setTimeout(function () { holding = false; tick(); }, 0); }
  document.addEventListener("pointerup", release, true);
  document.addEventListener("pointercancel", release, true);
  window.addEventListener("blur", release);
  document.addEventListener("visibilitychange", tick);
  window.addEventListener("resize", tick);
  document.addEventListener("fullscreenchange", tick);
  window.addEventListener("pagehide", function () {
    navigator.sendBeacon(api + "geometry", new Blob([JSON.stringify({client: client, rect: null})], {type: "application/json"}));
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tick); else tick();
})();
