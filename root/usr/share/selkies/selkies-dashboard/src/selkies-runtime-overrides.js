(function () {
  "use strict";

  var runtime = window.__SELKIES_RUNTIME__ || {};
  var VAAPI_ENCODER_HINTS = new Set(["vaapih264enc"]);
  var CPU_ONLY_ENCODERS = new Set(["jpeg", "x264enc-striped"]);
  var STABLE_ENCODERS = new Set(["x264enc", "x264enc-striped", "jpeg"]);
  var FALLBACK_ENCODER = "x264enc";
  var badgeRefreshTimer = null;
  var lastServerUseCpu = null;
  var streamRecoverTimer = null;
  var waitingSinceMs = 0;
  var lastVideoPipelineActive = true;
  var STREAM_WAIT_THRESHOLD_MS = sanitizeInt(runtime.streamWaitThresholdMs, 35000, 10000, 300000);
  var STREAM_STALL_THRESHOLD_MS = sanitizeInt(runtime.streamStallThresholdMs, 12000, 4000, 120000);
  var STREAM_STALL_RESTART_LIMIT = sanitizeInt(runtime.streamStallRestartLimit, 2, 1, 5);
  var STREAM_RECOVER_COOLDOWN_MS = sanitizeInt(runtime.streamRecoverCooldownMs, 120000, 30000, 600000);
  var WS_SESSION_ID = "sid_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  var WS_SESSION_EPOCH = Date.now();
  var GAMEPAD_UI_ENABLED = sanitizeBool(runtime.gamepadUiEnabled, sanitizeBool(runtime.defaultGamepadEnabled, false));
  var LOCAL_LINK_OPEN_ENABLED = sanitizeBool(runtime.localLinkOpenEnabled, true);
  var LOCAL_LINK_POLL_INTERVAL_MS = sanitizeInt(runtime.localLinkPollIntervalMs, 800, 300, 10000);
  var LOCAL_LINK_AUTO_CLOSE_MS = 15000;
  var LOCAL_LINK_HISTORY_LIMIT = 100;
  var localLinkHistoryKey = "local_link_history_v1";
  var localLinkCursorKey = "local_link_cursor_v1";
  var localLinkCursor = parseTimestamp(getStoredValue(localLinkCursorKey));
  var localLinkPollTimer = null;
  var localLinkPromptTimer = null;
  var localLinkPendingEvent = null;
  var localLinkHistoryMountTimer = null;
  var pendingRemoteClipboardPull = null;
  var imeFocusTimer = null;
  var imeCompositionActive = false;
  var clipboardSyncBurstTimerIds = [];
  var activeDataSockets = [];
  var lastClipboardTriggerAt = 0;
  var streamRestartTimer = null;
  var lastUiInteractionAt = Date.now();
  var activityTasks = Object.create(null);
  var activityRenderTimer = null;
  var activityHeartbeatTimer = null;
  var dynamicLatencyMountTimer = null;
  var dynamicLatencyTimer = null;
  var dynamicLatencyApplied = false;
  var dynamicLatencyUntil = 0;
  var dynamicLatencySuppressedUntil = Date.now() + 2500;
  var dynamicLatencyOriginals = null;
  var dynamicLatencyInteractionAt = 0;
  var lastDynamicLatencyConfigSignature = "";
  var sidebarToggleIndicatorTimer = null;
  var lastFrameProgressAt = 0;
  var streamRecoveryStage = 0;
  var streamRecoveryInFlight = false;
  var frameTrackerBindTimer = null;
  var highLoadReleaseTimer = null;
  var streamRestartVerifyTimer = null;
  var highLoadStateMap = Object.create(null);
  var highLoadBusyUntil = 0;
  var pipelineResetNoticeTimer = null;
  var encoderResetTimerIds = [];
  var sidebarAutoCollapseLockUntil = 0;
  var pageAwakeHeartbeatTimer = null;
  var idleCleanupTimer = null;
  var lastIdleCleanupAt = 0;
  var lastFrontendInteractionAt = Date.now();
  var BASE_BRAND_TITLE = "AXi-SNS-Box";
  var notificationCursorKey = "notification_cursor_v1";
  var notificationCursor = parseTimestamp(getStoredValue(notificationCursorKey));
  var notificationPollTimer = null;
  var unreadTitleFlashTimer = null;
  var unreadTitleFlashPhase = false;
  var unreadIconFlashTimer = null;
  var unreadIconFlashPhase = false;
  var defaultDocumentIconHref = "";
  var pendingPassthroughEvents = [];
  var passthroughIdleTimer = null;
  var pendingUnreadClearApp = "";
  var pendingUnreadClearExpiresAt = 0;
  var activeUnreadClearRequest = null;
  var activeUnreadClearLastAt = 0;
  var qqUnread = false;
  var wechatUnread = false;
  var notificationPassthroughEnabled = sanitizeBool(getStoredValue("notification_passthrough_enabled"), false);
  var qqIdleBlurSeconds = sanitizeInt(getStoredValue("qq_idle_blur_seconds"), 600, 0, 1800);
  var lastNotificationActivityReportAt = 0;
  var bottomActionDockTimer = null;
  var bottomActionSplitOpen = false;
  var bottomActionDockCollapsed = sanitizeBool(getStoredValue("bottom_action_dock_collapsed"), false);
  var bottomActionDockRestoreTimer = null;
  var managedFileTransfers = Object.create(null);
  var fileTransferSockets = typeof WeakMap === "function" ? new WeakMap() : null;
  var debugNotificationTargetAt = 0;
  var debugNotificationTimeout = null;
  var debugNotificationInterval = null;
  var debugWechatAudioTargetAt = 0;
  var debugWechatAudioTimeout = null;
  var debugWechatAudioInterval = null;
  var modifierGestureState = {
    clientToRemote: { down: false, chorded: false, lastTapAt: 0, lastTriggerAt: 0, holdTimer: null },
    remoteToClient: { down: false, chorded: false, lastTapAt: 0, lastTriggerAt: 0, holdTimer: null }
  };

  function authBasePath() {
    var path = String(window.location.pathname || "/");
    if (!path.endsWith("/")) {
      var slash = path.lastIndexOf("/");
      path = slash >= 0 ? path.slice(0, slash + 1) : "/";
    }
    return path + "auth/";
  }

  function appBasePath() {
    return authBasePath().replace(/auth\/$/, "");
  }

  function forcePinLogin() {
    var base = authBasePath();
    var logoutUrl = base + "logout";
    var landingUrl = appBasePath();

    var redirect = function () {
      window.location.href = landingUrl;
    };

    try {
      window
        .fetch(logoutUrl, {
          method: "POST",
          credentials: "same-origin",
          headers: { "X-Requested-With": "XMLHttpRequest" },
          cache: "no-store"
        })
        .finally(redirect);
    } catch (_err) {
      redirect();
    }
  }

  function withSessionIdentity(url) {
    var raw = String(url || "");
    var sid = encodeURIComponent(WS_SESSION_ID);
    var epoch = encodeURIComponent(String(WS_SESSION_EPOCH));
    try {
      var parsed = new URL(raw, window.location.href);
      parsed.searchParams.set("selkies_session_id", WS_SESSION_ID);
      parsed.searchParams.set("selkies_session_epoch", String(WS_SESSION_EPOCH));
      return parsed.toString();
    } catch (_err) {
      var joiner = raw.indexOf("?") >= 0 ? "&" : "?";
      return raw + joiner + "selkies_session_id=" + sid + "&selkies_session_epoch=" + epoch;
    }
  }

  function installSingleSessionWebSocketGuard() {
    var NativeWebSocket = window.WebSocket;
    if (!NativeWebSocket || NativeWebSocket.__selkiesSingleSessionWrapped) return;

    var WrappedWebSocket = function (url, protocols) {
      var wsUrl = withSessionIdentity(url);
      var ws =
        typeof protocols === "undefined"
          ? new NativeWebSocket(wsUrl)
          : new NativeWebSocket(wsUrl, protocols);

      ws.addEventListener("message", function (event) {
        if (!event || event.data !== "FORCE_PIN_LOGIN") return;
        try {
          ws.close(4002, "single-session takeover");
        } catch (_closeErr) {}
        forcePinLogin();
      });
      activeDataSockets.push(ws);
      ws.addEventListener("close", function () {
        activeDataSockets = activeDataSockets.filter(function (item) {
          return item !== ws;
        });
      });
      ws.addEventListener("close", function (event) {
        var code = event && typeof event.code === "number" ? event.code : 0;
        var reason = String((event && event.reason) || "").toLowerCase();
        if (
          code === 4002 ||
          code === 4003 ||
          reason.indexOf("replaced by a new client session") >= 0 ||
          reason.indexOf("stale session epoch") >= 0
        ) {
          forcePinLogin();
        }
      });
      return ws;
    };

    WrappedWebSocket.prototype = NativeWebSocket.prototype;
    WrappedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
    WrappedWebSocket.OPEN = NativeWebSocket.OPEN;
    WrappedWebSocket.CLOSING = NativeWebSocket.CLOSING;
    WrappedWebSocket.CLOSED = NativeWebSocket.CLOSED;
    WrappedWebSocket.__selkiesSingleSessionWrapped = true;
    window.WebSocket = WrappedWebSocket;
  }

  function sendRawDataCommand(command) {
    var message = String(command || "");
    if (!message) return false;
    var sent = false;
    activeDataSockets.forEach(function (socket) {
      if (!socket || socket.readyState !== window.WebSocket.OPEN) return;
      try {
        socket.send(message);
        sent = true;
      } catch (_err) {}
    });
    return sent;
  }

  function hasOpenDataSocket() {
    for (var i = 0; i < activeDataSockets.length; i += 1) {
      var socket = activeDataSockets[i];
      if (socket && socket.readyState === window.WebSocket.OPEN) {
        return true;
      }
    }
    return false;
  }

  function getIdleCleanupThresholdMs() {
    var minutes = sanitizeInt(runtime.idleCleanupMinutes, 20, 5, 240);
    return minutes * 60 * 1000;
  }

  function isClientPageAwake() {
    if (document.hidden) return false;
    if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
    if (!hasOpenDataSocket()) return false;
    return true;
  }

  function reportClientAwakeState(forceState) {
    var active = typeof forceState === "boolean" ? forceState : isClientPageAwake();
    sendRawDataCommand("CLIENT_AWAKE_STATE," + (active ? "1" : "0"));
  }

  function sendDynamicLatencyState(active, source) {
    var config = getDynamicLatencyConfig();
    var payload = [
      "LOW_LATENCY_STATE",
      active ? "1" : "0",
      source || "interaction",
      String(config.fps),
      String(config.crf),
      String(config.samplePercent),
      config.disablePaintOver ? "1" : "0"
    ].join(",");
    sendRawDataCommand(payload);
  }

  function isTransportBusy() {
    return Object.keys(highLoadStateMap).length > 0 || Date.now() < highLoadBusyUntil;
  }

  function updateTransportBusyTask() {
    if (!isTransportBusy()) {
      removeActivityTask("transport-busy");
      return;
    }
    var sources = Object.keys(highLoadStateMap);
    var phase = sources.length ? sources.join(" / ") : "\u9ad8\u8d1f\u8f7d\u4f20\u8f93";
    setActivityTask("transport-busy", {
      title: "\u6b63\u5728\u7c98\u8d34/\u4e0a\u4f20\u5185\u5bb9",
      detail: "\u5df2\u5207\u6362\u4e3a\u4f4e\u5e72\u6270\u4f20\u8f93\u6a21\u5f0f\uff0c\u4f1a\u4f18\u5148\u4fdd\u969c\u8f93\u5165\uff0c\u753b\u9762\u53ef\u80fd\u77ed\u6682\u964d\u901f\u6216\u505c\u987f\u3002",
      phase: phase,
      kind: "info",
      progress: null,
      indeterminate: true,
      priority: 98,
      startedAt: Date.now()
    });
  }

  function setHighLoadState(active, source) {
    var key = String(source || "ui");
    if (active) {
      highLoadStateMap[key] = Date.now();
      highLoadBusyUntil = Math.max(highLoadBusyUntil, Date.now() + 16000);
    } else {
      delete highLoadStateMap[key];
      highLoadBusyUntil = Object.keys(highLoadStateMap).length ? Math.max(highLoadBusyUntil, Date.now() + 900) : 0;
    }
    updateTransportBusyTask();
    sendRawDataCommand(["HIGH_LOAD_STATE", active ? "1" : "0", key].join(","));
  }

  function clearAllHighLoadState(source) {
    var keys = Object.keys(highLoadStateMap);
    highLoadStateMap = Object.create(null);
    highLoadBusyUntil = 0;
    if (highLoadReleaseTimer) {
      window.clearTimeout(highLoadReleaseTimer);
      highLoadReleaseTimer = null;
    }
    updateTransportBusyTask();
    for (var i = 0; i < keys.length; i += 1) {
      sendRawDataCommand(["HIGH_LOAD_STATE", "0", keys[i]].join(","));
    }
    sendRawDataCommand(["HIGH_LOAD_STATE", "0", String(source || "repair-reset")].join(","));
  }

  function scheduleHighLoadRelease(source, delayMs) {
    if (highLoadReleaseTimer) {
      window.clearTimeout(highLoadReleaseTimer);
    }
    highLoadReleaseTimer = window.setTimeout(function () {
      highLoadReleaseTimer = null;
      setHighLoadState(false, source || "auto-release");
    }, Math.max(400, delayMs || 1600));
  }

  function noteUiInteraction() {
    lastUiInteractionAt = Date.now();
  }

  function clearWechatAudioDebugTimer() {
    if (debugWechatAudioTimeout) {
      window.clearTimeout(debugWechatAudioTimeout);
      debugWechatAudioTimeout = null;
    }
    if (debugWechatAudioInterval) {
      window.clearInterval(debugWechatAudioInterval);
      debugWechatAudioInterval = null;
    }
    debugWechatAudioTargetAt = 0;
  }

  function clearNotificationDebugTimer() {
    if (debugNotificationTimeout) {
      window.clearTimeout(debugNotificationTimeout);
      debugNotificationTimeout = null;
    }
    if (debugNotificationInterval) {
      window.clearInterval(debugNotificationInterval);
      debugNotificationInterval = null;
    }
    debugNotificationTargetAt = 0;
  }

  function noteFrontendInteraction() {
    lastFrontendInteractionAt = Date.now();
    reportFrontendInteractionState(false);
    if (passthroughIdleTimer) {
      window.clearTimeout(passthroughIdleTimer);
      passthroughIdleTimer = null;
    }
  }

  function clearPendingUnreadClearState() {
    pendingUnreadClearApp = "";
    pendingUnreadClearExpiresAt = 0;
  }

  function isFrontendIdleForPassthrough() {
    return Date.now() - lastFrontendInteractionAt >= 5000;
  }

  function flushPassthroughNotifications() {
    if (passthroughIdleTimer) {
      window.clearTimeout(passthroughIdleTimer);
      passthroughIdleTimer = null;
    }
    if (!notificationPassthroughEnabled) {
      pendingPassthroughEvents = [];
      return;
    }
    if (!isFrontendIdleForPassthrough()) {
      schedulePassthroughFlush();
      return;
    }
    if (!pendingPassthroughEvents.length) return;
    var queue = pendingPassthroughEvents.slice();
    pendingPassthroughEvents = [];
    for (var i = 0; i < queue.length; i += 1) {
      showBrowserNotificationForEvent(queue[i], true);
    }
  }

  function schedulePassthroughFlush() {
    if (!notificationPassthroughEnabled) return;
    if (!pendingPassthroughEvents.length) return;
    if (passthroughIdleTimer) {
      window.clearTimeout(passthroughIdleTimer);
      passthroughIdleTimer = null;
    }
    var elapsed = Date.now() - lastFrontendInteractionAt;
    var delay = Math.max(0, 5000 - elapsed);
    passthroughIdleTimer = window.setTimeout(function () {
      passthroughIdleTimer = null;
      flushPassthroughNotifications();
    }, delay);
  }

  function queuePassthroughNotification(event) {
    if (!event) return;
    pendingPassthroughEvents.push(event);
    if (isFrontendIdleForPassthrough()) {
      flushPassthroughNotifications();
      return;
    }
    schedulePassthroughFlush();
  }

  function notificationApiPath(pathSuffix) {
    var base = appBasePath();
    if (!base.endsWith("/")) {
      base += "/";
    }
    return base + "api/notifications/" + String(pathSuffix || "").replace(/^\/+/, "");
  }

  function reportFrontendInteractionState(force) {
    if (!window.fetch) return;
    var now = Date.now();
    if (!force && now - lastNotificationActivityReportAt < 900) return;
    lastNotificationActivityReportAt = now;
    window.fetch(notificationApiPath("activity"), {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest"
      },
      body: JSON.stringify({ ts: now })
    }).catch(function () {});
  }

  function getUnreadTitleText() {
    if (wechatUnread && qqUnread) return "【未读*微信与QQ】" + BASE_BRAND_TITLE;
    if (wechatUnread) return "【未读*微信】" + BASE_BRAND_TITLE;
    if (qqUnread) return "【未读*QQ】" + BASE_BRAND_TITLE;
    return BASE_BRAND_TITLE;
  }

  function appIconUrl(app) {
    var fileName = app === "wechat" ? "wechat-icon.png" : "qq-icon.png";
    try {
      return new URL(fileName, window.location.href).toString();
    } catch (_err) {
      return fileName;
    }
  }

  function getDefaultDocumentIconHref() {
    if (defaultDocumentIconHref) return defaultDocumentIconHref;
    var link = document.querySelector("link[rel*='icon'],link[rel='apple-touch-icon']");
    var href = "";
    if (link) {
      href = String(link.getAttribute("href") || link.href || "").trim();
    }
    defaultDocumentIconHref = href || appIconUrl("qq");
    return defaultDocumentIconHref;
  }

  function getUnreadIconHref() {
    if (wechatUnread && qqUnread) {
      return unreadIconFlashPhase ? appIconUrl("wechat") : appIconUrl("qq");
    }
    if (wechatUnread) {
      return unreadIconFlashPhase ? appIconUrl("wechat") : getDefaultDocumentIconHref();
    }
    if (qqUnread) {
      return unreadIconFlashPhase ? appIconUrl("qq") : getDefaultDocumentIconHref();
    }
    return getDefaultDocumentIconHref();
  }

  function setDocumentIconHref(href) {
    var links = Array.prototype.slice.call(document.querySelectorAll("link[rel*='icon'],link[rel='apple-touch-icon']"));
    for (var i = 0; i < links.length; i += 1) {
      links[i].setAttribute("href", href);
    }
  }

  function syncUnreadDocumentTitle() {
    var unreadTitle = getUnreadTitleText();
    if (!wechatUnread && !qqUnread) {
      if (unreadTitleFlashTimer) {
        window.clearInterval(unreadTitleFlashTimer);
        unreadTitleFlashTimer = null;
      }
      if (unreadIconFlashTimer) {
        window.clearInterval(unreadIconFlashTimer);
        unreadIconFlashTimer = null;
      }
      unreadTitleFlashPhase = false;
      unreadIconFlashPhase = false;
      document.title = BASE_BRAND_TITLE;
      setDocumentIconHref(getDefaultDocumentIconHref());
      return;
    }
    if (!unreadTitleFlashTimer) {
      document.title = unreadTitle;
      unreadTitleFlashTimer = window.setInterval(function () {
        unreadTitleFlashPhase = !unreadTitleFlashPhase;
        document.title = unreadTitleFlashPhase ? unreadTitle : BASE_BRAND_TITLE;
      }, 900);
    }
    if (!unreadIconFlashTimer) {
      setDocumentIconHref(getUnreadIconHref());
      unreadIconFlashTimer = window.setInterval(function () {
        unreadIconFlashPhase = !unreadIconFlashPhase;
        setDocumentIconHref(getUnreadIconHref());
      }, 900);
    }
    document.title = unreadTitleFlashPhase ? unreadTitle : BASE_BRAND_TITLE;
    setDocumentIconHref(getUnreadIconHref());
  }

  function syncUnreadDockState() {
    var shell = document.getElementById("selkies-bottom-action-dock-shell");
    if (!shell) return;
    var wechatButton = shell.querySelector('[data-dock-action="wechat-focus"]');
    var qqButton = shell.querySelector('[data-dock-action="qq-focus"]');
    if (wechatButton) {
      wechatButton.setAttribute("data-unread", wechatUnread ? "1" : "0");
    }
    if (qqButton) {
      qqButton.setAttribute("data-unread", qqUnread ? "1" : "0");
    }
    syncUnreadDocumentTitle();
  }

  function setUnreadState(app, unread) {
    if (app === "wechat") {
      wechatUnread = !!unread;
    } else if (app === "qq") {
      qqUnread = !!unread;
    }
    syncUnreadDockState();
  }

  function requestBrowserNotificationPermission() {
    if (typeof window.Notification === "undefined" || typeof window.Notification.requestPermission !== "function") {
      return Promise.resolve("denied");
    }
    return window.Notification.requestPermission();
  }

  function focusUnreadApp(app) {
    if (app === "wechat") {
      requestAppFocus("wechat");
      return;
    }
    if (app === "qq") {
      requestAppFocus("qq");
    }
  }

  function requestAppFocus(app) {
    var targetApp = String(app || "").toLowerCase();
    if (targetApp !== "wechat" && targetApp !== "qq") {
      return Promise.resolve({ ok: false, app: targetApp, focused: false, error: "invalid app" });
    }
    clearPendingUnreadClearState();
    noteUiInteraction();
    return window
      .fetch(notificationApiPath("focus"), {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest"
        },
        body: JSON.stringify({ app: targetApp })
      })
      .then(function (response) {
        if (!response.ok) throw new Error("focus request failed");
        return response.json();
      })
      .then(function (payload) {
        if (payload && payload.ok && payload.focused) {
          pendingUnreadClearApp = targetApp;
          pendingUnreadClearExpiresAt = Date.now() + 15000;
        }
        return payload;
      })
      .catch(function () {
        return { ok: false, app: targetApp, focused: false, error: "focus request failed" };
      });
  }

  function shouldSkipUnreadClearEvent(event) {
    if (!event || !event.target || !event.target.closest) return false;
    if (event.target.closest("#selkies-bottom-action-dock-shell")) return true;
    if (event.target.closest("#selkies-activity-layer")) return true;
    if (event.target.closest("#selkies-local-link-prompt")) return true;
    if (event.target.closest("#selkies-link-history-section")) return true;
    if (event.target.closest(".selkies-link-sidebar")) return true;
    if (isFormLikeElement(event.target)) return true;
    return false;
  }

  function fetchActiveRemoteApp() {
    return window
      .fetch(notificationApiPath("active-app"), {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "X-Requested-With": "XMLHttpRequest" }
      })
      .then(function (response) {
        if (!response.ok) throw new Error("active app request failed");
        return response.json();
      })
      .catch(function () {
        return { ok: false, focused: false, app: "other" };
      });
  }

  function clearUnreadFromActiveRemoteApp() {
    if (!(wechatUnread || qqUnread)) return;
    if (activeUnreadClearRequest) return;
    var now = Date.now();
    if (now - activeUnreadClearLastAt < 250) return;
    activeUnreadClearLastAt = now;
    activeUnreadClearRequest = fetchActiveRemoteApp()
      .then(function (payload) {
        var app = String(payload && payload.app || "").toLowerCase();
        if (app !== "wechat" && app !== "qq") return;
        if (app === "wechat" && !wechatUnread) return;
        if (app === "qq" && !qqUnread) return;
        setUnreadState(app, false);
        if (pendingUnreadClearApp === app) {
          clearPendingUnreadClearState();
        }
      })
      .finally(function () {
        activeUnreadClearRequest = null;
      });
  }

  function clearUnreadOnPrimaryInteraction(event) {
    if (!(pendingUnreadClearApp || wechatUnread || qqUnread)) return;
    if (pendingUnreadClearExpiresAt && Date.now() > pendingUnreadClearExpiresAt) {
      clearPendingUnreadClearState();
    }
    if (!hasVisibleStreamSurface()) return;
    if (shouldSkipUnreadClearEvent(event)) return;
    if (pendingUnreadClearApp) {
      setUnreadState(pendingUnreadClearApp, false);
      clearPendingUnreadClearState();
      return;
    }
    clearUnreadFromActiveRemoteApp();
  }

  function showBrowserNotificationForEvent(event, force) {
    if (!force && !notificationPassthroughEnabled) return;
    if (typeof window.Notification === "undefined" || window.Notification.permission !== "granted") return;
    var app = String(event && event.app || "");
    if (app !== "wechat" && app !== "qq") return;
    var title = String(event.title || (app === "wechat" ? "微信新消息" : "QQ 新消息"));
    var body = String(event.body || "");
    var icon = appIconUrl(app);
    try {
      var notice = new window.Notification(title, {
        body: body,
        icon: icon,
        tag: app + "-message"
      });
      notice.onclick = function () {
        try {
          window.focus();
        } catch (_err) {}
        focusUnreadApp(app);
        try {
          notice.close();
        } catch (_closeErr) {}
      };
    } catch (_err2) {}
  }

  function showPassthroughBrowserNotification(event) {
    showBrowserNotificationForEvent(event, false);
  }

  function executePassthroughNotificationTest() {
    var candidates = [
      {
        app: "wechat",
        title: "微信测试消息",
        body: "这是一条随机生成的本地穿透提醒测试消息。"
      },
      {
        app: "qq",
        title: "QQ 测试消息",
        body: "这是一条随机生成的本地穿透提醒测试消息。"
      }
    ];
    var event = candidates[Math.floor(Math.random() * candidates.length)];
    requestBrowserNotificationPermission().then(function (permission) {
      if (permission !== "granted") {
        setActivityTask("notification-test", {
          title: "穿透式消息推送检测失败",
          detail: "浏览器未授予通知权限，无法执行本地推送测试。",
          kind: "warning",
          progress: null,
          indeterminate: true,
          priority: 78,
          expiresAt: Date.now() + 3600
        });
        return;
      }
      setUnreadState(event.app, true);
      if (notificationPassthroughEnabled) {
        queuePassthroughNotification(event);
      }
      setActivityTask("notification-test", {
        title: "穿透式消息推送检测完成",
        detail: "已发送一条 " + (event.app === "wechat" ? "微信" : "QQ") + " 本地通知测试消息。",
        kind: "success",
        progress: 100,
        indeterminate: false,
        priority: 72,
        expiresAt: Date.now() + 3200
      });
    });
  }

  function triggerPassthroughNotificationTest() {
    clearNotificationDebugTimer();
    debugNotificationTargetAt = Date.now() + 5000;
    setActivityTask("notification-test", {
      title: "穿透式消息推送检测已准备",
      detail: "10 秒后将发送一条随机本地通知测试消息。",
      kind: "info",
      progress: 1,
      indeterminate: false,
      priority: 74,
      startedAt: Date.now()
    });
    debugNotificationInterval = window.setInterval(function () {
      var remainingMs = Math.max(0, debugNotificationTargetAt - Date.now());
      var remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
      setActivityTask("notification-test", {
        title: "穿透式消息推送检测倒计时",
        detail: remainingSeconds + " 秒后发送一条随机本地通知测试消息。",
        kind: "info",
        progress: clamp(((5000 - remainingMs) / 5000) * 100, 1, 99),
        indeterminate: false,
        priority: 74,
        startedAt: Date.now()
      });
    }, 250);
    debugNotificationTimeout = window.setTimeout(function () {
      clearNotificationDebugTimer();
      executePassthroughNotificationTest();
    }, 5000);
  }

  function applyNotificationBridgeState(payload) {
    if (!payload || !payload.ok) return;
    var mode = String(payload.mode || "internal").toLowerCase();
    notificationPassthroughEnabled = mode === "passthrough";
    setStoredValue("notification_passthrough_enabled", notificationPassthroughEnabled);
    qqIdleBlurSeconds = sanitizeInt(payload.idle_focus_seconds, qqIdleBlurSeconds, 0, 1800);
    if ([0, 60, 300, 600, 1800].indexOf(qqIdleBlurSeconds) < 0) {
      qqIdleBlurSeconds = 600;
    }
    setStoredValue("qq_idle_blur_seconds", qqIdleBlurSeconds);
  }

  function loadNotificationBridgeState() {
    return window
      .fetch(notificationApiPath("state"), {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "X-Requested-With": "XMLHttpRequest" }
      })
      .then(function (response) {
        if (!response.ok) return null;
        return response.json();
      })
      .then(function (payload) {
        if (payload && payload.ok) {
          applyNotificationBridgeState(payload);
        }
        return payload;
      })
      .catch(function () {
        return null;
      });
  }

  function updateNotificationBridgeState(patch) {
    return window
      .fetch(notificationApiPath("state"), {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest"
        },
        body: JSON.stringify(patch || {})
      })
      .then(function (response) {
        if (!response.ok) throw new Error("notification bridge update failed");
        return response.json();
      })
      .then(function (payload) {
        applyNotificationBridgeState(payload);
        return payload;
      });
  }

  function applyNotificationEvents(events) {
    if (!Array.isArray(events) || !events.length) return;
    events.sort(function (a, b) {
      return parseTimestamp(a && a.id) - parseTimestamp(b && b.id);
    });
    for (var i = 0; i < events.length; i += 1) {
      var event = events[i] || {};
      var eventId = parseTimestamp(event.id);
      if (eventId > notificationCursor) {
        notificationCursor = eventId;
      }
      var app = String(event.app || "");
      if (app === "wechat" || app === "qq") {
        setUnreadState(app, true);
        if (notificationPassthroughEnabled) {
          queuePassthroughNotification(event);
        }
      }
    }
    setStoredValue(notificationCursorKey, notificationCursor);
  }

  function startNotificationEventPoller() {
    if (notificationPollTimer) return;
    reportFrontendInteractionState(true);
    loadNotificationBridgeState().finally(function () {
      syncUnreadDockState();
      renderDebugToolsSection();
    });
    var poll = function () {
      window
        .fetch(notificationApiPath("pull?since=" + encodeURIComponent(String(notificationCursor || 0))), {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "X-Requested-With": "XMLHttpRequest" }
        })
        .then(function (response) {
          if (!response.ok) return null;
          return response.json();
        })
        .then(function (payload) {
          if (!payload || !payload.ok) return;
          if (payload.reset_required) {
            notificationCursor = 0;
            setStoredValue(notificationCursorKey, notificationCursor);
          }
          applyNotificationEvents(payload.events);
          var latest = parseTimestamp(payload.latest_id);
          if (latest > notificationCursor) {
            notificationCursor = latest;
            setStoredValue(notificationCursorKey, notificationCursor);
          } else if (latest < notificationCursor) {
            notificationCursor = 0;
            setStoredValue(notificationCursorKey, notificationCursor);
            if (latest > 0) {
              window.setTimeout(poll, 80);
            }
          }
        })
        .catch(function () {});
    };
    poll();
    notificationPollTimer = window.setInterval(poll, 1200);
  }

  function executeWechatAudioNotificationTest() {
    return window.fetch(notificationApiPath("debug/wechat-audio-test"), {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest"
      },
      body: JSON.stringify({ simulated: true })
    })
      .then(function (response) {
        if (!response.ok) throw new Error("wechat audio test failed");
        return response.json();
      })
      .then(function () {
        setActivityTask("wechat-audio-test", {
          title: "\u5fae\u4fe1\u6a21\u62df\u63d0\u793a\u97f3\u6d4b\u8bd5\u5b8c\u6210",
          detail: "\u5df2\u5411\u540e\u7aef\u6ce8\u5165\u4e00\u6761 audio-wechat \u6a21\u62df\u6d88\u606f\u4e8b\u4ef6\u3002",
          kind: "success",
          progress: 100,
          indeterminate: false,
          priority: 72,
          expiresAt: Date.now() + 3200
        });
      })
      .catch(function () {
        setActivityTask("wechat-audio-test", {
          title: "\u5fae\u4fe1\u6a21\u62df\u63d0\u793a\u97f3\u6d4b\u8bd5\u5931\u8d25",
          detail: "\u672a\u80fd\u5411\u540e\u7aef\u6ce8\u5165\u5fae\u4fe1\u6a21\u62df\u63d0\u793a\u97f3\u4e8b\u4ef6\u3002",
          kind: "error",
          progress: null,
          indeterminate: true,
          priority: 82,
          expiresAt: Date.now() + 3600
        });
      });
  }

  function triggerWechatAudioNotificationTest() {
    clearWechatAudioDebugTimer();
    debugWechatAudioTargetAt = Date.now() + 5000;
    setActivityTask("wechat-audio-test", {
      title: "\u5fae\u4fe1\u6a21\u62df\u63d0\u793a\u97f3\u6d4b\u8bd5\u5df2\u51c6\u5907",
      detail: "5 \u79d2\u540e\u5c06\u5411\u540e\u7aef\u6ce8\u5165\u4e00\u6761\u5fae\u4fe1\u6a21\u62df\u63d0\u793a\u97f3\u4e8b\u4ef6\u3002",
      kind: "info",
      progress: 1,
      indeterminate: false,
      priority: 74,
      startedAt: Date.now()
    });
    debugWechatAudioInterval = window.setInterval(function () {
      var remainingMs = Math.max(0, debugWechatAudioTargetAt - Date.now());
      var remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
      setActivityTask("wechat-audio-test", {
        title: "\u5fae\u4fe1\u6a21\u62df\u63d0\u793a\u97f3\u6d4b\u8bd5\u5012\u8ba1\u65f6",
        detail: remainingSeconds + " \u79d2\u540e\u5411\u540e\u7aef\u6ce8\u5165\u5fae\u4fe1\u6a21\u62df\u63d0\u793a\u97f3\u4e8b\u4ef6\u3002",
        kind: "info",
        progress: clamp(((5000 - remainingMs) / 5000) * 100, 1, 99),
        indeterminate: false,
        priority: 74,
        startedAt: Date.now()
      });
    }, 250);
    debugWechatAudioTimeout = window.setTimeout(function () {
      clearWechatAudioDebugTimer();
      executeWechatAudioNotificationTest();
    }, 5000);
  }

  function restartStreamingPipelines(reason) {
    if (streamRestartTimer) {
      window.clearTimeout(streamRestartTimer);
      streamRestartTimer = null;
    }
    if (streamRestartVerifyTimer) {
      window.clearTimeout(streamRestartVerifyTimer);
      streamRestartVerifyTimer = null;
    }
    noteUiInteraction();
    clearAllHighLoadState("stream restart");
    imeCompositionActive = false;
    if (dynamicLatencyApplied) {
      restoreDynamicLatency();
    }
    clearEncoderResetTimers();
    suppressDynamicLatency(6000);
    sendDynamicLatencyState(false, "repair-reset");
    streamRecoveryInFlight = false;
    streamRecoveryStage = 0;
    waitingSinceMs = 0;
    lastFrameProgressAt = 0;
    if (pipelineResetNoticeTimer) {
      window.clearTimeout(pipelineResetNoticeTimer);
      pipelineResetNoticeTimer = null;
    }
    sendRawDataCommand("STOP_VIDEO");
    sendRawDataCommand("STOP_AUDIO");
    setActivityTask("stream-reconfig", {
      title: "\u6b63\u5728\u91cd\u542f\u63a8\u6d41\u7cfb\u7edf",
      detail: reason || "\u6b63\u5728\u91cd\u5efa\u89c6\u9891\u4e0e\u97f3\u9891\u6d41\u3002",
      phase: "\u6d41\u91cd\u542f",
      kind: "warning",
      progress: null,
      indeterminate: true,
      priority: 96,
      startedAt: Date.now()
    });
    resetClientClipboardRuntime();
    sendRawDataCommand("RESET_IO_MODULES");
    sendRawDataCommand("kr");
    sendRawDataCommand("FORCE_STREAM_RECOVER,primary");
    sendRawDataCommand("cmd,/scripts/recover-ui-services.sh");
    scheduleKeyboardAssistFocus(60);
    window.setTimeout(function () {
      scheduleKeyboardAssistFocus(240);
    }, 240);
    streamRestartTimer = window.setTimeout(function () {
      streamRestartTimer = null;
      if (lastVideoPipelineActive) return;
      sendRawDataCommand("FORCE_STREAM_RECOVER,primary");
      sendRawDataCommand("cmd,/scripts/recover-ui-services.sh");
      streamRestartVerifyTimer = window.setTimeout(function () {
        streamRestartVerifyTimer = null;
        if (lastVideoPipelineActive) return;
        sendRawDataCommand("STOP_VIDEO");
        sendRawDataCommand("STOP_AUDIO");
        window.setTimeout(function () {
          sendRawDataCommand("START_VIDEO");
          window.setTimeout(function () {
            sendRawDataCommand("START_AUDIO");
          }, 180);
          window.setTimeout(function () {
            if (lastVideoPipelineActive) return;
            window.location.reload();
          }, 2600);
        }, 260);
      }, 2600);
    }, 900);
  }

  function runIdleCleanup() {
    lastIdleCleanupAt = Date.now();
    clearClipboardSyncBurst();
    resetClientClipboardRuntime();
    if (pendingRemoteClipboardPull && pendingRemoteClipboardPull.timerId) {
      window.clearTimeout(pendingRemoteClipboardPull.timerId);
    }
    pendingRemoteClipboardPull = null;
    clearAllHighLoadState("idle-cleanup");
    if (dynamicLatencyApplied) {
      restoreDynamicLatency();
    }
    streamRecoveryInFlight = false;
    streamRecoveryStage = 0;
    waitingSinceMs = 0;
    sendRawDataCommand("RESET_IO_MODULES");
    sendRawDataCommand("kr");
    scheduleKeyboardAssistFocus(120);
    activityTasks = Object.create(null);
    setActivityTask("idle-cleanup", {
      title: "\u5df2\u6267\u884c\u7a7a\u95f2\u6e05\u7406",
      detail: "\u5df2\u6e05\u7406\u526a\u8d34\u677f\u3001\u9ad8\u8d1f\u8f7d\u3001\u4f4e\u5ef6\u8fdf\u548c\u8f93\u5165\u6a21\u5757\u7684\u6682\u6001\u7f13\u5b58\u3002",
      kind: "success",
      progress: 100,
      indeterminate: false,
      priority: 60,
      startedAt: Date.now(),
      expiresAt: Date.now() + 3200
    });
  }

  function sanitizeBool(value, fallbackValue) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      var text = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].indexOf(text) >= 0) return true;
      if (["false", "0", "no", "off"].indexOf(text) >= 0) return false;
    }
    return fallbackValue;
  }

  function sanitizeInt(value, fallbackValue, minValue, maxValue) {
    var n = parseInt(String(value), 10);
    if (!Number.isFinite(n)) return fallbackValue;
    if (n < minValue || n > maxValue) return fallbackValue;
    return n;
  }

  function clamp(value, minValue, maxValue) {
    return Math.max(minValue, Math.min(maxValue, value));
  }

  function formatDurationShort(ms) {
    var safeMs = Math.max(0, parseInt(ms, 10) || 0);
    var totalSeconds = Math.floor(safeMs / 1000);
    if (totalSeconds < 60) return totalSeconds + "s";
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    return minutes + "m " + seconds + "s";
  }

  function formatBytes(bytes) {
    var value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return "0 B";
    var units = ["B", "KB", "MB", "GB"];
    var idx = 0;
    while (value >= 1024 && idx < units.length - 1) {
      value /= 1024;
      idx += 1;
    }
    var digits = idx === 0 ? 0 : value >= 10 ? 1 : 2;
    return value.toFixed(digits) + " " + units[idx];
  }

  function storagePrefix() {
    return window.location.href.split("#")[0].replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  function storageKey(name) {
    return storagePrefix() + "_" + name;
  }

  function getStoredValue(name) {
    return window.localStorage.getItem(storageKey(name));
  }

  function setStoredValue(name, value) {
    if (value === null || value === undefined) {
      window.localStorage.removeItem(storageKey(name));
      return;
    }
    window.localStorage.setItem(storageKey(name), String(value));
  }

  function setStoredDefault(name, value) {
    if (getStoredValue(name) === null) {
      setStoredValue(name, value);
    }
  }

  function preferredEncoder() {
    var configured = String(runtime.preferredEncoder || "").trim().toLowerCase();
    if (!configured) {
      configured = FALLBACK_ENCODER;
    }
    if (VAAPI_ENCODER_HINTS.has(configured)) {
      return "x264enc";
    }
    if (!STABLE_ENCODERS.has(configured)) {
      return FALLBACK_ENCODER;
    }
    return configured;
  }

  function readUseCpuHint(fallbackValue) {
    var stored = getStoredValue("use_cpu");
    if (stored !== null) {
      var parsed = sanitizeBool(stored, true);
      lastServerUseCpu = parsed;
      return parsed;
    }
    if (lastServerUseCpu !== null) {
      return lastServerUseCpu;
    }
    return sanitizeBool(runtime.defaultUseCpu, fallbackValue);
  }

  function encoderMode(encoder) {
    var name = String(encoder || "").trim().toLowerCase();
    var useCpu = readUseCpuHint(true);
    if (CPU_ONLY_ENCODERS.has(name)) {
      return "CPU";
    }
    if (VAAPI_ENCODER_HINTS.has(name) && sanitizeBool(runtime.driAvailable, false)) {
      return "VAAPI";
    }
    if (name === "x264enc" && sanitizeBool(runtime.driAvailable, false) && !useCpu) {
      return "VAAPI";
    }
    return "CPU";
  }

  function setUseCpuFlag(useCpu) {
    var safe = sanitizeBool(useCpu, false);
    setStoredValue("use_cpu", safe);
    lastServerUseCpu = safe;
  }

  function initUseCpuHint() {
    var stored = getStoredValue("use_cpu");
    if (stored !== null) {
      lastServerUseCpu = sanitizeBool(stored, true);
      return;
    }
    if (typeof runtime.encoderMode === "string") {
      var mode = runtime.encoderMode.trim().toUpperCase();
      if (mode === "CPU") {
        lastServerUseCpu = true;
        return;
      }
      if (mode === "VAAPI" || mode === "GPU") {
        lastServerUseCpu = false;
        return;
      }
    }
    lastServerUseCpu = sanitizeBool(runtime.defaultUseCpu, false);
  }

  function applyRuntimeDefaults() {
    var frameRate = sanitizeInt(runtime.defaultFramerate, 48, 1, 240);
    var gamepadEnabled = sanitizeBool(runtime.defaultGamepadEnabled, false);
    var binaryClipboard = sanitizeBool(runtime.defaultBinaryClipboard, true);
    var defaultUseCpu = sanitizeBool(runtime.defaultUseCpu, false);
    var defaultStreamingMode = sanitizeBool(runtime.defaultH264StreamingMode, true);
    var defaultPaintOver = sanitizeBool(runtime.defaultUsePaintOverQuality, false);
    var defaultH264Crf = sanitizeInt(runtime.defaultH264Crf, 30, 5, 50);
    var dynamicLatencyEnabled = sanitizeBool(runtime.dynamicLowLatencyEnabled, true);
    var dynamicLatencyHoldMs = sanitizeInt(runtime.dynamicLowLatencyHoldMs, 1600, 300, 10000);
    var dynamicLatencyFps = sanitizeInt(runtime.dynamicLowLatencyFps, 36, 8, 120);
    var dynamicLatencyCrf = sanitizeInt(runtime.dynamicLowLatencyH264Crf, 45, 5, 50);
    var dynamicLatencyScale = sanitizeInt(runtime.dynamicLowLatencyScalePercent, 75, 25, 100);
    var dynamicLatencySample = sanitizeInt(runtime.dynamicLowLatencySamplePercent, 60, 33, 100);
    var dynamicLatencyDisablePaint = sanitizeBool(runtime.dynamicLowLatencyDisablePaintOver, true);

    setStoredDefault("framerate", frameRate);
    if (GAMEPAD_UI_ENABLED) {
      setStoredDefault("isGamepadEnabled", gamepadEnabled);
      setStoredDefault("gamepad_enabled", gamepadEnabled);
    } else {
      setStoredValue("isGamepadEnabled", false);
      setStoredValue("gamepad_enabled", false);
      setStoredValue("ui_sidebar_show_gamepads", false);
      setStoredValue("enable_player2", false);
      setStoredValue("enable_player3", false);
      setStoredValue("enable_player4", false);
    }
    setStoredDefault("enable_binary_clipboard", binaryClipboard);
    setStoredDefault("use_cpu", defaultUseCpu);
    setStoredDefault("h264_streaming_mode", defaultStreamingMode);
    setStoredDefault("use_paint_over_quality", defaultPaintOver);
    setStoredDefault("h264_crf", defaultH264Crf);
    setStoredDefault("dynamic_low_latency_enabled", dynamicLatencyEnabled);
    setStoredDefault("dynamic_low_latency_hold_ms", dynamicLatencyHoldMs);
    setStoredDefault("dynamic_low_latency_fps", dynamicLatencyFps);
    setStoredDefault("dynamic_low_latency_h264_crf", dynamicLatencyCrf);
    setStoredDefault("dynamic_low_latency_sample_percent", dynamicLatencySample);
    setStoredDefault("dynamic_low_latency_disable_paint_over", dynamicLatencyDisablePaint);

    var currentEncoder = getStoredValue("encoder");
    if (currentEncoder === null || !STABLE_ENCODERS.has(String(currentEncoder).toLowerCase())) {
      setStoredValue("encoder", preferredEncoder());
    }
  }

  function migrateUseCpuPreferenceOnce() {
    var migrationKey = "use_cpu_migrated_vaapi_default_v1";
    if (getStoredValue(migrationKey) !== null) return;
    var encoder = String(getStoredValue("encoder") || preferredEncoder()).toLowerCase();
    if (encoder === "x264enc" && sanitizeBool(runtime.driAvailable, false)) {
      setStoredValue("use_cpu", sanitizeBool(runtime.defaultUseCpu, false));
    }
    setStoredValue(migrationKey, "1");
  }

  function primeRuntimeStorageDefaults() {
    initUseCpuHint();
    applyRuntimeDefaults();
    migrateUseCpuPreferenceOnce();
  }

  function ensureActivityStyle() {
    if (document.getElementById("selkies-activity-style")) return;
    var style = document.createElement("style");
    style.id = "selkies-activity-style";
    style.textContent =
      "#selkies-activity-layer{position:fixed;inset:0;pointer-events:none;z-index:10015}" +
      "#selkies-activity-banner{position:fixed;top:14px;left:50%;transform:translateX(-50%) translateY(-18px) scale(.94);" +
      "display:flex;align-items:center;gap:12px;min-width:min(82vw,420px);max-width:min(92vw,620px);" +
      "padding:10px 14px;border-radius:999px;background:rgba(15,23,42,.88);border:1px solid rgba(96,165,250,.28);" +
      "box-shadow:0 14px 34px rgba(2,6,23,.28);backdrop-filter:blur(10px);color:#e2e8f0;opacity:0;pointer-events:none;" +
      "transition:opacity .2s ease,transform .2s ease}" +
      "#selkies-activity-banner[data-open='1']{opacity:1;pointer-events:auto;transform:translateX(-50%) translateY(0) scale(1)}" +
      ".selkies-activity-banner-pulse{width:10px;height:10px;border-radius:999px;background:#38bdf8;" +
      "box-shadow:0 0 0 0 rgba(56,189,248,.55);animation:selkiesPulse 1.8s infinite}" +
      ".selkies-activity-banner-copy{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}" +
      ".selkies-activity-banner-title{font-size:12px;font-weight:700;letter-spacing:.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".selkies-activity-banner-detail{font-size:11px;color:#cbd5e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".selkies-activity-banner-time{font-size:11px;color:#93c5fd;font-variant-numeric:tabular-nums}" +
      ".selkies-activity-performance{position:fixed;left:16px;bottom:16px;display:none;padding:9px 12px;border-radius:999px;" +
      "background:rgba(15,23,42,.85);border:1px solid rgba(251,191,36,.28);box-shadow:0 12px 28px rgba(2,6,23,.22);" +
      "color:#f8fafc;font-size:11px;pointer-events:none}" +
      ".selkies-activity-performance[data-open='1']{display:block}" +
      "@keyframes selkiesShimmer{0%{background-position:0% 50%}100%{background-position:200% 50%}}" +
      "@keyframes selkiesPulse{0%{box-shadow:0 0 0 0 rgba(56,189,248,.55)}70%{box-shadow:0 0 0 10px rgba(56,189,248,0)}100%{box-shadow:0 0 0 0 rgba(56,189,248,0)}}" +
      "@media (max-width: 680px){#selkies-activity-banner{top:10px;min-width:0;width:calc(100vw - 20px)}}";
    document.head.appendChild(style);
  }

  function ensureActivityShell() {
    ensureActivityStyle();
    var layer = document.getElementById("selkies-activity-layer");
    if (layer) return layer;

    layer = document.createElement("div");
    layer.id = "selkies-activity-layer";
    layer.innerHTML =
      '<div id="selkies-activity-banner">' +
      '<div class="selkies-activity-banner-pulse"></div>' +
      '<div class="selkies-activity-banner-copy">' +
      '<div class="selkies-activity-banner-title"></div>' +
      '<div class="selkies-activity-banner-detail"></div>' +
      "</div>" +
      '<div class="selkies-activity-banner-time"></div>' +
      "</div>" +
      '<div id="selkies-activity-performance" class="selkies-activity-performance"></div>';
    document.body.appendChild(layer);
    return layer;
  }

  function setActivityTask(id, taskPatch) {
    if (!id) return;
    var now = Date.now();
    var current = activityTasks[id] || {
      id: id,
      title: "",
      detail: "",
      kind: "info",
      progress: null,
      indeterminate: true,
      startedAt: now,
      updatedAt: now,
      priority: 10,
      expiresAt: 0
    };
    activityTasks[id] = Object.assign({}, current, taskPatch || {}, {
      id: id,
      updatedAt: now
    });
    scheduleActivityRender();
  }

  function removeActivityTask(id) {
    if (!id || !activityTasks[id]) return;
    delete activityTasks[id];
    scheduleActivityRender();
  }

  function completeActivityTask(id, detail, kind, ttlMs) {
    if (!id) return;
    setActivityTask(id, {
      detail: detail || "\u5df2\u5b8c\u6210",
      kind: kind || "success",
      progress: 100,
      indeterminate: false,
      expiresAt: Date.now() + (ttlMs || 2400),
      priority: 1
    });
  }

  function collectActivityTasks() {
    var now = Date.now();
    var ids = Object.keys(activityTasks);
    var active = [];
    for (var i = 0; i < ids.length; i += 1) {
      var task = activityTasks[ids[i]];
      if (!task) continue;
      if (task.expiresAt && task.expiresAt <= now) {
        delete activityTasks[ids[i]];
        continue;
      }
      active.push(task);
    }
    active.sort(function (left, right) {
      if ((right.priority || 0) !== (left.priority || 0)) {
        return (right.priority || 0) - (left.priority || 0);
      }
      return (right.updatedAt || 0) - (left.updatedAt || 0);
    });
    return active;
  }

  function renderActivityTasks() {
    if (!document.body) return;
    var layer = ensureActivityShell();
    if (!layer) return;

    var active = collectActivityTasks();
    var banner = document.getElementById("selkies-activity-banner");
    if (!banner) return;

    if (!active.length) {
      banner.setAttribute("data-open", "0");
      var perfHidden = document.getElementById("selkies-activity-performance");
      if (perfHidden) perfHidden.setAttribute("data-open", "0");
      return;
    }

    var lead = active[0];
    banner.querySelector(".selkies-activity-banner-title").textContent = lead.title || "\u5904\u7406\u4e2d";
    banner.querySelector(".selkies-activity-banner-detail").textContent = lead.detail || "";
    banner.querySelector(".selkies-activity-banner-time").textContent = formatDurationShort(Date.now() - (lead.startedAt || Date.now()));
    banner.setAttribute("data-open", "1");
  }

  function scheduleActivityRender() {
    if (activityRenderTimer) return;
    activityRenderTimer = window.requestAnimationFrame(function () {
      activityRenderTimer = null;
      renderActivityTasks();
    });
  }

  function startActivityHeartbeat() {
    if (activityHeartbeatTimer) return;
    activityHeartbeatTimer = window.setInterval(renderActivityTasks, 1000);
  }

  function injectBadgeStyle() {
    if (document.getElementById("selkies-encoder-mode-style")) return;
    var style = document.createElement("style");
    style.id = "selkies-encoder-mode-style";
    style.textContent =
      ".selkies-encoder-mode-badge{display:inline-flex;align-items:center;justify-content:center;" +
      "height:22px;min-width:42px;padding:0 8px;margin-left:8px;border-radius:999px;" +
      "border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:11px;font-weight:700;}" +
      ".selkies-encoder-mode-badge[data-mode='vaapi']{background:#052e16;border-color:#166534;color:#86efac;}" +
      ".selkies-encoder-mode-badge[data-mode='cpu']{background:#172554;border-color:#1d4ed8;color:#bfdbfe;}";
    document.head.appendChild(style);
  }

  function findEncoderSelect() {
    var selects = Array.prototype.slice.call(document.querySelectorAll("select"));
    var candidate = null;
    for (var i = 0; i < selects.length; i += 1) {
      var values = Array.prototype.slice.call(selects[i].options || []).map(function (opt) {
        return String(opt.value || "").toLowerCase();
      });
      if (values.indexOf("x264enc") >= 0 && values.indexOf("jpeg") >= 0) {
        candidate = selects[i];
        if (selects[i].offsetParent !== null) {
          return selects[i];
        }
      }
    }
    return candidate;
  }

  function ensureEncoderBadge(select) {
    if (!select || !select.parentElement) return null;
    var badge = document.getElementById("selkies-encoder-mode-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.id = "selkies-encoder-mode-badge";
      badge.className = "selkies-encoder-mode-badge";
    }
    if (badge.parentElement !== select.parentElement) {
      select.parentElement.appendChild(badge);
    }
    return badge;
  }

  function handleEncoderModeSideEffects(select) {
    if (!select) return;
    var value = String(select.value || "").toLowerCase();
    if (CPU_ONLY_ENCODERS.has(value)) {
      setUseCpuFlag(true);
      return;
    }
    if (VAAPI_ENCODER_HINTS.has(value)) {
      setUseCpuFlag(false);
      return;
    }
    if (value === "x264enc") {
      setUseCpuFlag(readUseCpuHint(sanitizeBool(runtime.defaultUseCpu, false)));
    }
  }

  function updateEncoderBadge() {
    var select = findEncoderSelect();
    if (!select) return;
    var badge = ensureEncoderBadge(select);
    if (!badge) return;

    if (!select.dataset.encoderModeBound) {
      select.addEventListener("change", function () {
        handleEncoderModeSideEffects(select);
        scheduleBadgeRefresh(0);
      });
      select.dataset.encoderModeBound = "1";
    }

    var selectedEncoder = String(select.value || getStoredValue("encoder") || "").toLowerCase();
    var mode = encoderMode(selectedEncoder);
    badge.textContent = mode;
    badge.dataset.mode = mode.toLowerCase();
  }

  function scheduleBadgeRefresh(delayMs) {
    var delay = typeof delayMs === "number" ? delayMs : 80;
    if (badgeRefreshTimer) {
      window.clearTimeout(badgeRefreshTimer);
    }
    badgeRefreshTimer = window.setTimeout(function () {
      badgeRefreshTimer = null;
      updateEncoderBadge();
    }, delay);
  }

  function scheduleBurstRefresh() {
    var delays = [0, 120, 320, 650];
    for (var i = 0; i < delays.length; i += 1) {
      window.setTimeout(updateEncoderBadge, delays[i]);
    }
  }

  function isWaitingForStreamVisible() {
    if (!document || !document.body) return false;
    var text = String(document.body.innerText || document.body.textContent || "");
    return text.indexOf("Waiting for stream") >= 0 || text.indexOf("\u7b49\u5f85\u89c6\u9891\u6d41") >= 0;
  }

  function parseTimestamp(value) {
    var n = parseInt(String(value || ""), 10);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n;
  }

  function lastRecoverTimestamp() {
    return parseTimestamp(getStoredValue("stream_recover_at"));
  }

  function markRecoverTimestamp(tsMs) {
    setStoredValue("stream_recover_at", String(tsMs));
  }

  function isElementVisible(element) {
    if (!element) return false;
    var rect = element.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    var style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function findSidebarToggleButton() {
    var selectors = [
      '[data-testid*="sidebar" i]',
      '[data-testid*="drawer" i]',
      'button[aria-label*="sidebar" i]',
      'button[aria-label*="menu" i]',
      'button[aria-label*="drawer" i]',
      'button[title*="sidebar" i]',
      'button[title*="menu" i]',
      '[role="button"][aria-label*="sidebar" i]',
      '[role="button"][aria-label*="menu" i]'
    ];
    for (var i = 0; i < selectors.length; i += 1) {
      var direct = document.querySelector(selectors[i]);
      if (direct && isElementVisible(direct)) return direct;
    }

    var nodes = Array.prototype.slice.call(document.querySelectorAll("button,[role='button'],div,span"));
    var best = null;
    var bestScore = -1;
    for (var j = 0; j < nodes.length; j += 1) {
      var button = nodes[j];
      if (!isElementVisible(button)) continue;
      if (button.closest("#selkies-activity-layer,#selkies-local-link-prompt,#selkies-link-history-section,#selkies-dynamic-latency-section")) {
        continue;
      }
      var rect = button.getBoundingClientRect();
      var nearSide = rect.left <= 40 || window.innerWidth - rect.right <= 40;
      if (!nearSide) continue;
      var isThinBar = rect.width >= 8 && rect.width <= 42 && rect.height >= 56 && rect.height <= 420;
      var isSmallButton = rect.width >= 20 && rect.width <= 84 && rect.height >= 20 && rect.height <= 84;
      if (!isThinBar && !isSmallButton) continue;
      var nearEdge =
        rect.left <= 96 || window.innerWidth - rect.right <= 96 || rect.top <= 96 || window.innerHeight - rect.bottom <= 96;
      var attrs = [
        button.id,
        button.className,
        button.getAttribute && button.getAttribute("aria-label"),
        button.getAttribute && button.getAttribute("title")
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      var text = String(button.innerText || button.textContent || "").trim().toLowerCase();
      var style = window.getComputedStyle(button);
      var score = 0;
      if (attrs.indexOf("sidebar") >= 0 || attrs.indexOf("drawer") >= 0) score += 120;
      if (attrs.indexOf("menu") >= 0) score += 60;
      if (attrs.indexOf("setting") >= 0) score += 20;
      if (style.cursor === "pointer") score += 15;
      if (nearEdge) score += 25;
      if (isThinBar) score += 80;
      if (text === "" || text === "\u2261") score += 10;
      score += Math.min(40, Math.round(rect.height / 6));
      score -= Math.min(30, Math.round(rect.width));
      if (score > bestScore) {
        bestScore = score;
        best = button;
      }
    }
    return best;
  }

  function hasVisibleStreamSurface() {
    var video = document.getElementById("stream");
    if (video && isElementVisible(video)) return true;
    var canvases = Array.prototype.slice.call(document.querySelectorAll("canvas"));
    for (var i = 0; i < canvases.length; i += 1) {
      if (isElementVisible(canvases[i])) return true;
    }
    return false;
  }

  function getStatusDisplayText() {
    var status = document.getElementById("status-display");
    if (!status || !isElementVisible(status)) return "";
    return String(status.innerText || status.textContent || "").trim();
  }

  function noteFrameProgress() {
    lastFrameProgressAt = Date.now();
    waitingSinceMs = 0;
    if (streamRecoveryInFlight || streamRecoveryStage > 0) {
      streamRecoveryInFlight = false;
      streamRecoveryStage = 0;
      completeActivityTask("stream-reconfig", "\u89c6\u9891\u5e27\u5df2\u6062\u590d\u66f4\u65b0\u3002", "success", 1800);
    }
  }

  function hasVisibleVideoStream() {
    var video = document.getElementById("stream");
    return !!(video && isElementVisible(video));
  }

  function ensureVideoFrameTracker() {
    var video = document.getElementById("stream");
    if (!video || video.__selkiesFrameTrackerBound) return;
    video.__selkiesFrameTrackerBound = true;
    ["loadeddata", "playing", "canplay", "timeupdate", "seeked"].forEach(function (eventName) {
      video.addEventListener(eventName, noteFrameProgress);
    });
    if (typeof video.requestVideoFrameCallback === "function") {
      var onFrame = function () {
        noteFrameProgress();
        if (video.isConnected) {
          video.requestVideoFrameCallback(onFrame);
        } else {
          video.__selkiesFrameTrackerBound = false;
        }
      };
      video.requestVideoFrameCallback(onFrame);
    }
  }

  function getFrameStallActive() {
    if (!hasOpenDataSocket()) return false;
    if (!hasVisibleVideoStream()) return false;
    if (!lastVideoPipelineActive) return false;
    if (!lastFrameProgressAt) return false;
    if (isTransportBusy()) return false;
    if (streamRecoveryInFlight) return false;
    return Date.now() - lastFrameProgressAt >= STREAM_STALL_THRESHOLD_MS;
  }

  function isStreamLikelyStalled() {
    if (isWaitingForStreamVisible()) return true;
    var statusText = getStatusDisplayText().toLowerCase();
    if (getFrameStallActive()) return true;
    if (!statusText) return false;
    if (statusText.indexOf("waiting for stream") >= 0 || statusText.indexOf("\u7b49\u5f85\u89c6\u9891\u6d41") >= 0) return true;
    if ((statusText.indexOf("connecting") >= 0 || statusText.indexOf("\u8fde\u63a5\u4e2d") >= 0) && !hasVisibleStreamSurface()) return true;
    return false;
  }

  function tryRecoverFromWaiting() {
    var now = Date.now();
    var lastRecoverAt = lastRecoverTimestamp();
    if (streamRecoveryInFlight) return;
    if (streamRecoveryStage === 0 && now - lastRecoverAt < STREAM_RECOVER_COOLDOWN_MS) return;
    if (streamRecoveryStage === 0) {
      markRecoverTimestamp(now);
    }
    waitingSinceMs = 0;
    streamRecoveryInFlight = true;
    streamRecoveryStage += 1;
    if (streamRecoveryStage <= Math.max(1, STREAM_STALL_RESTART_LIMIT)) {
      var detail =
        streamRecoveryStage === 1
          ? "\u68c0\u6d4b\u5230\u89c6\u9891\u5e27\u957f\u65f6\u95f4\u672a\u66f4\u65b0\uff0c\u5148\u91cd\u542f\u89c6\u9891\u6d41\u3002"
          : "\u89c6\u9891\u4ecd\u672a\u6062\u590d\uff0c\u6b63\u5728\u540c\u65f6\u91cd\u542f\u89c6\u9891\u4e0e\u97f3\u9891\u6d41\u3002";
      setActivityTask("stream-reconfig", {
        title: "\u6b63\u5728\u81ea\u52a8\u6062\u590d\u63a8\u6d41",
        detail: detail,
        phase: streamRecoveryStage === 1 ? "\u91cd\u542f\u89c6\u9891" : "\u91cd\u542f\u89c6\u97f3\u9891",
        kind: "warning",
        progress: null,
        indeterminate: true,
        priority: 96,
        startedAt: now
      });
      sendRawDataCommand("STOP_VIDEO");
      if (streamRecoveryStage > 1) {
        sendRawDataCommand("STOP_AUDIO");
      }
      window.setTimeout(function () {
        sendRawDataCommand("START_VIDEO");
        if (streamRecoveryStage > 1) {
          window.setTimeout(function () {
            sendRawDataCommand("START_AUDIO");
          }, 180);
        }
        streamRecoveryInFlight = false;
      }, 220);
      return;
    }
    setActivityTask("stream-reconfig", {
      title: "\u6b63\u5728\u91cd\u8f7d\u9875\u9762\u4ee5\u6062\u590d\u4f1a\u8bdd",
      detail: "\u89c6\u97f3\u9891\u6d41\u91cd\u542f\u540e\u4ecd\u65e0\u65b0\u753b\u9762\uff0c\u5c06\u91cd\u8f7d\u9875\u9762\u81ea\u6108\u3002",
      phase: "\u9875\u9762\u91cd\u8f7d",
      kind: "warning",
      progress: null,
      indeterminate: true,
      priority: 97,
      startedAt: now
    });
    markRecoverTimestamp(now);
    window.location.reload();
  }

  function bindStreamRecoveryWatchdog() {
    if (streamRecoverTimer) return;
    ensureVideoFrameTracker();
    if (!frameTrackerBindTimer) {
      frameTrackerBindTimer = window.setInterval(ensureVideoFrameTracker, 1500);
    }
    streamRecoverTimer = window.setInterval(function () {
      if (document.hidden) return;
      if (isTransportBusy()) {
        waitingSinceMs = 0;
        return;
      }
      if (!isStreamLikelyStalled()) {
        waitingSinceMs = 0;
        return;
      }
      if (waitingSinceMs === 0) {
        waitingSinceMs = Date.now();
        return;
      }
      if (Date.now() - waitingSinceMs < STREAM_WAIT_THRESHOLD_MS) return;
      tryRecoverFromWaiting();
    }, 3000);

    window.addEventListener("focus", function () {
      waitingSinceMs = 0;
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        waitingSinceMs = 0;
      }
    });
  }

  function mapStreamStatus(statusText) {
    var text = String(statusText || "").trim().toLowerCase();
    if (!text) {
      return null;
    }
    if (text.indexOf("waiting for stream") >= 0) {
      return {
        title: "\u7b49\u5f85\u89c6\u9891\u6d41",
        detail: "\u63a7\u5236\u901a\u9053\u5df2\u5c31\u7eea\uff0c\u6b63\u5728\u7b49\u5f85\u8fdc\u7aef\u4f1a\u8bdd\u8fd4\u56de\u7b2c\u4e00\u5e27\u753b\u9762\u3002",
        phase: "\u7b49\u5f85\u9996\u5e27",
        kind: "warning"
      };
    }
    if (text.indexOf("connecting") >= 0) {
      return {
        title: "\u6b63\u5728\u8fde\u63a5\u89c6\u9891\u6d41",
        detail: "\u6b63\u5728\u534f\u5546\u63a7\u5236\u901a\u9053\uff0c\u663e\u793a\u7ba1\u7ebf\u548c\u97f3\u9891\u94fe\u8def\u3002",
        phase: "\u8fde\u63a5\u4e2d",
        kind: "info"
      };
    }
    if (text.indexOf("initializ") >= 0) {
      return {
        title: "\u6b63\u5728\u521d\u59cb\u5316\u4f1a\u8bdd",
        detail: "\u6b63\u5728\u51c6\u5907\u6e32\u67d3\u5668\uff0c\u89e3\u7801\u5668\u548c\u8fdc\u7aef\u753b\u9762\u3002",
        phase: "\u521d\u59cb\u5316\u4e2d",
        kind: "info"
      };
    }
    if (text.indexOf("disconnected") >= 0 || text.indexOf("reconnect") >= 0) {
      return {
        title: "\u6b63\u5728\u6062\u590d\u8fde\u63a5",
        detail: "\u4f1a\u8bdd\u4f20\u8f93\u66fe\u4e2d\u65ad\uff0c\u6b63\u5728\u81ea\u52a8\u6062\u590d\u3002",
        phase: "\u91cd\u8fde\u4e2d",
        kind: "warning"
      };
    }
    if (text.indexOf("error") >= 0 || text.indexOf("failed") >= 0) {
      return {
        title: "\u4f1a\u8bdd\u9519\u8bef",
        detail: statusText,
        phase: "\u9519\u8bef",
        kind: "error"
      };
    }
    return {
      title: "\u4f1a\u8bdd\u72b6\u6001",
      detail: statusText,
      phase: "\u8fd0\u884c\u4e2d",
      kind: "info"
    };
  }

  function syncStreamActivity() {
    var statusText = getStatusDisplayText();
    var hasSurface = hasVisibleStreamSurface();
    var waiting = isStreamLikelyStalled();
    if (!statusText && hasSurface && lastVideoPipelineActive) {
      removeActivityTask("stream-status");
      return;
    }

    var mapped = mapStreamStatus(statusText || (waiting ? "\u7b49\u5f85\u89c6\u9891\u6d41..." : ""));
    if (!mapped) {
      removeActivityTask("stream-status");
      return;
    }

    var elapsed = waitingSinceMs > 0 ? Date.now() - waitingSinceMs : 0;
    var progress = null;
    var meta = hasSurface ? "\u753b\u9762\u5c42\u5df2\u5c31\u7eea" : "\u5c1a\u672a\u62ff\u5230\u753b\u9762\u5c42";
    if (waiting && STREAM_WAIT_THRESHOLD_MS > 0) {
      progress = clamp((elapsed / STREAM_WAIT_THRESHOLD_MS) * 100, 3, 95);
      meta = "\u5c06\u5728 " + Math.max(0, Math.ceil((STREAM_WAIT_THRESHOLD_MS - elapsed) / 1000)) + " \u79d2\u540e\u81ea\u52a8\u6062\u590d";
    } else if (hasSurface && lastVideoPipelineActive) {
      removeActivityTask("stream-status");
      return;
    }

    setActivityTask("stream-status", {
      title: mapped.title,
      detail: mapped.detail,
      phase: mapped.phase,
      kind: mapped.kind,
      progress: progress,
      indeterminate: progress === null,
      startedAt: waitingSinceMs || Date.now(),
      priority: waiting ? 95 : 70,
      meta: meta
    });
  }

  function bindActivityWatchers() {
    startActivityHeartbeat();
    window.setInterval(syncStreamActivity, 1000);

    if (window.PerformanceObserver) {
      try {
        var observer = new window.PerformanceObserver(function (list) {
          var entries = list.getEntries();
          if (!entries || !entries.length) return;
          var worst = 0;
          for (var i = 0; i < entries.length; i += 1) {
            worst = Math.max(worst, entries[i].duration || 0);
          }
          if (worst < 150) return;
          setActivityTask("browser-busy", {
            title: "\u6d4f\u89c8\u5668\u6b63\u5fd9",
            detail: "\u5f53\u524d\u6709\u8f83\u91cd\u7684\u6e32\u67d3\u6216\u811a\u672c\u4efb\u52a1\uff0c\u4ea4\u4e92\u4f1a\u77ed\u6682\u53d7\u963b\u3002",
            phase: "\u672c\u5730\u6e32\u67d3",
            kind: "warning",
            progress: null,
            indeterminate: true,
            priority: 55,
            expiresAt: Date.now() + 4000
          });
        });
        observer.observe({ entryTypes: ["longtask"] });
      } catch (_err) {}
    }
  }

  function bindFileTransferActivity() {
    function transferKey(direction, name) {
      return String(direction || "upload") + ":" + String(name || "unnamed");
    }

    function getManagedFileTransfer(name, direction) {
      return managedFileTransfers[transferKey(direction, name)] || null;
    }

    function setManagedFileTransfer(state) {
      if (!state) return null;
      managedFileTransfers[transferKey(state.direction, state.fileName)] = state;
      return state;
    }

    function clearManagedFileTransfer(state) {
      if (!state) return;
      delete managedFileTransfers[transferKey(state.direction, state.fileName)];
    }

    function hasActiveFileTransfer() {
      var keys = Object.keys(managedFileTransfers);
      for (var i = 0; i < keys.length; i += 1) {
        var state = managedFileTransfers[keys[i]];
        if (state && state.active) return true;
      }
      return false;
    }

    function getFileTransferTaskId(state) {
      return (state.direction === "download" ? "download-" : "upload-") + String(state.fileName || "transfer");
    }

    function releaseFileTransferBandwidth() {
      if (hasActiveFileTransfer()) return;
      setHighLoadState(false, "file upload");
    }

    function ensureManagedFileTransfer(name, size, direction) {
      var fileName = String(name || "\u6587\u4ef6\u4f20\u8f93");
      var key = transferKey(direction, fileName);
      var state = managedFileTransfers[key];
      if (state) {
        if (size && !state.totalBytes) state.totalBytes = Number(size) || 0;
        return state;
      }
      state = {
        direction: String(direction || "upload"),
        fileName: fileName,
        totalBytes: Math.max(0, Number(size) || 0),
        sentBytes: 0,
        active: true,
        transportAware: false,
        status: "start",
        startedAt: Date.now(),
        completionTimer: null
      };
      managedFileTransfers[key] = state;
      return state;
    }

    function cancelManagedTransferCompletion(state) {
      if (!state || !state.completionTimer) return;
      window.clearTimeout(state.completionTimer);
      state.completionTimer = null;
    }

    function scheduleManagedTransferCompletion(state, delayMs) {
      if (!state) return;
      cancelManagedTransferCompletion(state);
      state.completionTimer = window.setTimeout(function () {
        state.completionTimer = null;
        state.active = false;
        completeActivityTask(
          getFileTransferTaskId(state),
          state.fileName + (state.direction === "download" ? " \u4e0b\u8f7d\u5b8c\u6210\u3002" : " \u4e0a\u4f20\u5b8c\u6210\u3002"),
          "success",
          2600
        );
        clearManagedFileTransfer(state);
        releaseFileTransferBandwidth();
      }, Math.max(250, delayMs || 900));
    }

    function renderManagedFileTransfer(state) {
      if (!state) return;
      var taskId = getFileTransferTaskId(state);
      var totalBytes = Math.max(0, Number(state.totalBytes) || 0);
      var sentBytes = Math.max(0, Number(state.sentBytes) || 0);
      var title = state.direction === "download" ? "\u6b63\u5728\u4e0b\u8f7d\u6587\u4ef6" : "\u6b63\u5728\u4e0a\u4f20\u6587\u4ef6";
      var detail = state.fileName;
      var phase = "\u51c6\u5907\u4e2d";
      var progress = totalBytes > 0 ? clamp((sentBytes / totalBytes) * 100, 1, 100) : null;
      var indeterminate = totalBytes <= 0;

      if (state.status === "progress") {
        phase = state.direction === "download" ? "\u4f20\u8f93\u4e2d" : "\u53d1\u9001\u4e2d";
        if (progress !== null && state.direction === "upload") {
          progress = Math.min(progress, 95);
        }
      } else if (state.status === "finalizing") {
        phase = state.direction === "download" ? "\u6d4f\u89c8\u5668\u6536\u5c3e" : "\u8fdc\u7aef\u5199\u5165\u4e2d";
        progress = progress === null ? 96 : Math.max(progress, 96);
        indeterminate = false;
      } else if (state.status === "error") {
        setActivityTask(taskId, {
          title: state.direction === "download" ? "\u4e0b\u8f7d\u5931\u8d25" : "\u4e0a\u4f20\u5931\u8d25",
          detail: state.errorMessage || state.fileName,
          phase: "\u9519\u8bef",
          kind: "error",
          progress: null,
          indeterminate: true,
          priority: 90,
          expiresAt: Date.now() + 6000
        });
        return;
      } else {
        phase = "\u51c6\u5907\u5206\u7247";
        progress = totalBytes > 0 ? Math.max(1, progress || 1) : 1;
        indeterminate = false;
      }

      if (state.direction === "upload") {
        detail =
          state.fileName +
          (totalBytes ? " (" + formatBytes(totalBytes) + ")" : "") +
          (dynamicLatencyApplied
            ? "\uff0c\u68c0\u6d4b\u5230\u4ea4\u4e92\uff0c\u4e0a\u4f20\u6b63\u5728\u4e3a\u64cd\u4f5c\u54cd\u5e94\u8ba9\u51fa\u5e26\u5bbd\u3002"
            : "\uff0c\u65e0\u4ea4\u4e92\u65f6\u4f1a\u6062\u590d\u66f4\u9ad8\u7684\u4f20\u8f93\u6743\u91cd\u3002");
      }

      setActivityTask(taskId, {
        title: title,
        detail: detail,
        phase: phase,
        kind: "info",
        progress: progress,
        indeterminate: indeterminate,
        priority: 80,
        startedAt: state.startedAt,
        meta: totalBytes ? formatBytes(sentBytes) + " / " + formatBytes(totalBytes) : ""
      });
    }

    function markManagedTransferError(name, message, direction) {
      var state = getManagedFileTransfer(name, direction) || ensureManagedFileTransfer(name, 0, direction);
      cancelManagedTransferCompletion(state);
      state.active = false;
      state.status = "error";
      state.errorMessage = String(message || state.fileName);
      renderManagedFileTransfer(state);
      clearManagedFileTransfer(state);
      releaseFileTransferBandwidth();
    }

    window.__selkiesHasActiveFileTransfer = hasActiveFileTransfer;
    window.__selkiesEnsureManagedFileTransfer = ensureManagedFileTransfer;
    window.__selkiesRenderManagedFileTransfer = renderManagedFileTransfer;
    window.__selkiesScheduleManagedTransferCompletion = scheduleManagedTransferCompletion;
    window.__selkiesMarkManagedTransferError = markManagedTransferError;

    window.addEventListener("message", function (event) {
      var data = event && event.data;
      if (!data || data.type !== "fileUpload" || !data.payload) return;
      var payload = data.payload || {};
      var name = String(payload.fileName || "\u6587\u4ef6\u4f20\u8f93");
      var state = ensureManagedFileTransfer(name, payload.fileSize, "upload");
      if (payload.status === "start") {
        cancelManagedTransferCompletion(state);
        state.active = true;
        state.status = "start";
        state.totalBytes = Math.max(state.totalBytes || 0, Number(payload.fileSize) || 0);
        setHighLoadState(true, "file upload");
        renderManagedFileTransfer(state);
        return;
      }
      if (payload.status === "progress") {
        if (!state.transportAware && state.totalBytes > 0) {
          state.status = "progress";
          state.sentBytes = Math.max(state.sentBytes, Math.round(state.totalBytes * clamp(Number(payload.progress) || 0, 0, 95) / 100));
          renderManagedFileTransfer(state);
        }
        return;
      }
      if (payload.status === "end") {
        if (!state.transportAware) {
          state.status = "finalizing";
          renderManagedFileTransfer(state);
          scheduleManagedTransferCompletion(state, 900);
        }
        return;
      }
      if (payload.status === "error") {
        markManagedTransferError(name, payload.message || name, "upload");
      }
    });
  }

  function bindClipboardActivity() {
    function isImageClipboardStatusText(text) {
      var safe = String(text || "");
      return /^Image \([^)]+\) received from session and copied to clipboard\.$/.test(safe);
    }

    document.addEventListener(
      "paste",
      function (event) {
        var items = event && event.clipboardData && event.clipboardData.items;
        if (!items || !items.length) return;
        for (var i = 0; i < items.length; i += 1) {
          var item = items[i];
          if (item && String(item.type || "").indexOf("image/") === 0) {
            setHighLoadState(true, "clipboard image");
            scheduleHighLoadRelease("clipboard image", 18000);
            setActivityTask("clipboard-image", {
              title: "\u6b63\u5728\u7c98\u8d34\u56fe\u7247",
              detail: "\u6b63\u5728\u8bfb\u53d6\u672c\u5730\u526a\u8d34\u677f\u56fe\u7247\u5e76\u8f6c\u53d1\u5230\u8fdc\u7aef\u526a\u8d34\u677f\uff0c\u671f\u95f4\u753b\u9762\u53ef\u80fd\u77ed\u6682\u964d\u901f\u3002",
              phase: "\u526a\u8d34\u677f\u6865\u63a5",
              kind: "info",
              progress: null,
              indeterminate: true,
              priority: 78,
              expiresAt: Date.now() + 7000
            });
            break;
          }
        }
      },
      true
    );

    window.addEventListener("message", function (event) {
      var data = event && event.data;
      if (data && data.type === "clipboardTransferState") {
        if (data.status === "start") {
          setHighLoadState(true, "clipboard image");
          scheduleHighLoadRelease("clipboard image", 12000);
          setActivityTask("clipboard-image", {
            title: "\u6b63\u5728\u7c98\u8d34\u56fe\u7247",
            detail: data.detail || "\u6b63\u5728\u8bfb\u53d6\u56fe\u7247\u5e76\u4f20\u5230\u8fdc\u7aef\u526a\u8d34\u677f\u3002",
            phase: "\u526a\u8d34\u677f\u6865\u63a5",
            kind: "info",
            progress: null,
            indeterminate: true,
            priority: 78,
            expiresAt: Date.now() + 12000
          });
          return;
        }
        if (data.status === "end") {
          setHighLoadState(false, "clipboard image");
          completeActivityTask("clipboard-image", "\u526a\u8d34\u677f\u540c\u6b65\u5b8c\u6210\u3002", "success", 2000);
          return;
        }
        if (data.status === "error") {
          setHighLoadState(false, "clipboard image");
          setActivityTask("clipboard-image", {
            title: "\u7c98\u8d34\u5931\u8d25",
            detail: data.detail || "\u56fe\u7247\u526a\u8d34\u677f\u4f20\u8f93\u672a\u5b8c\u6210\u3002",
            phase: "\u9519\u8bef",
            kind: "error",
            progress: null,
            indeterminate: true,
            priority: 88,
            expiresAt: Date.now() + 4000
          });
          return;
        }
      }
      if (!data || data.type !== "clipboardContentUpdate") return;
      setHighLoadState(false, "clipboard image");
      var incomingText = typeof data.text === "string" ? data.text : "";
      if (pendingRemoteClipboardPull && incomingText) {
        if (pendingRemoteClipboardPull.timerId) {
          window.clearTimeout(pendingRemoteClipboardPull.timerId);
        }
        if (isImageClipboardStatusText(incomingText)) {
          setActivityTask("clipboard-force-remote", {
            title: "\u5df2\u8986\u76d6\u672c\u673a\u526a\u8d34\u677f",
            detail: "\u5df2\u5c06 Selkies \u4f1a\u8bdd\u4e2d\u7684\u56fe\u7247\u5199\u5165\u5f53\u524d\u5ba2\u6237\u7aef\u526a\u8d34\u677f\u3002",
            phase: "\u8fdc\u7aef -> \u5ba2\u6237\u7aef",
            kind: "success",
            progress: 100,
            indeterminate: false,
            priority: 76,
            expiresAt: Date.now() + 2600
          });
          pendingRemoteClipboardPull = null;
        } else {
          writePayloadToClientClipboard({ type: "text", text: incomingText })
            .then(function () {
              setActivityTask("clipboard-force-remote", {
                title: "\u5df2\u8986\u76d6\u672c\u673a\u526a\u8d34\u677f",
                detail: "\u5df2\u7528 Selkies \u4f1a\u8bdd\u7684\u526a\u8d34\u677f\u5185\u5bb9\u66f4\u65b0\u5f53\u524d\u5ba2\u6237\u7aef\u7cfb\u7edf\u526a\u8d34\u677f\u3002",
                phase: "\u8fdc\u7aef -> \u5ba2\u6237\u7aef",
                kind: "success",
                progress: 100,
                indeterminate: false,
                priority: 76,
                expiresAt: Date.now() + 2600
              });
            })
            .catch(function () {
              setActivityTask("clipboard-force-remote", {
                title: "\u5199\u5165\u672c\u673a\u526a\u8d34\u677f\u5931\u8d25",
                detail: "\u6d4f\u89c8\u5668\u62d2\u7edd\u4e86\u5199\u5165\u7cfb\u7edf\u526a\u8d34\u677f\uff0c\u8bf7\u786e\u8ba4 HTTPS \u548c\u6d4f\u89c8\u5668\u6743\u9650\u3002",
                phase: "\u8fdc\u7aef -> \u5ba2\u6237\u7aef",
                kind: "error",
                progress: null,
                indeterminate: true,
                priority: 86,
                expiresAt: Date.now() + 3600
              });
            })
            .finally(function () {
              pendingRemoteClipboardPull = null;
            });
        }
      }
      completeActivityTask("clipboard-image", "\u526a\u8d34\u677f\u540c\u6b65\u5b8c\u6210\u3002", "success", 2000);
    });
  }

  function installFileTransferTransportInterceptor() {
    if (!window.WebSocket || !window.WebSocket.prototype || window.WebSocket.prototype.__selkiesFileTransferWrapped) {
      return;
    }

    function getSocketTransferState(socket) {
      if (!fileTransferSockets) return null;
      var state = fileTransferSockets.get(socket);
      if (!state) {
        state = {
          queue: [],
          flushing: false,
          uploadState: null,
          pendingEndMessage: null
        };
        fileTransferSockets.set(socket, state);
      }
      return state;
    }

    function getUploadFlushDelayMs() {
      if (dynamicLatencyApplied) {
        return 18;
      }
      if (Date.now() - dynamicLatencyInteractionAt < 1800) {
        return 10;
      }
      return 2;
    }

    function clonePayloadBytes(payload) {
      if (payload instanceof ArrayBuffer) {
        return payload.slice(0);
      }
      if (ArrayBuffer.isView(payload)) {
        return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
      }
      return payload;
    }

    var originalSend = window.WebSocket.prototype.send;

    function flushUploadQueue(socket, transportState) {
      if (!transportState || transportState.flushing) return;
      transportState.flushing = true;

      function step() {
        if (!transportState) return;
        if (socket.readyState !== window.WebSocket.OPEN) {
          transportState.queue = [];
          transportState.pendingEndMessage = null;
          transportState.flushing = false;
          if (transportState.uploadState && typeof window.__selkiesMarkManagedTransferError === "function") {
            window.__selkiesMarkManagedTransferError(
              transportState.uploadState.fileName,
              "\u4e0a\u4f20\u901a\u9053\u5df2\u65ad\u5f00\u3002",
              "upload"
            );
          }
          transportState.uploadState = null;
          return;
        }

        if (transportState.queue.length) {
          var chunk = transportState.queue.shift();
          try {
            originalSend.call(socket, chunk);
          } catch (_err) {
            transportState.queue = [];
            transportState.pendingEndMessage = null;
            transportState.flushing = false;
            if (transportState.uploadState && typeof window.__selkiesMarkManagedTransferError === "function") {
              window.__selkiesMarkManagedTransferError(
                transportState.uploadState.fileName,
                "\u4e0a\u4f20\u5206\u7247\u53d1\u9001\u5931\u8d25\u3002",
                "upload"
              );
            }
            transportState.uploadState = null;
            return;
          }
          if (transportState.uploadState) {
            transportState.uploadState.transportAware = true;
            transportState.uploadState.status = "progress";
            transportState.uploadState.sentBytes += Math.max(0, chunk.byteLength - 1);
            if (typeof window.__selkiesRenderManagedFileTransfer === "function") {
              window.__selkiesRenderManagedFileTransfer(transportState.uploadState);
            }
          }
          window.setTimeout(step, getUploadFlushDelayMs());
          return;
        }

        if (transportState.pendingEndMessage) {
          try {
            originalSend.call(socket, transportState.pendingEndMessage);
          } catch (_err2) {
            if (transportState.uploadState && typeof window.__selkiesMarkManagedTransferError === "function") {
              window.__selkiesMarkManagedTransferError(
                transportState.uploadState.fileName,
                "\u4e0a\u4f20\u5b8c\u6210\u4fe1\u53f7\u53d1\u9001\u5931\u8d25\u3002",
                "upload"
              );
            }
            transportState.pendingEndMessage = null;
            transportState.uploadState = null;
            transportState.flushing = false;
            return;
          }
          if (transportState.uploadState) {
            transportState.uploadState.status = "finalizing";
            if (typeof window.__selkiesRenderManagedFileTransfer === "function") {
              window.__selkiesRenderManagedFileTransfer(transportState.uploadState);
            }
            if (typeof window.__selkiesScheduleManagedTransferCompletion === "function") {
              window.__selkiesScheduleManagedTransferCompletion(transportState.uploadState, 1000);
            }
          }
          transportState.pendingEndMessage = null;
          transportState.uploadState = null;
          transportState.flushing = false;
          return;
        }

        transportState.flushing = false;
      }

      step();
    }

    window.WebSocket.prototype.send = function (payload) {
      var transportState = getSocketTransferState(this);
      if (!transportState) {
        return originalSend.call(this, payload);
      }

      if (typeof payload === "string") {
        if (payload.indexOf("FILE_UPLOAD_START:") === 0) {
          var parts = payload.split(":", 3);
          var uploadName = parts.length > 1 ? parts[1] : "\u6587\u4ef6\u4f20\u8f93";
          var uploadSize = parts.length > 2 ? parseInt(parts[2], 10) : 0;
          if (typeof window.__selkiesEnsureManagedFileTransfer === "function") {
            transportState.uploadState = window.__selkiesEnsureManagedFileTransfer(uploadName, uploadSize, "upload");
            transportState.uploadState.transportAware = true;
            transportState.uploadState.status = "start";
            if (typeof window.__selkiesRenderManagedFileTransfer === "function") {
              window.__selkiesRenderManagedFileTransfer(transportState.uploadState);
            }
          }
          return originalSend.call(this, payload);
        }
        if (payload.indexOf("FILE_UPLOAD_END:") === 0 && transportState.uploadState) {
          transportState.pendingEndMessage = payload;
          flushUploadQueue(this, transportState);
          return;
        }
        if (payload.indexOf("FILE_UPLOAD_ERROR:") === 0 && transportState.uploadState) {
          if (typeof window.__selkiesMarkManagedTransferError === "function") {
            window.__selkiesMarkManagedTransferError(
              transportState.uploadState.fileName,
              payload,
              "upload"
            );
          }
          transportState.queue = [];
          transportState.pendingEndMessage = null;
          transportState.uploadState = null;
          transportState.flushing = false;
        }
        return originalSend.call(this, payload);
      }

      if (!transportState.uploadState) {
        return originalSend.call(this, payload);
      }

      var bytes = clonePayloadBytes(payload);
      if (!(bytes instanceof ArrayBuffer)) {
        return originalSend.call(this, payload);
      }
      var view = new Uint8Array(bytes);
      if (!view.length || view[0] !== 1) {
        return originalSend.call(this, payload);
      }
      transportState.queue.push(bytes);
      flushUploadQueue(this, transportState);
    };

    window.WebSocket.prototype.__selkiesFileTransferWrapped = true;
  }

  function requestClipboardSync(reason) {
    var now = Date.now();
    if (reason === "contextmenu" && now - lastClipboardTriggerAt < 120) return;
    lastClipboardTriggerAt = now;
    sendRawDataCommand("cr");
  }

  function clearClipboardSyncBurst() {
    while (clipboardSyncBurstTimerIds.length) {
      window.clearTimeout(clipboardSyncBurstTimerIds.pop());
    }
  }

  function scheduleClipboardSyncBurst(reason, delays) {
    var sequence = Array.isArray(delays) && delays.length ? delays : [80, 220, 480];
    for (var i = 0; i < sequence.length; i += 1) {
      (function (delayMs) {
        clipboardSyncBurstTimerIds.push(
          window.setTimeout(function () {
            requestClipboardSync(reason);
          }, Math.max(0, delayMs))
        );
      })(sequence[i]);
    }
  }

  function bindClipboardSyncTriggers() {
    document.addEventListener(
      "keydown",
        function (event) {
          var bucket = getModifierGestureBucket(event);
          if (bucket) {
            if (!event.repeat) {
              noteUiInteraction();
              if (!bucket.down && Date.now() - bucket.lastTapAt <= 360) {
                triggerModifierGesture(bucket);
              }
              bucket.down = true;
              bucket.chorded = false;
            clearModifierHold(bucket);
            bucket.holdTimer = window.setTimeout(function () {
              if (bucket.down && !bucket.chorded) {
                triggerModifierGesture(bucket);
              }
            }, 1000);
            }
            var modifierKey = String((event && event.key) || "");
            if (modifierKey === "Control" || modifierKey === "Meta" || modifierKey === "Alt" || modifierKey === "Option") {
              return;
            }
          }
        var key = String((event && event.key) || "");
        if (!(event && (event.ctrlKey || event.metaKey) && !event.altKey)) return;
        var normalizedKey = key.toLowerCase();
        if (normalizedKey === "c" || normalizedKey === "x" || normalizedKey === "insert") {
          scheduleClipboardSyncBurst("copy-shortcut", [120, 260, 520, 900, 1400]);
        } else if (normalizedKey === "v") {
          scheduleClipboardSyncBurst("paste-shortcut", [80, 220, 480]);
        }
      },
      true
    );

    document.addEventListener(
      "keyup",
      function (event) {
        var key = String((event && event.key) || "");
        if (key !== "Control" && key !== "Meta" && key !== "Alt" && key !== "Option") return;
      },
      true
    );

    document.addEventListener(
      "copy",
      function () {
        scheduleClipboardSyncBurst("copy-event", [140, 320, 700, 1200]);
      },
      true
    );

    document.addEventListener(
      "cut",
      function () {
        scheduleClipboardSyncBurst("cut-event", [140, 320, 700, 1200]);
      },
      true
    );

    document.addEventListener(
      "pointerdown",
      function (event) {
        if (!event || event.button !== 2) return;
        requestClipboardSync("right-button");
      },
      true
    );

    document.addEventListener(
      "contextmenu",
      function () {
        requestClipboardSync("contextmenu");
      },
      true
    );

    document.addEventListener(
      "keydown",
      function (event) {
        var bucket = getModifierGestureBucket(event);
        if (bucket) return;
        if (modifierGestureState.clientToRemote.down) {
          modifierGestureState.clientToRemote.chorded = true;
          clearModifierHold(modifierGestureState.clientToRemote);
        }
        if (modifierGestureState.remoteToClient.down) {
          modifierGestureState.remoteToClient.chorded = true;
          clearModifierHold(modifierGestureState.remoteToClient);
        }
      },
      true
    );

    document.addEventListener(
      "keyup",
      function (event) {
        var bucket = getModifierGestureBucket(event);
        if (!bucket) return;
        clearModifierHold(bucket);
        var shouldRememberTap = bucket.down && !bucket.chorded && Date.now() - bucket.lastTriggerAt > 120;
        bucket.down = false;
        bucket.chorded = false;
        if (shouldRememberTap) {
          bucket.lastTapAt = Date.now();
        }
      },
      true
    );
  }

  function hideDisabledGamepadUi() {
    if (GAMEPAD_UI_ENABLED || !document.body) return;

    var host = document.getElementById("touch-gamepad-host");
    if (host) {
      host.innerHTML = "";
      host.style.display = "none";
    }

    var sidebarHost = findLocalLinkSidebarHost();
    if (!sidebarHost) return;

    var exactTexts = [
      "gamepads",
      "gamepad",
      "touch gamepad",
      "gamepad support",
      "\u6e38\u620f\u624b\u67c4",
      "\u6e38\u620f\u624b\u67c4\u652f\u6301",
      "\u542f\u7528/\u7981\u7528\u6e38\u620f\u624b\u67c4\u652f\u6301",
      "player 2",
      "player 3",
      "player 4"
    ];
    var nodes = sidebarHost.querySelectorAll("details,section,article,div,button,label,summary,span");
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (!isElementVisible(node)) continue;
      var text = String(node.innerText || node.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (!text) continue;
      if (exactTexts.indexOf(text) < 0) continue;
      var container = node.closest("details,section,article,li,div");
      if (!container || container === sidebarHost) continue;
      if (container.getBoundingClientRect().height < 18) continue;
      container.style.display = "none";
      container.setAttribute("data-selkies-gamepad-hidden", "1");
    }
  }

  function startGamepadUiGuard() {
    hideDisabledGamepadUi();
    window.setTimeout(hideDisabledGamepadUi, 1200);
    window.setInterval(hideDisabledGamepadUi, 8000);
  }

  function getDynamicLatencyConfig() {
    return {
      enabled: sanitizeBool(getStoredValue("dynamic_low_latency_enabled"), sanitizeBool(runtime.dynamicLowLatencyEnabled, true)),
      holdMs: sanitizeInt(getStoredValue("dynamic_low_latency_hold_ms"), sanitizeInt(runtime.dynamicLowLatencyHoldMs, 1600, 300, 10000), 300, 10000),
      fps: sanitizeInt(getStoredValue("dynamic_low_latency_fps"), sanitizeInt(runtime.dynamicLowLatencyFps, 36, 8, 120), 8, 120),
      crf: sanitizeInt(getStoredValue("dynamic_low_latency_h264_crf"), sanitizeInt(runtime.dynamicLowLatencyH264Crf, 45, 5, 60), 5, 60),
      samplePercent: sanitizeInt(
        getStoredValue("dynamic_low_latency_sample_percent"),
        sanitizeInt(runtime.dynamicLowLatencySamplePercent, 60, 33, 100),
        33,
        100
      ),
      disablePaintOver: sanitizeBool(
        getStoredValue("dynamic_low_latency_disable_paint_over"),
        sanitizeBool(runtime.dynamicLowLatencyDisablePaintOver, true)
      )
    };
  }

  function syncDynamicLatencySettingsToBackend() {
    var config = getDynamicLatencyConfig();
    lastDynamicLatencyConfigSignature = getDynamicLatencyConfigSignature(config);
    postDashboardMessage("settings", {
      settings: {
        displayId: "primary",
        dynamic_low_latency_enabled: config.enabled,
        dynamic_low_latency_fps: config.fps,
        dynamic_low_latency_h264_crf: config.crf,
        dynamic_low_latency_sample_percent: config.samplePercent,
        dynamic_low_latency_disable_paint_over: config.disablePaintOver
      }
    });
  }

  function findPrimaryStreamSurface() {
    var surface = document.getElementById("stream");
    if (surface && isElementVisible(surface)) return surface;
    var canvases = Array.prototype.slice.call(document.querySelectorAll("canvas"));
    canvases.sort(function (left, right) {
      var lRect = left.getBoundingClientRect();
      var rRect = right.getBoundingClientRect();
      return rRect.width * rRect.height - lRect.width * lRect.height;
    });
    for (var i = 0; i < canvases.length; i += 1) {
      if (isElementVisible(canvases[i])) return canvases[i];
    }
    return null;
  }

  function syncSidebarToggleLowLatencyState() {
    var toggle = findSidebarToggleButton();
    if (!toggle) return;
    toggle.setAttribute("data-selkies-sidebar-toggle", "1");
    toggle.style.setProperty("position", "fixed", "important");
    toggle.style.setProperty("left", "0px", "important");
    toggle.style.setProperty("right", "auto", "important");
    toggle.style.setProperty("top", "50%", "important");
    toggle.style.setProperty("bottom", "auto", "important");
    toggle.style.setProperty("transform", "translateY(-50%)", "important");
    toggle.style.setProperty("margin", "0", "important");
    toggle.style.setProperty("z-index", "10002", "important");
    var indicator = toggle.querySelector(".selkies-sidebar-rainbow-core");
    if (!indicator) {
      indicator = document.createElement("span");
      indicator.className = "selkies-sidebar-rainbow-core";
      indicator.setAttribute("aria-hidden", "true");
      toggle.appendChild(indicator);
    }
    if (dynamicLatencyApplied && getDynamicLatencyConfig().enabled) {
      toggle.setAttribute("data-selkies-low-latency", "active");
      indicator.setAttribute("data-active", "1");
    } else {
      toggle.removeAttribute("data-selkies-low-latency");
      indicator.removeAttribute("data-active");
    }
  }

  function postDashboardMessage(type, payload) {
    var message = Object.assign({ type: type }, payload || {});
    window.postMessage(message, window.location.origin);
  }

  function clearEncoderResetTimers() {
    while (encoderResetTimerIds.length) {
      window.clearTimeout(encoderResetTimerIds.pop());
    }
  }

  function currentEncoderName() {
    return String(getStoredValue("encoder") || preferredEncoder() || FALLBACK_ENCODER).toLowerCase();
  }

  function postPrimarySettings(settingsPatch) {
    postDashboardMessage("settings", {
      settings: Object.assign({ displayId: "primary" }, settingsPatch || {})
    });
  }

  function runEncoderResetSequence() {
    clearEncoderResetTimers();
    var encoder = currentEncoderName();
    var canToggleVaapi = encoder === "x264enc" && sanitizeBool(runtime.driAvailable, false);
    if (canToggleVaapi) {
      postPrimarySettings({ encoder: encoder, use_cpu: true });
      encoderResetTimerIds.push(
        window.setTimeout(function () {
          postPrimarySettings({ encoder: encoder, use_cpu: false });
        }, 750)
      );
      encoderResetTimerIds.push(
        window.setTimeout(function () {
          sendRawDataCommand("FORCE_STREAM_RECOVER,primary");
        }, 1500)
      );
      return;
    }

    postPrimarySettings({ encoder: "jpeg", use_cpu: true });
    encoderResetTimerIds.push(
      window.setTimeout(function () {
        postPrimarySettings({ encoder: encoder, use_cpu: readUseCpuHint(false) });
      }, 850)
    );
    encoderResetTimerIds.push(
      window.setTimeout(function () {
        sendRawDataCommand("FORCE_STREAM_RECOVER,primary");
      }, 1600)
    );
  }

  function getDynamicLatencyConfigSignature(config) {
    var safe = config || getDynamicLatencyConfig();
    return [
      safe.enabled ? "1" : "0",
      String(safe.fps),
      String(safe.crf),
      String(safe.samplePercent),
      safe.disablePaintOver ? "1" : "0"
    ].join("|");
  }

  function captureDynamicLatencyOriginals() {
    if (dynamicLatencyOriginals) return dynamicLatencyOriginals;
    dynamicLatencyOriginals = {
      videoBitrate: sanitizeInt(getStoredValue("video_bitrate"), sanitizeInt(runtime.defaultVideoBitrate, 8, 1, 200), 1, 200)
    };
    return dynamicLatencyOriginals;
  }

  function applyDynamicLatencyEncodingProfile(active, config) {
    sendDynamicLatencyState(active, active ? "interaction" : "restore");
  }

  function suppressDynamicLatency(ms) {
    dynamicLatencySuppressedUntil = Math.max(dynamicLatencySuppressedUntil, Date.now() + Math.max(0, Number(ms) || 0));
  }

  function ensureDynamicLatencyStyle() {
    if (document.getElementById("selkies-dynamic-latency-runtime-style")) return;
    var style = document.createElement("style");
    style.id = "selkies-dynamic-latency-runtime-style";
    style.textContent =
      "body.selkies-low-latency-active #selkies-activity-layer{pointer-events:none}" +
      "body.selkies-low-latency-active .selkies-activity-card{box-shadow:none;backdrop-filter:none;transform:none}" +
      "body.selkies-low-latency-active #selkies-activity-banner{box-shadow:none;backdrop-filter:none}" +
      "body.selkies-low-latency-active #selkies-local-link-prompt{box-shadow:0 10px 22px rgba(2,6,23,.22);backdrop-filter:none}" +
      "body.selkies-low-latency-active canvas{image-rendering:optimizeSpeed}" +
      "body.selkies-low-latency-active *{scroll-behavior:auto !important}" +
      "[data-selkies-sidebar-toggle='1']{position:relative;overflow:hidden;transition:color .24s ease,transform .24s ease}" +
      "[data-selkies-sidebar-toggle='1'] .selkies-sidebar-rainbow-core{position:absolute;top:18%;bottom:18%;left:50%;width:4px;transform:translateX(-50%);border-radius:999px;opacity:0;pointer-events:none;z-index:2;transition:opacity .24s ease,box-shadow .24s ease}" +
      "[data-selkies-sidebar-toggle='1'] .selkies-sidebar-rainbow-core[data-active='1']{opacity:1;background:linear-gradient(180deg,#ff5f6d 0%,#ffc371 20%,#7c3aed 42%,#06b6d4 68%,#22c55e 100%);background-size:100% 220%;animation:selkies-rainbow-fill 1.8s linear infinite;box-shadow:0 0 12px rgba(56,189,248,.32)}" +
      "[data-selkies-sidebar-toggle='1']::after{content:'';position:absolute;top:18%;bottom:18%;left:50%;width:4px;transform:translateX(-50%);border-radius:999px;opacity:0;pointer-events:none;transition:opacity .24s ease,box-shadow .24s ease}" +
      "[data-selkies-sidebar-toggle='1'][data-selkies-low-latency='active']::after{opacity:1;background:linear-gradient(180deg,#ff5f6d 0%,#ffc371 20%,#7c3aed 42%,#06b6d4 68%,#22c55e 100%);background-size:100% 220%;animation:selkies-rainbow-fill 1.8s linear infinite;box-shadow:0 0 12px rgba(56,189,248,.32)}" +
      "[data-selkies-sidebar-toggle='1'][data-selkies-low-latency='active'] svg,[data-selkies-sidebar-toggle='1'][data-selkies-low-latency='active'] path,[data-selkies-sidebar-toggle='1'][data-selkies-low-latency='active'] span,[data-selkies-sidebar-toggle='1'][data-selkies-low-latency='active'] i{animation:selkies-rainbow-fg 1.8s linear infinite;color:#ff5f6d !important;fill:currentColor !important;stroke:currentColor !important}" +
      "@keyframes selkies-rainbow-fg{0%{color:#ff5f6d}20%{color:#ffc371}40%{color:#7c3aed}60%{color:#06b6d4}80%{color:#22c55e}100%{color:#ff5f6d}}" +
      "@keyframes selkies-rainbow-fill{0%{background-position:50% 0%}100%{background-position:50% 100%}}";
    document.head.appendChild(style);
  }

  function applyDynamicLatencyProfile(active, config) {
    ensureDynamicLatencyStyle();
    if (!document.body) return;
    document.body.classList.toggle("selkies-low-latency-active", !!active);
    document.body.style.setProperty("--selkies-low-latency-sample", String((config && config.samplePercent) || 85));
    if (active) {
      applyDynamicLatencyEncodingProfile(true, config);
    } else {
      applyDynamicLatencyEncodingProfile(false, getDynamicLatencyConfig());
    }
    syncSidebarToggleLowLatencyState();
    if (!active) return;
    var motionInterval = Math.max(16, Math.round(1000 / Math.max(8, config.fps || 36)));
    document.body.setAttribute("data-selkies-low-latency-motion-ms", String(motionInterval));
    document.body.setAttribute("data-selkies-low-latency-level", String(config.crf || 34));
    document.body.setAttribute("data-selkies-low-latency-effects", config.disablePaintOver ? "minimal" : "normal");
  }

  function restoreDynamicLatency() {
    if (!dynamicLatencyApplied) return;
    dynamicLatencyApplied = false;
    applyDynamicLatencyProfile(false, getDynamicLatencyConfig());
  }

  function activateDynamicLatency(trigger) {
    var config = getDynamicLatencyConfig();
    if (!config.enabled) return;
    if (Date.now() < dynamicLatencySuppressedUntil) return;
    if (!lastVideoPipelineActive) return;
    if (!hasVisibleStreamSurface()) return;
    if (streamRecoveryInFlight || streamRecoveryStage > 0) return;
    if (isTransportBusy() && !(window.__selkiesHasActiveFileTransfer && window.__selkiesHasActiveFileTransfer())) return;
    if (lastDynamicLatencyConfigSignature !== getDynamicLatencyConfigSignature(config)) {
      syncDynamicLatencySettingsToBackend();
    }
    dynamicLatencyUntil = Date.now() + config.holdMs;
    dynamicLatencyInteractionAt = Date.now();
    if (!dynamicLatencyApplied) {
      captureDynamicLatencyOriginals();
      dynamicLatencyApplied = true;
      applyDynamicLatencyProfile(true, config);
    }
  }

  function ensureDynamicLatencySection() {
    var section = document.getElementById("selkies-dynamic-latency-section");
    if (section) return section;

    section = document.createElement("div");
    section.id = "selkies-dynamic-latency-section";
    section.className = "selkies-link-sidebar";
    section.innerHTML =
      '<details class="selkies-link-details">' +
      '<summary class="selkies-link-summary">' +
      '<span class="selkies-link-sidebar-title">\u52a8\u6001\u4f4e\u5ef6\u8fdf</span>' +
      '<span class="selkies-link-summary-meta">\u4ea4\u4e92\u964d\u5ef6\u8fdf</span>' +
      "</summary>" +
      '<div class="selkies-link-details-body">' +
      '<div class="selkies-dll-grid">' +
      '<div class="selkies-dll-row selkies-dll-row-compact"><span>\u542f\u7528\u52a8\u6001\u52a0\u901f</span><input type="checkbox" data-dll="enabled"></div>' +
      '<div class="selkies-dll-field"><div class="selkies-dll-row"><span>\u52a0\u901f\u4fdd\u6301\u65f6\u957f</span><div class="selkies-dll-value" data-dll-value="hold"></div></div><input type="range" min="300" max="5000" step="100" data-dll="hold"><div class="selkies-dll-note">\u6ed1\u5757\u8d8a\u9760\u53f3\uff0c\u6bcf\u6b21\u4ea4\u4e92\u89e6\u53d1\u540e\u4f4e\u5ef6\u8fdf\u4f1a\u4fdd\u6301\u66f4\u4e45\u3002</div></div>' +
      '<div class="selkies-dll-field"><div class="selkies-dll-row"><span>\u4ea4\u4e92\u91c7\u6837\u5f3a\u5ea6</span><div class="selkies-dll-value" data-dll-value="fps"></div></div><input type="range" min="8" max="60" step="1" data-dll="fps"><div class="selkies-dll-note">\u6ed1\u5757\u8d8a\u9760\u53f3\uff0c\u4ea4\u4e92\u66f4\u5bb9\u6613\u89e6\u53d1\u52a0\u901f\uff0c\u540c\u65f6\u4f4e\u5ef6\u8fdf\u671f\u95f4\u5141\u8bb8\u66f4\u9ad8\u7684\u53d1\u9001\u5e27\u7387\u4e0a\u9650\u3002</div></div>' +
      '<div class="selkies-dll-field"><div class="selkies-dll-row"><span>\u754c\u9762\u964d\u8f7d\u7ea7\u522b</span><div class="selkies-dll-value" data-dll-value="crf"></div></div><input type="range" min="5" max="60" step="1" data-dll="crf"><div class="selkies-dll-note">\u6ed1\u5757\u8d8a\u9760\u53f3\uff0c\u8d8a\u4f1a\u62c9\u9ad8\u8f93\u5165\u4f18\u5148\u7a97\u53e3\uff0c\u5e76\u5728\u4ea4\u4e92\u671f\u95f4\u66f4\u4e3b\u52a8\u5730\u8ba9\u89c6\u9891\u53d1\u9001\u9000\u8ba9\u7ed9\u64cd\u4f5c\u54cd\u5e94\u3002</div></div>' +
      '<div class="selkies-dll-field"><div class="selkies-dll-row"><span>\u91c7\u6837\u538b\u7f29</span><div class="selkies-dll-value" data-dll-value="sample"></div></div><input type="range" min="33" max="100" step="1" data-dll="sample"><div class="selkies-dll-note">\u6ed1\u5757\u8d8a\u9760\u5de6\uff0c\u4ea4\u4e92\u671f\u95f4\u5bf9\u540e\u7aef H264/JPEG \u7f16\u7801\u7684\u538b\u7f29\u8d8a\u5f3a\uff0c\u9ad8\u8d1f\u8f7d\u65f6\u7684\u89c6\u9891\u53d1\u9001\u4e5f\u4f1a\u66f4\u79ef\u6781\u5730\u9000\u8ba9\u3002</div></div>' +
      '<div class="selkies-dll-row selkies-dll-row-compact"><span>\u7cbe\u7b80\u7279\u6548</span><input type="checkbox" data-dll="paint"></div>' +
      "</div>" +
      "</div>" +
      "</details>";
    return section;
  }

  function renderDynamicLatencySection() {
    var host = findLocalLinkSidebarHost();
    if (!host) return;
    ensureLocalLinkUiStyle();
    var section = ensureDynamicLatencySection();
    if (section.parentElement !== host) {
      host.appendChild(section);
    }
    if (!document.getElementById("selkies-dll-style")) {
      var style = document.createElement("style");
      style.id = "selkies-dll-style";
      style.textContent =
        ".selkies-dll-grid{display:flex;flex-direction:column;gap:10px}" +
        ".selkies-dll-field{display:flex;flex-direction:column;gap:6px}" +
        ".selkies-dll-row{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11px;color:#e2e8f0}" +
        ".selkies-dll-row-compact{padding:2px 0}" +
        ".selkies-dll-field input[type='range']{width:100%;accent-color:#38bdf8}" +
        ".selkies-dll-row input[type='checkbox']{accent-color:#38bdf8}" +
        ".selkies-dll-value{font-size:10px;color:#93c5fd;min-width:46px;text-align:right}" +
        ".selkies-dll-note{font-size:10px;line-height:1.45;color:#94a3b8}";
      document.head.appendChild(style);
    }

    var config = getDynamicLatencyConfig();
    section.querySelector('[data-dll="enabled"]').checked = config.enabled;
    section.querySelector('[data-dll="hold"]').value = String(config.holdMs);
    section.querySelector('[data-dll="fps"]').value = String(config.fps);
    section.querySelector('[data-dll="crf"]').value = String(config.crf);
    section.querySelector('[data-dll="sample"]').value = String(config.samplePercent);
    section.querySelector('[data-dll="paint"]').checked = config.disablePaintOver;
    section.querySelector('[data-dll-value="hold"]').textContent = (config.holdMs / 1000).toFixed(1) + "s";
    section.querySelector('[data-dll-value="fps"]').textContent = String(config.fps);
    section.querySelector('[data-dll-value="crf"]').textContent = String(config.crf);
    section.querySelector('[data-dll-value="sample"]').textContent = String(config.samplePercent) + "%";

    if (!section.dataset.bound) {
      section.dataset.bound = "1";
      section.addEventListener("input", function (event) {
        var target = event.target;
        if (!target || !target.dataset) return;
        var key = target.dataset.dll;
        if (key === "enabled") {
          setStoredValue("dynamic_low_latency_enabled", !!target.checked);
          syncDynamicLatencySettingsToBackend();
        } else if (key === "paint") {
          setStoredValue("dynamic_low_latency_disable_paint_over", !!target.checked);
          syncDynamicLatencySettingsToBackend();
        } else if (key === "hold") {
          setStoredValue("dynamic_low_latency_hold_ms", target.value);
          section.querySelector('[data-dll-value="hold"]').textContent = (Number(target.value) / 1000).toFixed(1) + "s";
        } else if (key === "fps") {
          setStoredValue("dynamic_low_latency_fps", target.value);
          section.querySelector('[data-dll-value="fps"]').textContent = target.value;
          syncDynamicLatencySettingsToBackend();
        } else if (key === "crf") {
          setStoredValue("dynamic_low_latency_h264_crf", target.value);
          section.querySelector('[data-dll-value="crf"]').textContent = target.value;
          syncDynamicLatencySettingsToBackend();
        } else if (key === "sample") {
          setStoredValue("dynamic_low_latency_sample_percent", target.value);
          section.querySelector('[data-dll-value="sample"]').textContent = target.value + "%";
          syncDynamicLatencySettingsToBackend();
          if (dynamicLatencyApplied) {
            applyDynamicLatencyEncodingProfile(true, getDynamicLatencyConfig());
          }
        }
      });
      section.addEventListener("change", function (event) {
        var target = event.target;
        if (!target || !target.dataset) return;
        var key = target.dataset.dll;
        if (key === "enabled") {
          setStoredValue("dynamic_low_latency_enabled", !!target.checked);
          syncDynamicLatencySettingsToBackend();
          if (!target.checked) {
            restoreDynamicLatency();
          }
        } else if (key === "paint") {
          setStoredValue("dynamic_low_latency_disable_paint_over", !!target.checked);
          syncDynamicLatencySettingsToBackend();
        }
      });
    }
  }

  function ensureRepairToolsSection() {
    var section = document.getElementById("selkies-repair-tools-section");
    if (section) return section;

    section = document.createElement("div");
    section.id = "selkies-repair-tools-section";
    section.className = "selkies-link-sidebar";
    section.innerHTML =
      '<details class="selkies-link-details" open>' +
      '<summary class="selkies-link-summary">' +
      '<span class="selkies-link-sidebar-title">\u8f93\u5165\u4e0e\u526a\u8d34\u677f\u4fee\u590d</span>' +
      '<span class="selkies-link-summary-meta">\u4e2d\u6587\u8f93\u5165 / \u540c\u6b65</span>' +
      "</summary>" +
      '<div class="selkies-link-details-body">' +
      '<div class="selkies-repair-tools-body">' +
      '<button type="button" class="selkies-repair-btn" data-repair-action="ime-clipboard-light">\u8f7b\u4fee\u590d\u8f93\u5165\u4e0e\u526a\u8d34\u677f</button>' +
      '<button type="button" class="selkies-repair-btn danger" data-repair-action="ime-clipboard-heavy">\u91cd\u4fee\u590d\u63a8\u6d41\u4e0e X11</button>' +
      '<div class="selkies-repair-note">\u7528\u4e8e\u5904\u7406\u4e2d\u6587\u8f93\u5165\u5361\u4f4f\u3001Ctrl+V \u4e0d\u540c\u6b65\u3001\u526a\u8d34\u677f\u72b6\u6001\u4e0d\u66f4\u65b0\u3002\u9001/\u6536\u526a\u677f\u5df2\u79fb\u5230\u5e95\u90e8\u5de5\u5177\u6761\u3002</div>' +
      "</div>" +
      "</div>" +
      "</details>";
    return section;
  }

  function repairImeAndClipboardLight() {
    noteUiInteraction();
    resetClientClipboardRuntime();
    clearAllHighLoadState("repair-ime");
    imeCompositionActive = false;
    var assist = normalizeKeyboardAssist();
    var active = document.activeElement;
    if (active && active !== document.body && active !== assist && typeof active.blur === "function") {
      try {
        active.blur();
      } catch (_err) {}
    }
    if (assist) {
      try {
        assist.value = "";
      } catch (_err2) {}
    }

    sendRawDataCommand("kr");
    scheduleKeyboardAssistFocus(0);
    window.setTimeout(function () {
      scheduleKeyboardAssistFocus(40);
    }, 40);
    window.setTimeout(function () {
      scheduleKeyboardAssistFocus(140);
    }, 140);
    window.setTimeout(function () {
      scheduleKeyboardAssistFocus(320);
    }, 320);

    sendRawDataCommand("RESET_IO_MODULES");
    requestClipboardSync("repair");
    window.setTimeout(function () {
      requestClipboardSync("repair");
    }, 120);
    window.setTimeout(function () {
      requestClipboardSync("repair");
    }, 320);
    setActivityTask("repair-ime-clipboard", {
      title: "\u5df2\u6267\u884c\u8f7b\u4fee\u590d",
      detail: "\u5df2\u91cd\u7f6e\u952e\u76d8\u4fee\u9970\u952e\u3001IME \u7126\u70b9\u4e0e\u526a\u8d34\u677f\u5185\u90e8\u72b6\u6001\uff0c\u672a\u91cd\u542f X11 \u6216\u63a8\u6d41\u3002",
      kind: "success",
      progress: 100,
      indeterminate: false,
      priority: 70,
      startedAt: Date.now(),
      expiresAt: Date.now() + 2600
    });
  }

  function repairImeAndClipboardHeavy() {
    repairImeAndClipboardLight();
    runEncoderResetSequence();
    window.setTimeout(function () {
      sendRawDataCommand("cmd,/scripts/recover-xstack.sh");
    }, 220);
    window.setTimeout(function () {
      restartStreamingPipelines("\u5df2\u6267\u884c\u4fee\u590d\uff0c\u6b63\u5728\u91cd\u7f6e\u8f93\u5165\u8f93\u51fa\u6a21\u5757\u3001\u7f16\u7801\u5668\u5e76\u91cd\u542f\u63a8\u6d41\u7cfb\u7edf\u3002");
    }, 1180);

    setActivityTask("repair-ime-clipboard", {
      title: "\u5df2\u6267\u884c\u91cd\u4fee\u590d",
      detail: "\u5df2\u6e05\u7a7a\u672c\u5730\u5185\u90e8\u526a\u8d34\u677f\u72b6\u6001\uff0c\u91cd\u7f6e\u8fdc\u7aef\u8f93\u5165\u8f93\u51fa\u6a21\u5757\uff0c\u91cd\u5efa IME \u7126\u70b9\uff0c\u5e76\u5f3a\u5236\u91cd\u7f6e\u7f16\u7801\u4e0e\u63a8\u6d41\u3002",
      kind: "success",
      progress: 100,
      indeterminate: false,
      priority: 70,
      startedAt: Date.now(),
      expiresAt: Date.now() + 3200
    });
  }

  function renderRepairToolsSection() {
    var host = findLocalLinkSidebarHost();
    if (!host) return;
    ensureLocalLinkUiStyle();
    var section = ensureRepairToolsSection();
    if (section.parentElement !== host || host.firstElementChild !== section) {
      host.insertBefore(section, host.firstChild);
    }
    if (!document.getElementById("selkies-repair-tools-style")) {
      var style = document.createElement("style");
      style.id = "selkies-repair-tools-style";
      style.textContent =
        ".selkies-repair-tools-body{display:flex;flex-direction:column;gap:10px}" +
        ".selkies-repair-btn{appearance:none;border:1px solid #166534;background:linear-gradient(180deg,#166534,#14532d);color:#ecfdf5;" +
        "border-radius:12px;padding:11px 12px;font-size:12px;font-weight:700;cursor:pointer;text-align:center}" +
        ".selkies-repair-btn:hover{filter:brightness(1.06)}" +
        ".selkies-repair-btn:active{transform:translateY(1px)}" +
        ".selkies-repair-btn.secondary{border-color:#334155;background:linear-gradient(180deg,#172554,#111827);color:#e2e8f0}" +
        ".selkies-repair-btn.danger{border-color:#7f1d1d;background:linear-gradient(180deg,#991b1b,#7f1d1d);color:#fee2e2}" +
        ".selkies-repair-note{font-size:10px;line-height:1.5;color:#94a3b8}";
      document.head.appendChild(style);
    }
    if (!section.dataset.bound) {
      section.dataset.bound = "1";
      section.querySelector("[data-repair-action='ime-clipboard-light']").addEventListener("click", function () {
        repairImeAndClipboardLight();
      });
      section.querySelector("[data-repair-action='ime-clipboard-heavy']").addEventListener("click", function () {
        repairImeAndClipboardHeavy();
      });
    }
  }

  function ensureDebugToolsSection() {
    var section = document.getElementById("selkies-debug-tools-section");
    if (section) return section;

    section = document.createElement("div");
    section.id = "selkies-debug-tools-section";
    section.className = "selkies-link-sidebar";
    section.innerHTML =
      '<details class="selkies-link-details">' +
      '<summary class="selkies-link-summary">' +
      '<span class="selkies-link-sidebar-title">\u5999\u5999\u5c0f\u5de5\u5177</span>' +
      '<span class="selkies-link-summary-meta">\u901a\u77e5</span>' +
      "</summary>" +
      '<div class="selkies-link-details-body">' +
      '<div class="selkies-repair-tools-body">' +
      '<label class="selkies-tool-row"><span>\u7a7f\u900f\u5f0f\u6d88\u606f\u63a8\u9001</span><input type="checkbox" data-debug-toggle="notification-passthrough"></label>' +
      '<label class="selkies-tool-row" data-debug-row="idle-focus-seconds"><span>QQ\u5931\u7126\u65f6\u95f4</span><select data-debug-select="idle-focus-seconds"><option value="0">\u4e0d\u5931\u7126</option><option value="1800">30\u5206\u949f</option><option value="600">\u5341\u5206\u949f</option><option value="300">\u4e94\u5206\u949f</option><option value="60">\u4e00\u5206\u949f</option></select></label>' +
      '<button type="button" class="selkies-repair-btn secondary" data-debug-action="notification-test">\u7a7f\u900f\u5f0f\u6d88\u606f\u63a8\u9001\u68c0\u6d4b</button>' +
      '<button type="button" class="selkies-repair-btn secondary" data-debug-action="wechat-audio-test">\u5fae\u4fe1\u6a21\u62df\u6d88\u606f\u63d0\u793a\u97f3\u6d4b\u8bd5</button>' +
      '<div class="selkies-repair-note">\u4e24\u79cd\u68c0\u6d4b\u6309\u94ae\u90fd\u4f1a\u5728 5 \u79d2\u5012\u8ba1\u65f6\u540e\u89e6\u53d1\u3002</div>' +
      "</div>" +
      "</div>" +
      "</details>";
    return section;
  }

  function renderDebugToolsSection() {
    var host = findLocalLinkSidebarHost();
    if (!host) return;
    ensureLocalLinkUiStyle();
    var section = ensureDebugToolsSection();
    if (section.parentElement !== host) {
      host.appendChild(section);
    }
    if (!document.getElementById("selkies-toolbox-style")) {
      var style = document.createElement("style");
      style.id = "selkies-toolbox-style";
      style.textContent =
        ".selkies-tool-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:2px 0;font-size:12px;color:#e2e8f0}" +
        ".selkies-tool-row input[type='checkbox']{accent-color:#38bdf8}" +
        ".selkies-tool-row[data-hidden='1']{display:none}" +
        ".selkies-tool-row select{min-width:112px;height:26px;padding:0 8px;border-radius:8px;border:1px solid rgba(71,85,105,.92);background:#101826;color:#e2e8f0;font-size:12px}";
      document.head.appendChild(style);
    }
    var notificationToggle = section.querySelector('[data-debug-toggle="notification-passthrough"]');
    var idleFocusRow = section.querySelector('[data-debug-row="idle-focus-seconds"]');
    var idleFocusSelect = section.querySelector('[data-debug-select="idle-focus-seconds"]');
    if (notificationToggle) {
      notificationToggle.checked = !!notificationPassthroughEnabled;
    }
    if (idleFocusRow) {
      idleFocusRow.setAttribute("data-hidden", notificationPassthroughEnabled ? "0" : "1");
    }
    if (idleFocusSelect) {
      idleFocusSelect.disabled = !notificationPassthroughEnabled;
      idleFocusSelect.value = String(qqIdleBlurSeconds);
    }
    if (!section.dataset.bound) {
      section.dataset.bound = "1";
      section.querySelector("[data-debug-action='notification-test']").addEventListener("click", function () {
        triggerPassthroughNotificationTest();
      });
      section.querySelector("[data-debug-action='wechat-audio-test']").addEventListener("click", function () {
        triggerWechatAudioNotificationTest();
      });
      section.querySelector('[data-debug-select="idle-focus-seconds"]').addEventListener("change", function (event) {
        var target = event && event.target;
        var nextValue = sanitizeInt(target && target.value, qqIdleBlurSeconds, 0, 1800);
        if ([0, 60, 300, 600, 1800].indexOf(nextValue) < 0) {
          nextValue = 600;
        }
        updateNotificationBridgeState({ idle_focus_seconds: nextValue })
          .then(function () {
            setActivityTask("notification-idle-focus-setting", {
              title: nextValue > 0 ? "已更新QQ失焦时间" : "已关闭QQ自动失焦",
              detail: nextValue > 0
                ? "穿透推送启用时，超过设定时长无交互会自动聚焦微信。"
                : "穿透推送启用时，不再自动切走 QQ 焦点。",
              kind: "success",
              progress: 100,
              indeterminate: false,
              priority: 72,
              expiresAt: Date.now() + 3200
            });
            renderDebugToolsSection();
          })
          .catch(function () {
            target.value = String(qqIdleBlurSeconds);
            setActivityTask("notification-idle-focus-setting", {
              title: "QQ失焦时间设置失败",
              detail: "未能更新后端的自动聚焦时长配置。",
              kind: "error",
              progress: null,
              indeterminate: true,
              priority: 82,
              expiresAt: Date.now() + 3600
            });
          });
      });
      section.querySelector('[data-debug-toggle="notification-passthrough"]').addEventListener("change", function (event) {
        var nextValue = !!(event && event.target && event.target.checked);
        var target = event.target;
        var applyMode = function () {
          updateNotificationBridgeState({ mode: nextValue ? "passthrough" : "internal" })
            .then(function () {
              setActivityTask("notification-mode-setting", {
                title: nextValue ? "\u5df2\u5f00\u542f\u7a7f\u900f\u5f0f\u6d88\u606f\u63a8\u9001" : "\u5df2\u6062\u590d\u5185\u7f6e\u6d88\u606f\u63d0\u9192",
                detail: nextValue ? "\u540e\u7eed QQ/\u5fae\u4fe1\u901a\u77e5\u5c06\u5c1d\u8bd5\u900f\u51fa\u5230\u6d4f\u89c8\u5668\u672c\u5730\u3002" : "\u540e\u7eed QQ/\u5fae\u4fe1\u901a\u77e5\u5c06\u7ee7\u7eed\u4f7f\u7528\u5bb9\u5668\u5185\u7f6e\u63d0\u9192\u3002",
                kind: "success",
                progress: 100,
                indeterminate: false,
                priority: 72,
                expiresAt: Date.now() + 3200
              });
              renderDebugToolsSection();
            })
            .catch(function () {
              notificationPassthroughEnabled = !nextValue;
              setStoredValue("notification_passthrough_enabled", notificationPassthroughEnabled);
              target.checked = notificationPassthroughEnabled;
              setActivityTask("notification-mode-setting", {
                title: "\u6d88\u606f\u63a8\u9001\u6a21\u5f0f\u8bbe\u7f6e\u5931\u8d25",
                detail: "\u672a\u80fd\u66f4\u65b0\u540e\u7aef\u901a\u77e5\u6295\u9012\u6a21\u5f0f\u3002",
                kind: "error",
                progress: null,
                indeterminate: true,
                priority: 82,
                expiresAt: Date.now() + 3600
              });
              renderDebugToolsSection();
            });
        };
        if (!nextValue) {
          applyMode();
          return;
        }
        requestBrowserNotificationPermission().then(function (permission) {
          if (permission !== "granted") {
            notificationPassthroughEnabled = false;
            setStoredValue("notification_passthrough_enabled", false);
            target.checked = false;
            setActivityTask("notification-mode-setting", {
              title: "\u6d88\u606f\u63a8\u9001\u6743\u9650\u672a\u6388\u4e88",
              detail: "\u6d4f\u89c8\u5668\u672a\u6388\u4e88 Notification \u6743\u9650\uff0c\u7a7f\u900f\u5f0f\u6d88\u606f\u63a8\u9001\u4fdd\u6301\u5173\u95ed\u3002",
              kind: "warning",
              progress: null,
              indeterminate: true,
              priority: 78,
              expiresAt: Date.now() + 3600
            });
            return;
          }
          applyMode();
        });
      });
    }
  }

  function ensureBottomActionDockStyle() {
    if (document.getElementById("selkies-bottom-action-dock-style")) return;
    var style = document.createElement("style");
    style.id = "selkies-bottom-action-dock-style";
    style.textContent =
      "#selkies-bottom-action-dock-shell{position:fixed;left:50%;bottom:2px;transform:translateX(-50%);z-index:10025;" +
      "display:flex;flex-direction:column;align-items:center;opacity:0;pointer-events:none;" +
      "transition:opacity .22s ease,transform .22s ease}" +
      "#selkies-bottom-action-dock-shell[data-visible='1']{opacity:1;pointer-events:auto}" +
      "#selkies-bottom-split-popover{position:absolute;left:50%;bottom:calc(100% + 2px);transform:translateX(-50%) translateY(8px) scale(.96);" +
      "display:flex;flex-direction:column;gap:6px;min-width:164px;padding:8px;" +
      "border:1px solid rgba(51,65,85,.92);border-radius:14px;background:rgba(8,15,28,.92);backdrop-filter:blur(16px);" +
      "box-shadow:0 12px 24px rgba(2,6,23,.28);opacity:0;pointer-events:none;visibility:hidden;" +
      "transition:opacity .18s ease,transform .18s ease,visibility .18s ease}" +
      "#selkies-bottom-action-dock-shell[data-split-open='1'] #selkies-bottom-split-popover{opacity:1;pointer-events:auto;visibility:visible;transform:translateX(-50%) translateY(0) scale(1)}" +
      "#selkies-bottom-action-dock{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:3px;padding:3px;" +
      "border:1px solid rgba(51,65,85,.92);border-radius:13px;background:rgba(8,15,28,.88);backdrop-filter:blur(16px);" +
      "box-shadow:0 8px 18px rgba(2,6,23,.18);transform-origin:center bottom;transition:opacity .24s ease,transform .24s ease,filter .24s ease}" +
      "#selkies-bottom-action-dock-shell[data-collapsed='1'] #selkies-bottom-action-dock{opacity:0;transform:translateY(10px) scale(.94);filter:blur(1px);pointer-events:none}" +
      "#selkies-bottom-action-dock-shell[data-collapsed='1'] #selkies-bottom-split-popover{opacity:0;pointer-events:none;visibility:hidden}" +
      "#selkies-bottom-dock-collapsed-toggle{appearance:none;border:1px solid rgba(71,85,105,.92);background:#101826;color:#e2e8f0;border-radius:10px;min-width:30px;height:24px;padding:0 8px;font-size:12px;font-weight:800;cursor:pointer;box-shadow:0 7px 16px rgba(2,6,23,.18);opacity:0;transform:translateY(8px) scale(.92);pointer-events:none;transition:opacity .24s ease,transform .24s ease,filter .24s ease}" +
      "#selkies-bottom-action-dock-shell[data-collapsed='1'] #selkies-bottom-dock-collapsed-toggle{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}" +
      ".selkies-bottom-dock-btn{appearance:none;border:1px solid rgba(71,85,105,.92);background:#101826;color:#e2e8f0;" +
      "border-radius:10px;min-width:48px;height:28px;padding:0 7px;font-size:10px;font-weight:700;letter-spacing:.01em;" +
      "cursor:pointer;transition:transform .12s ease,filter .12s ease,border-color .12s ease,background .12s ease}" +
      ".selkies-bottom-dock-btn:hover{filter:brightness(1.06)}" +
      ".selkies-bottom-dock-btn:active{transform:translateY(1px)}" +
      ".selkies-bottom-dock-btn[data-tone='send']{background:#0f2f6b;border-color:#2563eb;color:#dbeafe}" +
      ".selkies-bottom-dock-btn[data-tone='receive']{background:#4a183f;border-color:#ec4899;color:#fce7f3}" +
      ".selkies-bottom-dock-btn[data-tone='wechat']{background:#123321;border-color:#16a34a;color:#dcfce7}" +
      ".selkies-bottom-dock-btn[data-tone='qq']{background:#10273d;border-color:#38bdf8;color:#e0f2fe}" +
      ".selkies-bottom-dock-btn[data-tone='split']{background:#151d2b;border-color:#475569;color:#f8fafc;min-width:72px}" +
      ".selkies-bottom-dock-btn[data-tone='collapse']{background:#101826;border-color:#64748b;color:#cbd5e1;min-width:30px;padding:0 4px}" +
      ".selkies-bottom-dock-btn[data-active='1']{border-color:#93c5fd;color:#f8fafc}" +
      ".selkies-bottom-dock-btn[data-unread='1']{animation:selkies-unread-pulse .95s ease-in-out infinite}" +
      ".selkies-bottom-split-btn{appearance:none;border:1px solid rgba(71,85,105,.9);background:#101826;color:#e2e8f0;" +
      "border-radius:10px;height:30px;padding:0 8px;font-size:10px;font-weight:700;cursor:pointer;text-align:center;" +
      "transition:transform .12s ease,filter .12s ease,border-color .12s ease,background .12s ease}" +
      ".selkies-bottom-split-btn:hover{filter:brightness(1.08);border-color:#60a5fa}" +
      ".selkies-bottom-split-btn:active{transform:translateY(1px)}" +
      "@keyframes selkies-unread-pulse{0%{box-shadow:0 0 0 0 rgba(248,250,252,.0)}50%{box-shadow:0 0 0 2px rgba(248,250,252,.24),0 0 18px rgba(59,130,246,.24)}100%{box-shadow:0 0 0 0 rgba(248,250,252,.0)}}" +
      "@media (max-width:900px){#selkies-bottom-action-dock{gap:3px;padding:3px}.selkies-bottom-dock-btn{min-width:44px;height:26px;padding:0 5px;font-size:9px}.selkies-bottom-dock-btn[data-tone='split']{min-width:66px}.selkies-bottom-dock-btn[data-tone='collapse']{min-width:28px;padding:0 3px}}" +
      "@media (max-width:640px){#selkies-bottom-action-dock-shell{width:min(96vw,392px)}#selkies-bottom-action-dock{width:100%;grid-template-columns:repeat(6,minmax(0,1fr))}.selkies-bottom-dock-btn{min-width:0;padding:0 2px}}";
    document.head.appendChild(style);
  }

  function syncBottomActionSplitState() {
    var shell = document.getElementById("selkies-bottom-action-dock-shell");
    if (!shell) return;
    shell.setAttribute("data-split-open", bottomActionSplitOpen ? "1" : "0");
    shell.setAttribute("data-collapsed", bottomActionDockCollapsed ? "1" : "0");
    var splitButton = shell.querySelector('[data-dock-action="split-toggle"]');
    if (splitButton) {
      splitButton.setAttribute("data-active", bottomActionSplitOpen ? "1" : "0");
    }
  }

  function setBottomActionSplitOpen(open) {
    bottomActionSplitOpen = !!open;
    syncBottomActionSplitState();
  }

  function clearBottomActionDockRestoreTimer() {
    if (!bottomActionDockRestoreTimer) return;
    window.clearTimeout(bottomActionDockRestoreTimer);
    bottomActionDockRestoreTimer = null;
  }

  function scheduleBottomActionDockRestore() {
    clearBottomActionDockRestoreTimer();
    if (!bottomActionDockCollapsed) return;
    bottomActionDockRestoreTimer = window.setTimeout(function () {
      bottomActionDockRestoreTimer = null;
      setBottomActionDockCollapsed(false);
    }, 10000);
  }

  function setBottomActionDockCollapsed(collapsed) {
    bottomActionDockCollapsed = !!collapsed;
    setStoredValue("bottom_action_dock_collapsed", bottomActionDockCollapsed);
    if (bottomActionDockCollapsed) {
      bottomActionSplitOpen = false;
      scheduleBottomActionDockRestore();
    } else {
      clearBottomActionDockRestoreTimer();
    }
    syncBottomActionSplitState();
  }

  function runBottomDockRemoteCommand(command, title, detail) {
    noteUiInteraction();
    if (!hasOpenDataSocket()) {
      setActivityTask("bottom-dock-action", {
        title: "\u4f1a\u8bdd\u5c1a\u672a\u5c31\u7eea",
        detail: "\u5f53\u524d\u6ca1\u6709\u53ef\u7528\u7684 Selkies \u63a7\u5236\u901a\u9053\uff0c\u672a\u53d1\u9001\u6307\u4ee4\u3002",
        kind: "warning",
        progress: null,
        indeterminate: true,
        priority: 74,
        expiresAt: Date.now() + 2600
      });
      return false;
    }
    var sent = sendRawDataCommand("cmd," + command);
    setActivityTask("bottom-dock-action", {
      title: sent ? title : "\u6307\u4ee4\u53d1\u9001\u5931\u8d25",
      detail: sent ? detail : "\u672a\u80fd\u5c06\u5e95\u90e8\u5de5\u5177\u6307\u4ee4\u53d1\u9001\u5230\u8fdc\u7aef\u4f1a\u8bdd\u3002",
      kind: sent ? "success" : "error",
      progress: sent ? 100 : null,
      indeterminate: !sent,
      priority: 74,
      expiresAt: Date.now() + 2200
    });
    return sent;
  }

  function handleBottomDockAction(action) {
    if (!action) return;
    if (action === "client-to-remote") {
      setBottomActionSplitOpen(false);
      forceClipboardClientToRemote();
      return;
    }
    if (action === "remote-to-client") {
      setBottomActionSplitOpen(false);
      forceClipboardRemoteToClient();
      return;
    }
    if (action === "wechat-focus") {
      setBottomActionSplitOpen(false);
      requestAppFocus("wechat").then(function (payload) {
        setActivityTask("bottom-dock-action", {
          title: payload && payload.ok && payload.focused ? "\u5df2\u805a\u7126\u5fae\u4fe1\u4e3b\u7a97\u53e3" : "\u5fae\u4fe1\u4e3b\u7a97\u53e3\u805a\u7126\u5931\u8d25",
          detail: payload && payload.ok && payload.focused
            ? "\u8bf7\u5728\u5fae\u4fe1\u4e3b\u7a97\u53e3\u5185\u518d\u8fdb\u884c\u4e00\u6b21\u4ea4\u4e92\uff0c\u5373\u53ef\u6e05\u9664\u672a\u8bfb\u63d0\u9192\u3002"
            : "\u672a\u80fd\u786e\u8ba4\u5fae\u4fe1\u4e3b\u7a97\u53e3\u805a\u7126\u6210\u529f\uff0c\u672a\u6e05\u9664\u672a\u8bfb\u3002",
          kind: payload && payload.ok && payload.focused ? "success" : "error",
          progress: payload && payload.ok && payload.focused ? 100 : null,
          indeterminate: !(payload && payload.ok && payload.focused),
          priority: 74,
          expiresAt: Date.now() + 2600
        });
      });
      return;
    }
    if (action === "qq-focus") {
      setBottomActionSplitOpen(false);
      requestAppFocus("qq").then(function (payload) {
        setActivityTask("bottom-dock-action", {
          title: payload && payload.ok && payload.focused ? "\u5df2\u805a\u7126 QQ \u4e3b\u7a97\u53e3" : "QQ \u4e3b\u7a97\u53e3\u805a\u7126\u5931\u8d25",
          detail: payload && payload.ok && payload.focused
            ? "\u8bf7\u5728 QQ \u4e3b\u7a97\u53e3\u5185\u518d\u8fdb\u884c\u4e00\u6b21\u4ea4\u4e92\uff0c\u5373\u53ef\u6e05\u9664\u672a\u8bfb\u63d0\u9192\u3002"
            : "\u672a\u80fd\u786e\u8ba4 QQ \u4e3b\u7a97\u53e3\u805a\u7126\u6210\u529f\uff0c\u672a\u6e05\u9664\u672a\u8bfb\u3002",
          kind: payload && payload.ok && payload.focused ? "success" : "error",
          progress: payload && payload.ok && payload.focused ? 100 : null,
          indeterminate: !(payload && payload.ok && payload.focused),
          priority: 74,
          expiresAt: Date.now() + 2600
        });
      });
      return;
    }
    if (action === "split-toggle") {
      setBottomActionSplitOpen(!bottomActionSplitOpen);
      return;
    }
    if (action === "split-lr") {
      setBottomActionSplitOpen(false);
      runBottomDockRemoteCommand("python3 /scripts/window_tiler.py split --mode lr --active-side left", "\u5df2\u8bf7\u6c42\u5de6\u53f3\u5206\u5c4f", "\u5df2\u53d1\u9001\u5de6\u53f3\u5bf9\u534a\u5206\u5c4f\u6307\u4ee4\u3002");
      return;
    }
    if (action === "split-tb") {
      setBottomActionSplitOpen(false);
      runBottomDockRemoteCommand("python3 /scripts/window_tiler.py split --mode tb --active-side top", "\u5df2\u8bf7\u6c42\u4e0a\u4e0b\u5206\u5c4f", "\u5df2\u53d1\u9001\u4e0a\u4e0b\u5bf9\u534a\u5206\u5c4f\u6307\u4ee4\u3002");
      return;
    }
    if (action === "split-fullscreen") {
      setBottomActionSplitOpen(false);
      runBottomDockRemoteCommand("python3 /scripts/window_tiler.py split --mode fullscreen --active-side left", "\u5df2\u8bf7\u6c42\u53cc\u7a97\u53e3\u5168\u5c4f", "\u5df2\u53d1\u9001\u53cc\u7a97\u53e3\u5168\u5c4f\u6307\u4ee4\u3002");
      return;
    }
    if (action === "dock-collapse") {
      setBottomActionDockCollapsed(true);
      return;
    }
    if (action === "dock-expand") {
      setBottomActionDockCollapsed(false);
    }
  }

  function ensureBottomActionDock() {
    ensureBottomActionDockStyle();
    var shell = document.getElementById("selkies-bottom-action-dock-shell");
    if (shell) return shell;

    shell = document.createElement("div");
    shell.id = "selkies-bottom-action-dock-shell";
    shell.setAttribute("data-visible", "0");
    shell.setAttribute("data-split-open", "0");
    shell.innerHTML =
      '<div id="selkies-bottom-split-popover">' +
      '<button type="button" class="selkies-bottom-split-btn" data-dock-action="split-lr">\u5de6\u53f3\u5bf9\u534a\u5206</button>' +
      '<button type="button" class="selkies-bottom-split-btn" data-dock-action="split-tb">\u4e0a\u4e0b\u5bf9\u534a\u5206</button>' +
      '<button type="button" class="selkies-bottom-split-btn" data-dock-action="split-fullscreen">\u5168\u90e8\u5168\u5c4f</button>' +
      "</div>" +
      '<div id="selkies-bottom-action-dock">' +
      '<button type="button" class="selkies-bottom-dock-btn" data-tone="send" data-dock-action="client-to-remote">\u9001\u526a\u677f</button>' +
      '<button type="button" class="selkies-bottom-dock-btn" data-tone="wechat" data-dock-action="wechat-focus">\u5fae\u4fe1</button>' +
      '<button type="button" class="selkies-bottom-dock-btn" data-tone="split" data-dock-action="split-toggle">\u5206\u5c4f</button>' +
      '<button type="button" class="selkies-bottom-dock-btn" data-tone="qq" data-dock-action="qq-focus">QQ</button>' +
      '<button type="button" class="selkies-bottom-dock-btn" data-tone="receive" data-dock-action="remote-to-client">\u6536\u526a\u677f</button>' +
      '<button type="button" class="selkies-bottom-dock-btn" data-tone="collapse" data-dock-action="dock-collapse">\u25bd</button>' +
      "</div>" +
      '<button type="button" id="selkies-bottom-dock-collapsed-toggle" data-dock-action="dock-expand">\u25b3</button>';
    document.body.appendChild(shell);
    syncBottomActionSplitState();
    if (bottomActionDockCollapsed) {
      scheduleBottomActionDockRestore();
    }

    shell.addEventListener("click", function (event) {
      var target = event && event.target && event.target.closest ? event.target.closest("[data-dock-action]") : null;
      if (!target) return;
      try {
        event.preventDefault();
        event.stopPropagation();
      } catch (_err) {}
      handleBottomDockAction(target.getAttribute("data-dock-action"));
    });
    syncUnreadDockState();
    return shell;
  }

  function updateBottomActionDockVisibility() {
    var shell = ensureBottomActionDock();
    if (!shell) return;
    var visible = hasVisibleStreamSurface();
    shell.setAttribute("data-visible", visible ? "1" : "0");
    if (!visible && bottomActionSplitOpen) {
      setBottomActionSplitOpen(false);
    }
  }

  function startBottomActionDock() {
    if (bottomActionDockTimer) return;
    ensureBottomActionDock();
    updateBottomActionDockVisibility();
    bottomActionDockTimer = window.setInterval(updateBottomActionDockVisibility, 1200);
    document.addEventListener(
      "pointerdown",
      function (event) {
        var target = event && event.target;
        if (!target || !target.closest) {
          setBottomActionSplitOpen(false);
          return;
        }
        if (target.closest("#selkies-bottom-action-dock-shell")) return;
        setBottomActionSplitOpen(false);
      },
      true
    );
    window.addEventListener("focus", updateBottomActionDockVisibility);
    document.addEventListener("visibilitychange", updateBottomActionDockVisibility);
  }

  function bindSidebarAutoCollapse() {
    function isSidebarExpanded(host) {
      if (!host || !isElementVisible(host)) return false;
      var rect = host.getBoundingClientRect();
      var visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
      var visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
      return visibleWidth >= 140 && visibleHeight >= 220 && rect.width >= 220;
    }

    document.addEventListener(
      "pointerdown",
      function (event) {
        if (!event || !document.body) return;
        if (Date.now() < sidebarAutoCollapseLockUntil) return;
        var host = findLocalLinkSidebarHost();
        if (!isSidebarExpanded(host)) return;
        var toggle = findSidebarToggleButton();
        var target = event.target;
        if (!target) return;
        if (host.contains(target)) return;
        if (toggle && (toggle === target || toggle.contains(target))) return;
        if (target.closest && target.closest("#selkies-activity-layer,#selkies-local-link-prompt,#selkies-bottom-action-dock-shell")) return;
        if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
        sidebarAutoCollapseLockUntil = Date.now() + 360;
        if (toggle && typeof toggle.click === "function") {
          toggle.click();
        }
      },
      true
    );
  }

  function startDynamicLatencyMount() {
    if (dynamicLatencyMountTimer) return;
    renderDynamicLatencySection();
    renderRepairToolsSection();
    renderDebugToolsSection();
    dynamicLatencyMountTimer = window.setInterval(renderDynamicLatencySection, 6000);
    window.setInterval(renderRepairToolsSection, 6000);
    window.setInterval(renderDebugToolsSection, 6000);
  }

  function bindDynamicLatencyMode() {
    startDynamicLatencyMount();
    syncSidebarToggleLowLatencyState();
    if (!sidebarToggleIndicatorTimer) {
      sidebarToggleIndicatorTimer = window.setInterval(syncSidebarToggleLowLatencyState, 1000);
    }
    if (!dynamicLatencyTimer) {
      dynamicLatencyTimer = window.setInterval(function () {
        if (!dynamicLatencyApplied) return;
        if (Date.now() < dynamicLatencyUntil) return;
        restoreDynamicLatency();
      }, 200);
    }

    var lastMoveAt = 0;
    var lastKeyAt = 0;
    function markInteraction(phase) {
      var config = getDynamicLatencyConfig();
      var now = Date.now();
      var motionInterval = Math.max(16, Math.round(1000 / Math.max(8, config.fps || 36)));
      if (now < dynamicLatencySuppressedUntil) {
        return;
      }
      if (phase === "\u9f20\u6807\u79fb\u52a8" && now - lastMoveAt < motionInterval) {
        return;
      }
      if (phase === "\u9f20\u6807\u79fb\u52a8") {
        lastMoveAt = now;
      }
      if (phase === "\u952e\u76d8\u8f93\u5165" || phase === "\u6587\u672c\u8f93\u5165") {
        if (now - lastKeyAt < 40) {
          return;
        }
        lastKeyAt = now;
      }
      noteFrontendInteraction();
      noteUiInteraction();
      activateDynamicLatency(phase);
    }

    document.addEventListener("pointerdown", function () {
      clearUnreadOnPrimaryInteraction();
      markInteraction("\u9f20\u6807\u6309\u4e0b");
    }, true);
    document.addEventListener("pointermove", function (event) {
      if (!hasVisibleStreamSurface()) return;
      if (!event) return;
      if (!event.buttons && Math.abs(Number(event.movementX) || 0) + Math.abs(Number(event.movementY) || 0) < 3) {
        return;
      }
      markInteraction("\u9f20\u6807\u79fb\u52a8");
    }, true);
    document.addEventListener("wheel", function () {
      markInteraction("\u6eda\u8f6e\u6eda\u52a8");
    }, { capture: true, passive: true });
    document.addEventListener("keydown", function (event) {
      if (event && event.repeat) return;
      clearUnreadOnPrimaryInteraction();
      if (isFormLikeElement(event.target)) {
        markInteraction("\u6587\u672c\u8f93\u5165");
        return;
      }
      markInteraction("\u952e\u76d8\u8f93\u5165");
    }, true);
  }

  function localLinkApiPath(pathSuffix) {
    var base = appBasePath();
    if (!base.endsWith("/")) {
      base += "/";
    }
    return base + "api/local-link/" + String(pathSuffix || "").replace(/^\/+/, "");
  }

  function ensureLocalLinkUiStyle() {
    if (document.getElementById("selkies-local-link-ui-style")) return;
    var style = document.createElement("style");
    style.id = "selkies-local-link-ui-style";
    style.textContent =
      "#selkies-local-link-prompt{position:fixed;top:18px;right:18px;width:min(92vw,460px);z-index:10030;" +
      "display:block;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:14px;" +
      "box-shadow:0 18px 44px rgba(2,6,23,.42);overflow:hidden;opacity:0;pointer-events:none;" +
      "transform:translateY(-16px) scale(.94);transition:opacity .22s ease,transform .22s ease}" +
      "#selkies-local-link-prompt[data-open='1']{opacity:1;pointer-events:auto;transform:translateY(0) scale(1)}" +
      ".selkies-link-prompt-head{display:flex;align-items:center;justify-content:space-between;" +
      "padding:12px 14px;border-bottom:1px solid rgba(148,163,184,.16)}" +
      ".selkies-link-prompt-title{font-size:13px;font-weight:700;letter-spacing:.02em}" +
      ".selkies-link-prompt-close{appearance:none;border:0;background:transparent;color:#94a3b8;" +
      "font-size:18px;line-height:1;cursor:pointer;padding:2px 4px}" +
      ".selkies-link-prompt-body{padding:14px}" +
      ".selkies-link-prompt-url{display:block;margin:0 0 10px;color:#cbd5e1;font-size:12px;line-height:1.5;" +
      "word-break:break-all}" +
      ".selkies-link-prompt-meta{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;color:#94a3b8;font-size:11px}" +
      ".selkies-link-prompt-actions{display:flex;gap:8px;flex-wrap:wrap}" +
      ".selkies-link-btn{appearance:none;border:1px solid #334155;background:#172554;color:#e2e8f0;" +
      "border-radius:999px;padding:7px 12px;font-size:12px;font-weight:600;cursor:pointer}" +
      ".selkies-link-btn.primary{background:#14532d;border-color:#166534;color:#dcfce7}" +
      ".selkies-link-btn.ghost{background:transparent;color:#cbd5e1}" +
      ".selkies-link-sidebar{margin-top:12px;padding-top:12px;border-top:1px solid rgba(148,163,184,.16)}" +
      ".selkies-link-details{border:1px solid rgba(51,65,85,.82);border-radius:12px;background:rgba(15,23,42,.45);overflow:hidden}" +
      ".selkies-link-summary{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;cursor:pointer;list-style:none}" +
      ".selkies-link-summary::-webkit-details-marker{display:none}" +
      ".selkies-link-summary::after{content:'+';font-size:14px;color:#93c5fd;transition:transform .18s ease}" +
      ".selkies-link-details[open] .selkies-link-summary::after{transform:rotate(45deg)}" +
      ".selkies-link-summary-meta{font-size:10px;color:#93c5fd}" +
      ".selkies-link-details-body{padding:0 12px 12px}" +
      ".selkies-link-sidebar-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}" +
      ".selkies-link-sidebar-title{font-size:12px;font-weight:700;color:#e2e8f0}" +
      ".selkies-link-sidebar-clear{appearance:none;border:0;background:transparent;color:#93c5fd;cursor:pointer;font-size:11px}" +
      ".selkies-link-history-list{display:flex;flex-direction:column;gap:8px;max-height:220px;overflow:auto}" +
      ".selkies-link-history-empty{font-size:11px;color:#94a3b8}" +
      ".selkies-link-history-item{padding:10px 11px;border:1px solid rgba(51,65,85,.9);border-radius:10px;background:rgba(15,23,42,.55)}" +
      ".selkies-link-history-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}" +
      ".selkies-link-history-time{font-size:10px;color:#94a3b8}" +
      ".selkies-link-history-source{font-size:10px;color:#86efac}" +
      ".selkies-link-history-url{font-size:11px;line-height:1.45;color:#cbd5e1;word-break:break-all;margin-bottom:8px}" +
      ".selkies-link-history-actions{display:flex;gap:6px;flex-wrap:wrap}" +
      ".selkies-link-history-btn{appearance:none;border:1px solid #334155;background:#0b1220;color:#e2e8f0;" +
      "border-radius:999px;padding:5px 9px;font-size:11px;cursor:pointer}" +
      "#keyboard-input-assist.selkies-ime-anchor{position:fixed !important;left:8px !important;top:8px !important;" +
      "width:1px !important;height:1px !important;opacity:0 !important;border:0 !important;padding:0 !important;" +
      "margin:0 !important;pointer-events:none !important;z-index:-1 !important;caret-color:transparent !important;}";
    document.head.appendChild(style);
  }

  function sanitizeLocalLinkUrl(url) {
    try {
      var parsed = new URL(String(url || ""), window.location.href);
      var protocol = parsed.protocol.toLowerCase();
      if (protocol !== "http:" && protocol !== "https:" && protocol !== "mailto:") {
        return "";
      }
      return parsed.toString();
    } catch (_err) {
      return "";
    }
  }

  function getLocalLinkHistory() {
    var raw = getStoredValue(localLinkHistoryKey);
    if (!raw) return [];
    try {
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_err) {
      return [];
    }
  }

  function setLocalLinkHistory(historyItems) {
    setStoredValue(localLinkHistoryKey, JSON.stringify((historyItems || []).slice(0, LOCAL_LINK_HISTORY_LIMIT)));
  }

  function addLocalLinkHistoryEntry(event) {
    if (!event || !event.url) return;
    var historyItems = getLocalLinkHistory();
    historyItems.unshift({
      id: parseTimestamp(event.id) || Date.now(),
      url: event.url,
      source: String(event.source || "xdg-open"),
      ts: parseTimestamp(event.ts) || Date.now()
    });
    setLocalLinkHistory(historyItems);
    renderLocalLinkHistory();
  }

  function copyTextToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      return navigator.clipboard.writeText(String(text || ""));
    }
    return Promise.reject(new Error("clipboard unavailable"));
  }

  async function writePayloadToClientClipboard(payload) {
    if (!payload) {
      throw new Error("clipboard payload unavailable");
    }
    if (payload.type === "text") {
      await copyTextToClipboard(payload.text || "");
      return true;
    }
    if (
      payload.type === "image" &&
      payload.mime &&
      payload.buffer &&
      navigator.clipboard &&
      typeof navigator.clipboard.write === "function" &&
      typeof ClipboardItem !== "undefined"
    ) {
      var blob = new Blob([payload.buffer], { type: payload.mime });
      await navigator.clipboard.write([new ClipboardItem(((function () {
        var item = {};
        item[payload.mime] = blob;
        return item;
      })()))]);
      return true;
    }
    throw new Error("unsupported clipboard payload");
  }

  function resetClientClipboardRuntime() {
    clearClipboardSyncBurst();
    lastClipboardTriggerAt = 0;
    if (typeof window.__SELKIES_PASTE_IMAGE_RESET__ === "function") {
      try {
        window.__SELKIES_PASTE_IMAGE_RESET__();
      } catch (_err) {}
    }
  }

  async function readClientClipboardPayload() {
    if (typeof window.__selkiesReadClientClipboardPayload === "function") {
      return window.__selkiesReadClientClipboardPayload();
    }
    if (navigator.clipboard && typeof navigator.clipboard.readText === "function") {
      try {
        var text = await navigator.clipboard.readText();
        if (!text) return null;
        return { type: "text", text: text };
      } catch (_err) {}
    }
    return null;
  }

  async function forceClipboardClientToRemote() {
    noteUiInteraction();
    resetClientClipboardRuntime();
    var payload = await readClientClipboardPayload();
    if (!payload) {
      setActivityTask("clipboard-force-client", {
        title: "\u65e0\u6cd5\u8bfb\u53d6\u672c\u673a\u526a\u8d34\u677f",
        detail: "\u672a\u8bfb\u53d6\u5230\u5f53\u524d\u5ba2\u6237\u7aef\u7684\u526a\u8d34\u677f\u5185\u5bb9\uff0c\u672a\u6267\u884c\u8986\u76d6\u3002",
        phase: "\u5ba2\u6237\u7aef -> \u8fdc\u7aef",
        kind: "warning",
        progress: null,
        indeterminate: true,
        priority: 76,
        expiresAt: Date.now() + 2600
      });
      return;
    }
    setHighLoadState(true, "clipboard force push");
    scheduleHighLoadRelease("clipboard force push", 6000);
    var sent = false;
    if (window.selkiesSendClipboard && typeof window.selkiesSendClipboard === "function") {
      if (payload.type === "text") {
        await window.selkiesSendClipboard(payload.text || "", "text/plain");
        sent = true;
      } else if (payload.type === "image" && payload.buffer && payload.mime) {
        await window.selkiesSendClipboard(payload.buffer, payload.mime);
        sent = true;
      }
    } else if (typeof window.__selkiesSendClipboardPayload === "function") {
      sent = !!(await window.__selkiesSendClipboardPayload(payload));
    }
    if (sent) {
      setActivityTask("clipboard-force-client", {
        title: "\u5df2\u5f3a\u5236\u8986\u76d6\u8fdc\u7aef\u526a\u8d34\u677f",
        detail: "\u5f53\u524d\u5ba2\u6237\u7aef\u7684\u526a\u8d34\u677f\u5185\u5bb9\u5df2\u4f18\u5148\u5199\u5165 Selkies \u4f1a\u8bdd\u3002",
        phase: "\u5ba2\u6237\u7aef -> \u8fdc\u7aef",
        kind: "success",
        progress: 100,
        indeterminate: false,
        priority: 76,
        expiresAt: Date.now() + 2600
      });
    } else {
      setActivityTask("clipboard-force-client", {
        title: "\u5f3a\u5236\u8986\u76d6\u5931\u8d25",
        detail: "\u5f53\u524d\u5ba2\u6237\u7aef\u526a\u8d34\u677f\u672a\u80fd\u5199\u5165\u8fdc\u7aef\u4f1a\u8bdd\u3002",
        phase: "\u5ba2\u6237\u7aef -> \u8fdc\u7aef",
        kind: "error",
        progress: null,
        indeterminate: true,
        priority: 86,
        expiresAt: Date.now() + 2600
      });
    }
  }

  function forceClipboardRemoteToClient() {
    noteUiInteraction();
    resetClientClipboardRuntime();
    if (pendingRemoteClipboardPull && pendingRemoteClipboardPull.timerId) {
      window.clearTimeout(pendingRemoteClipboardPull.timerId);
    }
    pendingRemoteClipboardPull = {
      startedAt: Date.now(),
      timerId: window.setTimeout(function () {
        pendingRemoteClipboardPull = null;
        setActivityTask("clipboard-force-remote", {
          title: "\u62c9\u53d6\u8fdc\u7aef\u526a\u8d34\u677f\u8d85\u65f6",
          detail: "\u672a\u5728\u9884\u671f\u65f6\u95f4\u5185\u83b7\u5f97 Selkies \u4f1a\u8bdd\u7684\u526a\u8d34\u677f\u5185\u5bb9\u3002",
          phase: "\u8fdc\u7aef -> \u5ba2\u6237\u7aef",
          kind: "warning",
          progress: null,
          indeterminate: true,
          priority: 80,
          expiresAt: Date.now() + 3200
        });
      }, 2600)
    };
    setActivityTask("clipboard-force-remote", {
      title: "\u6b63\u5728\u62c9\u53d6\u8fdc\u7aef\u526a\u8d34\u677f",
      detail: "\u5c06\u4ee5 Selkies \u4f1a\u8bdd\u4e2d\u7684\u526a\u8d34\u677f\u5185\u5bb9\u8986\u76d6\u5f53\u524d\u5ba2\u6237\u7aef\u526a\u8d34\u677f\u3002",
      phase: "\u8fdc\u7aef -> \u5ba2\u6237\u7aef",
      kind: "info",
      progress: null,
      indeterminate: true,
      priority: 76,
      expiresAt: Date.now() + 3200
    });
    requestClipboardSync("force-remote");
    scheduleClipboardSyncBurst("force-remote", [120, 320, 720, 1200]);
  }

  function getModifierGestureBucket(event) {
    var key = String((event && event.key) || "");
    var code = String((event && event.code) || "");
    if (key === "Control" || key === "Meta" || code === "ControlLeft" || code === "ControlRight" || code === "MetaLeft" || code === "MetaRight") return modifierGestureState.clientToRemote;
    if (key === "Alt" || key === "Option" || code === "AltLeft" || code === "AltRight") return modifierGestureState.remoteToClient;
    return null;
  }

  function clearModifierHold(bucket) {
    if (!bucket || !bucket.holdTimer) return;
    window.clearTimeout(bucket.holdTimer);
    bucket.holdTimer = null;
  }

  function triggerModifierGesture(bucket) {
    if (!bucket) return;
    var now = Date.now();
    if (now - bucket.lastTriggerAt < 1200) return;
    bucket.lastTriggerAt = now;
    bucket.lastTapAt = 0;
    clearModifierHold(bucket);
    if (bucket === modifierGestureState.clientToRemote) {
      forceClipboardClientToRemote();
    } else if (bucket === modifierGestureState.remoteToClient) {
      forceClipboardRemoteToClient();
    }
  }

  function openLocalLinkNow(url) {
    var safeUrl = sanitizeLocalLinkUrl(url);
    if (!safeUrl) return false;
    var openedWindow = null;
    try {
      openedWindow = window.open(safeUrl, "_blank", "noopener,noreferrer");
    } catch (_err) {}
    if (openedWindow) {
      try {
        openedWindow.opener = null;
      } catch (_err) {}
      return true;
    }
    return false;
  }

  function formatLocalLinkTime(ts) {
    var safeTs = parseTimestamp(ts);
    if (!safeTs) return "";
    try {
      return new Date(safeTs).toLocaleString();
    } catch (_err) {
      return "";
    }
  }

  function ensureLocalLinkPrompt() {
    ensureLocalLinkUiStyle();
    var prompt = document.getElementById("selkies-local-link-prompt");
    if (prompt) return prompt;

    prompt = document.createElement("div");
    prompt.id = "selkies-local-link-prompt";
    prompt.innerHTML =
      '<div class="selkies-link-prompt-head">' +
      '<div class="selkies-link-prompt-title">\u5728\u672c\u673a\u6d4f\u89c8\u5668\u4e2d\u6253\u5f00\u94fe\u63a5</div>' +
      '<button type="button" class="selkies-link-prompt-close" aria-label="\u5173\u95ed">X</button>' +
      "</div>" +
      '<div class="selkies-link-prompt-body">' +
      '<div class="selkies-link-prompt-url"></div>' +
      '<div class="selkies-link-prompt-meta"></div>' +
      '<div class="selkies-link-prompt-actions">' +
      '<button type="button" class="selkies-link-btn primary" data-action="open">\u6253\u5f00\u94fe\u63a5</button>' +
      '<button type="button" class="selkies-link-btn" data-action="copy">\u590d\u5236\u94fe\u63a5</button>' +
      '<button type="button" class="selkies-link-btn ghost" data-action="dismiss">\u7a0d\u540e\u5904\u7406</button>' +
      "</div>" +
      "</div>";
    document.body.appendChild(prompt);

    prompt.querySelector(".selkies-link-prompt-close").addEventListener("click", function () {
      dismissLocalLinkPrompt(false);
    });
    prompt.querySelector('[data-action="dismiss"]').addEventListener("click", function () {
      dismissLocalLinkPrompt(false);
    });
    prompt.querySelector('[data-action="copy"]').addEventListener("click", function () {
      if (!localLinkPendingEvent) return;
      copyTextToClipboard(localLinkPendingEvent.url).catch(function () {});
    });
    prompt.querySelector('[data-action="open"]').addEventListener("click", function () {
      if (!localLinkPendingEvent) return;
      openLocalLinkNow(localLinkPendingEvent.url);
      dismissLocalLinkPrompt(false);
    });

    return prompt;
  }

  function dismissLocalLinkPrompt(_keepActivity) {
    localLinkPendingEvent = null;
    if (localLinkPromptTimer) {
      window.clearTimeout(localLinkPromptTimer);
      localLinkPromptTimer = null;
    }
    var prompt = document.getElementById("selkies-local-link-prompt");
    if (prompt) {
      prompt.setAttribute("data-open", "0");
    }
  }

  function showLocalLinkPrompt(event) {
    var safeUrl = sanitizeLocalLinkUrl(event && event.url);
    if (!safeUrl) return;
    var prompt = ensureLocalLinkPrompt();
    localLinkPendingEvent = {
      id: parseTimestamp(event.id) || Date.now(),
      url: safeUrl,
      source: String((event && event.source) || "xdg-open"),
      ts: parseTimestamp(event && event.ts) || Date.now()
    };

    prompt.querySelector(".selkies-link-prompt-url").textContent = safeUrl;
    prompt.querySelector(".selkies-link-prompt-meta").innerHTML =
      "<span>\u6765\u6e90\uff1a" +
      localLinkPendingEvent.source +
      "</span><span>\u6536\u5230\u65f6\u95f4\uff1a" +
      formatLocalLinkTime(localLinkPendingEvent.ts) +
      "</span><span>15 \u79d2\u540e\u81ea\u52a8\u5173\u95ed</span>";
    prompt.setAttribute("data-open", "1");

    if (localLinkPromptTimer) {
      window.clearTimeout(localLinkPromptTimer);
    }
    localLinkPromptTimer = window.setTimeout(function () {
      dismissLocalLinkPrompt(false);
    }, LOCAL_LINK_AUTO_CLOSE_MS);
  }

  function getSidebarCandidates() {
    var selectors = [
      "aside",
      '[role="complementary"]',
      '[role="dialog"]',
      'div[class*="sidebar"]',
      'div[class*="drawer"]',
      'div[class*="panel"]'
    ];
    var nodes = [];
    for (var i = 0; i < selectors.length; i += 1) {
      nodes = nodes.concat(Array.prototype.slice.call(document.querySelectorAll(selectors[i])));
    }
    return nodes;
  }

  function findLocalLinkSidebarHost() {
    var candidates = getSidebarCandidates();
    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = candidates[i];
      if (!isElementVisible(candidate)) continue;
      var rect = candidate.getBoundingClientRect();
      if (rect.width < 220 || rect.width > 560 || rect.height < 240) continue;
      var controls = candidate.querySelectorAll("button,select,input,label");
      if (controls.length < 4) continue;
      if (rect.right < window.innerWidth * 0.55 && rect.left > window.innerWidth * 0.1) continue;
      return candidate;
    }
    return null;
  }

  function createHistoryEntryElement(entry) {
    var item = document.createElement("div");
    item.className = "selkies-link-history-item";

    var row = document.createElement("div");
    row.className = "selkies-link-history-row";
    var time = document.createElement("div");
    time.className = "selkies-link-history-time";
    time.textContent = formatLocalLinkTime(entry.ts);
    var source = document.createElement("div");
    source.className = "selkies-link-history-source";
    source.textContent = String(entry.source || "xdg-open");
    row.appendChild(time);
    row.appendChild(source);

    var url = document.createElement("div");
    url.className = "selkies-link-history-url";
    url.textContent = entry.url;

    var actions = document.createElement("div");
    actions.className = "selkies-link-history-actions";

    var openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "selkies-link-history-btn";
    openButton.textContent = "\u6253\u5f00";
    openButton.addEventListener("click", function () {
      openLocalLinkNow(entry.url);
    });

    var copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "selkies-link-history-btn";
    copyButton.textContent = "\u590d\u5236";
    copyButton.addEventListener("click", function () {
      copyTextToClipboard(entry.url).catch(function () {});
    });

    actions.appendChild(openButton);
    actions.appendChild(copyButton);
    item.appendChild(row);
    item.appendChild(url);
    item.appendChild(actions);
    return item;
  }

  function ensureLocalLinkHistorySection() {
    ensureLocalLinkUiStyle();
    var section = document.getElementById("selkies-link-history-section");
    if (section) return section;

    section = document.createElement("div");
    section.id = "selkies-link-history-section";
    section.className = "selkies-link-sidebar";
    section.innerHTML =
      '<details class="selkies-link-details">' +
      '<summary class="selkies-link-summary">' +
      '<span class="selkies-link-sidebar-title">\u94fe\u63a5\u8df3\u8f6c\u5386\u53f2</span>' +
      '<span class="selkies-link-summary-meta">\u6700\u8fd1 20 \u6761</span>' +
      "</summary>" +
      '<div class="selkies-link-details-body">' +
      '<div class="selkies-link-sidebar-head">' +
      '<div class="selkies-link-sidebar-title">\u70b9\u51fb\u9879\u53ef\u5728\u672c\u673a\u6253\u5f00</div>' +
      '<button type="button" class="selkies-link-sidebar-clear">\u6e05\u7a7a</button>' +
      "</div>" +
      '<div class="selkies-link-history-list"></div>' +
      "</div>" +
      "</details>";
    section.querySelector(".selkies-link-sidebar-clear").addEventListener("click", function () {
      setLocalLinkHistory([]);
      renderLocalLinkHistory();
    });
    return section;
  }

  function renderLocalLinkHistory() {
    var section = ensureLocalLinkHistorySection();
    var host = findLocalLinkSidebarHost();
    if (host && section.parentElement !== host) {
      host.appendChild(section);
    }

    var list = section.querySelector(".selkies-link-history-list");
    if (!list) return;
    list.innerHTML = "";

    var historyItems = getLocalLinkHistory();
    if (!historyItems.length) {
      var empty = document.createElement("div");
      empty.className = "selkies-link-history-empty";
      empty.textContent = "\u6682\u65f6\u8fd8\u6ca1\u6709\u94fe\u63a5\u8df3\u8f6c\u8bb0\u5f55\u3002";
      list.appendChild(empty);
      return;
    }

    for (var i = 0; i < historyItems.length && i < 20; i += 1) {
      list.appendChild(createHistoryEntryElement(historyItems[i]));
    }
  }

  function startLocalLinkHistoryMount() {
    if (localLinkHistoryMountTimer) return;
    renderLocalLinkHistory();
    localLinkHistoryMountTimer = window.setInterval(renderLocalLinkHistory, 2000);
  }

  function applyLocalLinkEvents(events) {
    if (!Array.isArray(events) || events.length === 0) return;
    events.sort(function (a, b) {
      return parseTimestamp(a && a.id) - parseTimestamp(b && b.id);
    });
    for (var i = 0; i < events.length; i += 1) {
      var event = events[i] || {};
      var eventId = parseTimestamp(event.id);
      if (eventId > localLinkCursor) {
        localLinkCursor = eventId;
      }
      var safeUrl = sanitizeLocalLinkUrl(event.url);
      if (!safeUrl) continue;
      var normalizedEvent = {
        id: eventId,
        url: safeUrl,
        source: String(event.source || "xdg-open"),
        ts: parseTimestamp(event.ts) || Date.now()
      };
      addLocalLinkHistoryEntry(normalizedEvent);
      showLocalLinkPrompt(normalizedEvent);
    }
    setStoredValue(localLinkCursorKey, localLinkCursor);
  }

  function pollLocalLinkEvents() {
    if (!LOCAL_LINK_OPEN_ENABLED) return;
    var path = localLinkApiPath("pull?since=" + encodeURIComponent(String(localLinkCursor || 0)));
    window
      .fetch(path, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "X-Requested-With": "XMLHttpRequest" }
      })
      .then(function (response) {
        if (!response.ok) return null;
        return response.json();
      })
      .then(function (payload) {
        if (!payload || !payload.ok) return;
        applyLocalLinkEvents(payload.events);
        var latest = parseTimestamp(payload.latest_id);
        if (latest > localLinkCursor) {
          localLinkCursor = latest;
          setStoredValue(localLinkCursorKey, localLinkCursor);
        } else if (latest < localLinkCursor) {
          localLinkCursor = 0;
          setStoredValue(localLinkCursorKey, localLinkCursor);
          if (latest > 0) {
            window.setTimeout(pollLocalLinkEvents, 80);
          }
        }
      })
      .catch(function () {});
  }

  function startLocalLinkEventPoller() {
    if (!LOCAL_LINK_OPEN_ENABLED || localLinkPollTimer) return;
    startLocalLinkHistoryMount();
    pollLocalLinkEvents();
    localLinkPollTimer = window.setInterval(pollLocalLinkEvents, LOCAL_LINK_POLL_INTERVAL_MS);
    window.addEventListener("focus", pollLocalLinkEvents);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        pollLocalLinkEvents();
      }
    });
  }

  function isFormLikeElement(target) {
    if (!target || !target.closest) return false;
    return !!target.closest("input,textarea,select,button,[contenteditable='true'],#selkies-local-link-prompt,#selkies-link-history-section");
  }

  function normalizeKeyboardAssist() {
    var assist = document.getElementById("keyboard-input-assist");
    if (!assist) return null;
    assist.classList.add("selkies-ime-anchor");
    assist.setAttribute("lang", "zh-CN");
    assist.setAttribute("inputmode", "text");
    assist.setAttribute("autocomplete", "off");
    assist.setAttribute("autocorrect", "off");
    assist.setAttribute("autocapitalize", "off");
    assist.setAttribute("spellcheck", "false");
    return assist;
  }

  function focusKeyboardAssist() {
    var assist = normalizeKeyboardAssist();
    if (!assist || document.hidden) return;
    if (imeCompositionActive) return;
    var active = document.activeElement;
    if (active && active !== document.body && active !== assist && isFormLikeElement(active)) return;
    try {
      assist.focus({ preventScroll: true });
    } catch (_err) {
      try {
        assist.focus();
      } catch (_err2) {}
    }
  }

  function scheduleKeyboardAssistFocus(delayMs) {
    if (imeFocusTimer) {
      window.clearTimeout(imeFocusTimer);
    }
    imeFocusTimer = window.setTimeout(function () {
      imeFocusTimer = null;
      focusKeyboardAssist();
    }, typeof delayMs === "number" ? delayMs : 30);
  }

  function bindImeFocusRecovery() {
    ensureLocalLinkUiStyle();
    normalizeKeyboardAssist();
    document.addEventListener(
      "pointerdown",
      function (event) {
        noteUiInteraction();
        if (isFormLikeElement(event.target)) return;
        scheduleKeyboardAssistFocus(80);
      },
      true
    );
    window.addEventListener("focus", function () {
      noteUiInteraction();
      scheduleKeyboardAssistFocus(60);
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        noteUiInteraction();
        scheduleKeyboardAssistFocus(60);
      }
    });
    document.addEventListener(
      "compositionstart",
      function () {
        imeCompositionActive = true;
      },
      true
    );
    document.addEventListener(
      "compositionend",
      function () {
        imeCompositionActive = false;
        noteUiInteraction();
        scheduleKeyboardAssistFocus(260);
      },
      true
    );
    window.setInterval(function () {
      if (document.hidden) return;
      if (!hasVisibleStreamSurface()) return;
      if (imeCompositionActive) return;
      if (isFormLikeElement(document.activeElement)) return;
      if (Date.now() - lastUiInteractionAt < 5000) return;
      scheduleKeyboardAssistFocus(0);
    }, 20000);
  }

  function startClientAwakeHeartbeat() {
    if (pageAwakeHeartbeatTimer) return;
    reportClientAwakeState(false);
    pageAwakeHeartbeatTimer = window.setInterval(function () {
      reportClientAwakeState();
    }, 15000);
    window.addEventListener("focus", function () {
      reportClientAwakeState(true);
    });
    window.addEventListener("blur", function () {
      reportClientAwakeState(false);
    });
    window.addEventListener("beforeunload", function () {
      reportClientAwakeState(false);
    });
    document.addEventListener("visibilitychange", function () {
      reportClientAwakeState();
    });
  }

  function startIdleCleanupWatcher() {
    if (idleCleanupTimer) return;
    var thresholdMs = getIdleCleanupThresholdMs();
    idleCleanupTimer = window.setInterval(function () {
      if (document.hidden) return;
      if (typeof document.hasFocus === "function" && !document.hasFocus()) return;
      if (!hasOpenDataSocket()) return;
      if (imeCompositionActive) return;
      if (isTransportBusy()) return;
      if (streamRecoveryInFlight || streamRecoveryStage > 0) return;
      if (Date.now() - lastUiInteractionAt < thresholdMs) return;
      if (Date.now() - lastIdleCleanupAt < thresholdMs) return;
      runIdleCleanup();
    }, 60000);
  }

  function bindServerSettingsModeHint() {
    window.addEventListener("message", function (event) {
      var data = event && event.data;
      if (!data || typeof data !== "object") return;
      if (!GAMEPAD_UI_ENABLED && data.payload && Object.prototype.hasOwnProperty.call(data.payload, "gamepad_enabled")) {
        setStoredValue("gamepad_enabled", false);
        setStoredValue("isGamepadEnabled", false);
      }
      if (data.payload && Object.prototype.hasOwnProperty.call(data.payload, "use_cpu")) {
        var rawUseCpu = data.payload.use_cpu;
        if (rawUseCpu && typeof rawUseCpu === "object" && Object.prototype.hasOwnProperty.call(rawUseCpu, "value")) {
          rawUseCpu = rawUseCpu.value;
        }
        lastServerUseCpu = sanitizeBool(rawUseCpu, true);
        setStoredValue("use_cpu", lastServerUseCpu);
        scheduleBurstRefresh();
      } else if (data.type === "pipelineStatusUpdate") {
        if (Object.prototype.hasOwnProperty.call(data, "video")) {
          lastVideoPipelineActive = sanitizeBool(data.video, lastVideoPipelineActive);
          if (pipelineResetNoticeTimer) {
            window.clearTimeout(pipelineResetNoticeTimer);
            pipelineResetNoticeTimer = null;
          }
          if (lastVideoPipelineActive) {
            suppressDynamicLatency(4000);
            waitingSinceMs = 0;
            noteFrameProgress();
            scheduleKeyboardAssistFocus(120);
            completeActivityTask("stream-reconfig", "\u89c6\u9891\u7ba1\u7ebf\u5df2\u6062\u590d\u3002", "success", 1800);
          } else {
            suppressDynamicLatency(2000);
            if (dynamicLatencyApplied) {
              restoreDynamicLatency();
            }
            if (!isTransportBusy()) {
              pipelineResetNoticeTimer = window.setTimeout(function () {
                pipelineResetNoticeTimer = null;
                if (lastVideoPipelineActive || isTransportBusy()) return;
                setActivityTask("stream-reconfig", {
                  title: "\u6b63\u5728\u91cd\u5efa\u89c6\u9891\u6d41",
                  detail: "\u89c6\u9891\u7ba1\u7ebf\u53d1\u751f\u53d8\u5316\uff0c\u6b63\u5728\u7b49\u5f85\u8fdc\u7aef\u89c6\u9891\u6d41\u91cd\u65b0\u6062\u590d\u3002",
                  phase: "\u7ba1\u7ebf\u91cd\u7f6e",
                  kind: "warning",
                  progress: null,
                  indeterminate: true,
                  priority: 82,
                  startedAt: Date.now()
                });
              }, 1200);
            }
          }
        }
        scheduleBadgeRefresh(0);
        syncStreamActivity();
      }
    });
  }

  function boot() {
    injectBadgeStyle();
    primeRuntimeStorageDefaults();
    handleEncoderModeSideEffects(findEncoderSelect());
    scheduleBadgeRefresh(0);
    document.title = BASE_BRAND_TITLE;

    // Avoid high-frequency DOM observers; refresh with short bursts on UI interactions.
    document.addEventListener(
      "click",
      function () {
        scheduleBurstRefresh();
      },
      true
    );
    window.addEventListener("focus", function () {
      scheduleBurstRefresh();
    });
    window.addEventListener("hashchange", function () {
      scheduleBurstRefresh();
    });
    window.setInterval(function () {
      scheduleBadgeRefresh(0);
    }, 5000);
    bindServerSettingsModeHint();
    bindStreamRecoveryWatchdog();
    bindActivityWatchers();
    bindFileTransferActivity();
    installFileTransferTransportInterceptor();
    bindClipboardActivity();
    bindClipboardSyncTriggers();
    bindDynamicLatencyMode();
    bindImeFocusRecovery();
    startClientAwakeHeartbeat();
    startIdleCleanupWatcher();
    startBottomActionDock();
    startNotificationEventPoller();
    bindSidebarAutoCollapse();
    startLocalLinkEventPoller();
    startGamepadUiGuard();
    syncStreamActivity();
  }

  primeRuntimeStorageDefaults();
  if (document.readyState === "loading") {
    installSingleSessionWebSocketGuard();
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    installSingleSessionWebSocketGuard();
    boot();
  }
})();
