(() => {
  if (window.top !== window.self || window.__AXIVER_CLIENT__) return;

  const bootstrap = window.__AXIVER_BOOTSTRAP__ || {
    broadcastName: "AXISNSBOX-000",
    wideUrl: ""
  };
  const stateLabels = {
    disconnected: "无法连接",
    discovering_lan: "正在嗅探局域网",
    connecting_lan: "正在连接局域网",
    connecting_wan: "正在连接广域地址",
    wan: "当前连接：广域地址",
    lan: "当前连接：局域网"
  };
  let status = {
    state: "discovering_lan",
    detail: "正在嗅探局域网",
    url: ""
  };
  let collapseTimer = 0;
  let savedTimer = 0;
  let dragState = null;
  let suppressClickUntil = 0;
  let pointerInside = false;
  let broadcastDirty = false;
  let wideDirty = false;
  const iconRefresh = "__AXIVER_ICON_REFRESH__".startsWith("__AXIVER_")
    ? "./icons/refresh.svg"
    : "__AXIVER_ICON_REFRESH__";
  const iconRouter = "__AXIVER_ICON_ROUTER__".startsWith("__AXIVER_")
    ? "./icons/router.svg"
    : "__AXIVER_ICON_ROUTER__";
  const iconGlobe = "__AXIVER_ICON_GLOBE__".startsWith("__AXIVER_")
    ? "./icons/globe.svg"
    : "__AXIVER_ICON_GLOBE__";

  const host = document.createElement("div");
  host.id = "axiver-client-host";
  host.setAttribute("data-axiver-overlay", "");
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host {
      all: initial;
      position: fixed;
      z-index: 2147483647;
      top: 8px;
      left: 8px;
      display: block;
      color-scheme: dark;
      font-family: "Segoe UI Variable", "Microsoft YaHei UI", "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
      text-rendering: geometricPrecision;
    }
    * { box-sizing: border-box; }
    .shell {
      --state: #ef5350;
      --state-soft: rgba(239, 83, 80, .22);
      width: 36px;
      color: #f3f7fb;
      transition: width 380ms cubic-bezier(.22, 1, .36, 1);
    }
    .shell[data-state="discovering_lan"],
    .shell[data-state="connecting_lan"] {
      --state: #f7c84b;
      --state-soft: rgba(247, 200, 75, .22);
    }
    .shell[data-state="connecting_wan"],
    .shell[data-state="wan"] {
      --state: #55a8ff;
      --state-soft: rgba(85, 168, 255, .22);
    }
    .shell.open { width: min(560px, calc(100vw - 16px)); }
    .summary {
      display: flex;
      align-items: center;
      width: max-content;
      max-width: 560px;
      height: 42px;
      padding: 0;
      border: 0;
      outline: none;
      border-radius: 18px;
      color: #eff6fc;
      background: transparent;
      box-shadow: none;
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
      overflow: hidden;
      transition:
        background 240ms ease,
        box-shadow 240ms ease,
        padding 380ms cubic-bezier(.22, 1, .36, 1);
    }
    .shell:not(.open) .summary { cursor: grab; }
    .shell.dragging .summary { cursor: grabbing; }
    .summary:focus-visible {
      outline: none;
    }
    .summary:focus-visible .dot-wrap {
      filter: drop-shadow(0 0 6px rgba(126, 191, 246, .72));
    }
    .shell.open .summary {
      padding-right: 16px;
      background: rgba(10, 22, 34, .91);
      box-shadow:
        0 10px 28px rgba(0, 6, 13, .42),
        inset 0 0 0 1px rgba(224, 239, 250, .22);
      backdrop-filter: blur(18px) saturate(120%);
      -webkit-backdrop-filter: blur(18px) saturate(120%);
    }
    .dot-wrap {
      position: relative;
      flex: 0 0 38px;
      width: 38px;
      height: 38px;
      display: grid;
      place-items: center;
    }
    .dot-wrap::before,
    .dot-wrap::after {
      content: "";
      position: absolute;
      inset: 2px;
      border: 1px solid color-mix(in srgb, var(--state) 70%, transparent);
      border-radius: 50%;
      opacity: 0;
      transform: scale(.48);
    }
    .shell[data-state="discovering_lan"] .dot-wrap::before,
    .shell[data-state="connecting_wan"] .dot-wrap::before {
      animation: axiver-pulse 1.55s cubic-bezier(.2,.7,.2,1) infinite;
    }
    .shell[data-state="discovering_lan"] .dot-wrap::after,
    .shell[data-state="connecting_wan"] .dot-wrap::after {
      animation: axiver-pulse 1.55s .72s cubic-bezier(.2,.7,.2,1) infinite;
    }
    .dot {
      position: relative;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--state);
      box-shadow: 0 0 0 4px var(--state-soft), 0 0 15px var(--state-soft);
      transition: background 260ms ease, box-shadow 260ms ease;
    }
    .shell[data-state="lan"] .dot {
      width: 15px;
      height: 15px;
      padding: 3px;
      background: conic-gradient(from 12deg, #fa5e76, #ffcc5c, #63db9a, #62c8ff, #9877ff, #fa5e76);
      box-shadow: 0 0 0 4px rgba(119, 184, 255, .11), 0 0 14px rgba(120, 221, 255, .32);
      animation: axiver-rainbow 3.4s linear infinite;
    }
    .shell[data-state="lan"] .dot::after {
      content: "";
      position: absolute;
      inset: 3px;
      border-radius: 50%;
      background: #213248;
    }
    .summary-copy {
      display: grid;
      grid-template-columns: minmax(0, auto);
      gap: 1px;
      max-width: 0;
      opacity: 0;
      overflow: hidden;
      white-space: nowrap;
      transition:
        max-width 380ms cubic-bezier(.22, 1, .36, 1),
        opacity 180ms ease;
    }
    .shell.open .summary-copy {
      max-width: 470px;
      opacity: 1;
      transition-delay: 55ms;
    }
    .summary-title {
      font-size: 18px;
      line-height: 24px;
      font-weight: 680;
      letter-spacing: .01em;
      color: #ffffff;
      text-shadow: 0 1px 3px rgba(0, 0, 0, .72);
    }
    .summary-detail {
      display: none;
      max-width: 420px;
      color: rgba(220, 232, 242, .66);
      font-size: 10px;
      line-height: 12px;
      text-overflow: ellipsis;
      overflow: hidden;
    }
    .panel {
      width: min(560px, calc(100vw - 16px));
      margin-top: 10px;
      padding: 16px;
      border: 1px solid rgba(224, 239, 250, .48);
      border-radius: 20px;
      background:
        linear-gradient(145deg, rgba(32, 49, 67, .94), rgba(10, 22, 34, .96));
      box-shadow:
        0 24px 58px rgba(0, 7, 14, .52),
        inset 0 1px rgba(255, 255, 255, .22);
      backdrop-filter: blur(28px) saturate(130%);
      -webkit-backdrop-filter: blur(28px) saturate(130%);
      transform: translateY(-8px) scale(.975);
      transform-origin: top left;
      opacity: 0;
      visibility: hidden;
      transition:
        transform 320ms cubic-bezier(.22, 1, .36, 1),
        opacity 220ms ease,
        visibility 0s linear 320ms;
    }
    .shell.open .panel {
      transform: translateY(0) scale(1);
      opacity: 1;
      visibility: visible;
      transition-delay: 20ms, 20ms, 0s;
    }
    .action,
    .setting {
      width: 100%;
      border: 0;
      border-radius: 12px;
      color: #ffffff;
      background: rgba(218, 235, 248, .13);
      box-shadow: inset 0 0 0 1px rgba(229, 241, 250, .16);
      transition: background 170ms ease, box-shadow 170ms ease, transform 170ms ease;
    }
    .action {
      height: 58px;
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 0 18px;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .action:hover,
    .setting:focus-within {
      background: rgba(224, 239, 250, .21);
      box-shadow: inset 0 0 0 1px rgba(235, 245, 252, .28);
    }
    .action:active { transform: scale(.99); }
    .action strong,
    .setting label {
      font-size: 16px;
      font-weight: 650;
      letter-spacing: .01em;
      color: #ffffff;
      text-shadow: 0 1px 3px rgba(0, 0, 0, .72);
    }
    .setting {
      min-height: 66px;
      margin-top: 8px;
      padding: 13px 16px;
      display: grid;
      grid-template-columns: minmax(165px, .9fr) minmax(190px, 1.1fr);
      align-items: center;
      column-gap: 14px;
    }
    .setting-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 18px;
      margin-bottom: 0;
    }
    .saved {
      color: #a7d9ff;
      font-size: 10px;
      opacity: 0;
      transform: translateY(2px);
      transition: opacity 170ms ease, transform 170ms ease;
    }
    .saved.show {
      opacity: 1;
      transform: translateY(0);
    }
    input {
      width: 100%;
      height: 38px;
      padding: 0 11px;
      border: 1px solid rgba(224, 239, 250, .32);
      border-radius: 8px;
      outline: none;
      color: #ffffff;
      background: rgba(4, 13, 22, .62);
      font: 560 14px/1 "Segoe UI Variable", "Microsoft YaHei UI", sans-serif;
      transition: border-color 170ms ease, background 170ms ease, box-shadow 170ms ease;
    }
    input:focus {
      border-color: rgba(134, 204, 255, .88);
      background: rgba(3, 12, 21, .82);
      box-shadow: 0 0 0 3px rgba(79, 160, 229, .2);
    }
    input.invalid {
      border-color: rgba(255, 113, 113, .7);
      box-shadow: 0 0 0 3px rgba(255, 92, 92, .12);
    }
    .hint {
      display: none;
      min-height: 13px;
      padding: 7px 3px 1px;
      color: rgba(217, 229, 239, .55);
      font-size: 10px;
      line-height: 13px;
    }
    .ui-icon {
      width: 25px;
      height: 25px;
      flex: 0 0 25px;
      opacity: 1;
      filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .78));
    }
    .setting-head label {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    @media (max-width: 700px) {
      :host {
        top: 8px;
        left: 8px;
      }
      .shell.open,
      .panel {
        width: min(420px, calc(100vw - 16px));
      }
      .setting {
        grid-template-columns: 1fr;
        row-gap: 8px;
      }
    }
    @keyframes axiver-pulse {
      0% { opacity: .72; transform: scale(.46); }
      76%, 100% { opacity: 0; transform: scale(1.28); }
    }
    @keyframes axiver-rainbow {
      to { transform: rotate(360deg); }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: .01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: .01ms !important;
      }
    }
  `;

  const shell = document.createElement("div");
  shell.className = "shell open";
  shell.dataset.state = status.state;
  shell.innerHTML = `
    <button class="summary" type="button" aria-expanded="true" aria-label="打开 AXIVER 客户端菜单">
      <span class="dot-wrap"><span class="dot"></span></span>
      <span class="summary-copy">
        <span class="summary-title">${stateLabels[status.state]}</span>
        <span class="summary-detail">${status.detail}</span>
      </span>
    </button>
    <section class="panel" aria-label="AXIVER 客户端菜单">
      <button class="action refresh" type="button">
        <img class="ui-icon" src="${iconRefresh}" alt="" />
        <strong>刷新页面</strong>
      </button>
      <div class="setting">
        <div class="setting-head">
          <label for="axiver-broadcast">
            <img class="ui-icon" src="${iconRouter}" alt="" />
            局域广播名设置
          </label>
          <span class="saved broadcast-saved">已保存</span>
        </div>
        <input id="axiver-broadcast" autocomplete="off" maxlength="32" spellcheck="false" />
        <div class="hint broadcast-hint">1–32 位字母、数字、下划线或连字符</div>
      </div>
      <div class="setting">
        <div class="setting-head">
          <label for="axiver-wide">
            <img class="ui-icon" src="${iconGlobe}" alt="" />
            广域地址
          </label>
          <span class="saved wide-saved">已保存</span>
        </div>
        <input id="axiver-wide" inputmode="url" autocomplete="url" spellcheck="false" placeholder="https://example.com" />
        <div class="hint wide-hint">未发现局域网容器时自动回退</div>
      </div>
    </section>
  `;
  shadow.append(style, shell);

  const summary = shell.querySelector(".summary");
  const title = shell.querySelector(".summary-title");
  const detail = shell.querySelector(".summary-detail");
  const broadcastInput = shell.querySelector("#axiver-broadcast");
  const wideInput = shell.querySelector("#axiver-wide");
  const broadcastHint = shell.querySelector(".broadcast-hint");
  const wideHint = shell.querySelector(".wide-hint");

  const setOpen = (open) => {
    shell.classList.toggle("open", open);
    summary.setAttribute("aria-expanded", String(open));
    clearTimeout(collapseTimer);
    if (open) {
      scheduleCollapse(5200);
    }
  };

  const isEditing = () =>
    shadow.activeElement === broadcastInput || shadow.activeElement === wideInput;

  const scheduleCollapse = (delay = 900) => {
    clearTimeout(collapseTimer);
    collapseTimer = window.setTimeout(() => {
      if (!pointerInside && !isEditing()) {
        setOpen(false);
      }
    }, delay);
  };

  const nativeAction = (path, parameters = {}) => {
    if (window.__AXIVER_PREVIEW__) return;
    const url = new URL(`https://${"axiver-client.invalid"}/__native/${path}`);
    Object.entries(parameters).forEach(([key, value]) => url.searchParams.set(key, value));
    window.location.assign(url.toString());
  };

  const applyPosition = (left, top) => {
    const maxLeft = Math.max(4, window.innerWidth - 42);
    const maxTop = Math.max(4, window.innerHeight - 42);
    const nextLeft = Math.min(maxLeft, Math.max(4, Number(left) || 4));
    const nextTop = Math.min(maxTop, Math.max(4, Number(top) || 4));
    host.style.left = `${nextLeft}px`;
    host.style.top = `${nextTop}px`;
    return { left: nextLeft, top: nextTop };
  };

  const showSaved = (element) => {
    clearTimeout(savedTimer);
    element.classList.add("show");
    savedTimer = window.setTimeout(() => element.classList.remove("show"), 1700);
  };

  const saveSettings = (source) => {
    const broadcast = broadcastInput.value.trim().toUpperCase();
    const wide = wideInput.value.trim();
    const broadcastValid = /^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(broadcast);
    let wideValid = wide === "";
    if (wide) {
      try {
        const parsed = new URL(wide);
        wideValid = parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch (_) {
        wideValid = false;
      }
    }
    broadcastInput.classList.toggle("invalid", !broadcastValid);
    wideInput.classList.toggle("invalid", !wideValid);
    broadcastHint.textContent = broadcastValid
      ? "1–32 位字母、数字、下划线或连字符"
      : "请输入有效广播名";
    wideHint.textContent = wideValid
      ? "未发现局域网容器时自动回退"
      : "请输入完整的 HTTP 或 HTTPS 地址";
    if (!broadcastValid || !wideValid) return;

    broadcastInput.value = broadcast;
    broadcastDirty = false;
    wideDirty = false;
    showSaved(
      source === "broadcast"
        ? shell.querySelector(".broadcast-saved")
        : shell.querySelector(".wide-saved")
    );
    nativeAction("settings", { broadcast, wide });
  };

  summary.addEventListener("mousedown", (event) => {
    if (shell.classList.contains("open") || event.button !== 0) {
      dragState = null;
      return;
    }
    const bounds = host.getBoundingClientRect();
    dragState = {
      startX: event.clientX,
      startY: event.clientY,
      left: bounds.left,
      top: bounds.top,
      moved: false
    };
    clearTimeout(collapseTimer);
  });
  window.addEventListener("mousemove", (event) => {
    if (!dragState) return;
    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;
    if (!dragState.moved && Math.hypot(deltaX, deltaY) < 4) return;
    dragState.moved = true;
    shell.classList.add("dragging");
    applyPosition(dragState.left + deltaX, dragState.top + deltaY);
    event.preventDefault();
  });
  const finishDrag = () => {
    if (!dragState) return;
    const moved = dragState.moved;
    dragState = null;
    shell.classList.remove("dragging");
    if (moved) {
      suppressClickUntil = performance.now() + 450;
      const bounds = host.getBoundingClientRect();
      const position = applyPosition(bounds.left, bounds.top);
      nativeAction("position", {
        left: Math.round(position.left),
        top: Math.round(position.top)
      });
    }
  };
  window.addEventListener("mouseup", finishDrag, true);
  window.addEventListener("blur", finishDrag);
  summary.addEventListener("click", (event) => {
    if (performance.now() < suppressClickUntil) {
      event.preventDefault();
      return;
    }
    setOpen(!shell.classList.contains("open"));
  });
  shell.addEventListener("pointerenter", () => {
    pointerInside = true;
    clearTimeout(collapseTimer);
  });
  shell.addEventListener("pointerleave", () => {
    pointerInside = false;
    scheduleCollapse();
  });
  shell.querySelector(".refresh").addEventListener("click", () => {
    const next = status.state === "lan" ? "connecting_lan" : "connecting_wan";
    window.__AXIVER_CLIENT__.setStatus({
      state: next,
      detail: status.state === "lan" ? "正在连接局域网容器" : "正在连接广域地址",
      url: status.url
    });
    window.location.reload();
  });
  broadcastInput.addEventListener("change", () => saveSettings("broadcast"));
  wideInput.addEventListener("change", () => saveSettings("wide"));
  broadcastInput.addEventListener("input", () => {
    broadcastDirty = true;
    broadcastInput.classList.remove("invalid");
  });
  wideInput.addEventListener("input", () => {
    wideDirty = true;
    wideInput.classList.remove("invalid");
  });
  [broadcastInput, wideInput].forEach((input) => {
    input.addEventListener("focus", () => clearTimeout(collapseTimer));
    input.addEventListener("blur", () => scheduleCollapse(1800));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        input.blur();
      }
      if (event.key === "Escape") {
        input.blur();
        setOpen(false);
      }
    });
  });

  window.__AXIVER_CLIENT__ = {
    setStatus(next) {
      status = { ...status, ...next };
      shell.dataset.state = status.state;
      title.textContent = stateLabels[status.state] || status.detail || "AXIVER";
      detail.textContent = status.detail || status.url || "";
      if (status.state === "lan" || status.state === "wan") {
        scheduleCollapse(2600);
      }
    },
    syncSettings(next) {
      if (
        next &&
        typeof next.broadcastName === "string" &&
        !broadcastDirty &&
        shadow.activeElement !== broadcastInput
      ) {
        broadcastInput.value = next.broadcastName;
      }
      if (
        next &&
        typeof next.wideUrl === "string" &&
        !wideDirty &&
        shadow.activeElement !== wideInput
      ) {
        wideInput.value = next.wideUrl;
      }
    },
    setPosition(next) {
      if (next && Number.isFinite(next.left) && Number.isFinite(next.top)) {
        applyPosition(next.left, next.top);
      }
    },
    open() {
      setOpen(true);
    }
  };

  window.__AXIVER_CLIENT__.syncSettings(bootstrap);
  const mount = () => {
    if (!document.documentElement.contains(host)) {
      (document.body || document.documentElement).appendChild(host);
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
