(function () {
  "use strict";

  installClientClipboardGuard();
  installMediaPlaybackWakeGuard();

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
  var STREAM_RECOVERY_NOTICE_MAX_MS = sanitizeInt(runtime.streamRecoveryNoticeMaxMs, 22000, 8000, 120000);
  var VIDEO_CORRUPTION_WATCHDOG = sanitizeBool(runtime.videoCorruptionWatchdog, true);
  var VIDEO_SOFT_RECOVER_LIMIT = sanitizeInt(runtime.videoSoftRecoverLimit, 2, 1, 5);
  var VIDEO_RECOVER_COOLDOWN_MS = sanitizeInt(runtime.videoRecoverCooldownMs, 120000, 30000, 600000);
  var PAGE_STALL_WATCHDOG = sanitizeBool(runtime.pageStallWatchdog, true);
  var PAGE_STALL_THRESHOLD_MS = sanitizeInt(runtime.pageStallThresholdMs, 45000, 10000, 300000);
  var PAGE_STALL_RELOAD_THRESHOLD_MS = sanitizeInt(runtime.pageStallReloadThresholdMs, 90000, 30000, 600000);
  var PAGE_STALL_COOLDOWN_MS = sanitizeInt(runtime.pageStallCooldownMs, 300000, 60000, 1800000);
  var PAGE_STALL_LOOP_LAG_MS = sanitizeInt(runtime.pageStallLoopLagMs, 12000, 3000, 120000);
  var RENDER_STALL_WATCHDOG = sanitizeBool(runtime.renderStallWatchdog, true);
  var RENDER_STALL_THRESHOLD_MS = sanitizeInt(runtime.renderStallThresholdMs, 12000, 5000, 120000);
  var RENDER_STALL_COOLDOWN_MS = sanitizeInt(runtime.renderStallCooldownMs, 25000, 8000, 300000);
  var AUDIO_WATCHDOG = sanitizeBool(runtime.audioWatchdog, true);
  var AUDIO_START_INTERVAL_MS = sanitizeInt(runtime.audioStartIntervalMs, 8000, 2000, 60000);
  var AUDIO_PACKET_STALL_MS = sanitizeInt(runtime.audioPacketStallMs, 15000, 5000, 120000);
  var WS_SESSION_ID = "";
  var WS_SESSION_EPOCH = 0;
  var sessionMonitorTimer = null;
  var lastSessionCheckAt = 0;
  var staleSessionHandled = false;
  var videoHealthEvents = [];
  var GAMEPAD_UI_ENABLED = false;
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
  var clipboardShortcutBusy = false;
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
  var streamRecoveryNoticeTimer = null;
  var frameTrackerBindTimer = null;
  var pageStallWatchdogTimer = null;
  var lastPageWatchdogTickAt = Date.now();
  var pageStallSoftRecoverAt = 0;
  var renderStallWatchdogTimer = null;
  var lastRenderProgressAt = Date.now();
  var lastRenderKickAt = 0;
  var lastVideoPacketAt = 0;
  var lastObservedFps = -1;
  var audioWatchdogTimer = null;
  var trackedAudioContexts = [];
  var trackedAudioWorkers = [];
  var lastAudioPacketAt = 0;
  var lastAudioDecodedAt = 0;
  var lastAudioStartRequestAt = 0;
  var lastAudioReinitAt = 0;
  var lastAudioPipelineActive = true;
  var highLoadReleaseTimer = null;
  var streamRestartVerifyTimer = null;
  var highLoadStateMap = Object.create(null);
  var highLoadBusyUntil = 0;
  var pipelineResetNoticeTimer = null;
  var encoderResetTimerIds = [];
  var sidebarAutoCollapseLockUntil = 0;
  var sidebarKeyboardShortcutBound = false;
  var clipboardSyncTriggersBound = false;
  var pageAwakeHeartbeatTimer = null;
  var idleCleanupTimer = null;
  var lastIdleCleanupAt = 0;
  var lastFrontendInteractionAt = Date.now();
  var BASE_BRAND_TITLE = "AXi-SNS-Box";
  var notificationCursorKey = "notification_cursor_v1";
  var notificationHistoryKey = "notification_history_v1";
  var NOTIFICATION_HISTORY_LIMIT = 160;
  var NOTIFICATION_HISTORY_MAX_BYTES = 10 * 1024 * 1024;
  var NOTIFICATION_MERGE_WINDOW_MS = 8000;
  var NOTIFICATION_HEADER_MERGE_WINDOW_MS = 60000;
  var notificationCursor = parseTimestamp(getStoredValue(notificationCursorKey));
  var notificationPollTimer = null;
  var notificationHistoryRenderTimer = null;
  var notificationHistoryRecentKeys = Object.create(null);
  var notificationCenterOpen = sanitizeBool(getStoredValue("notification_center_open"), false);
  var notificationCenterEnabled = sanitizeBool(getStoredValue("notification_center_enabled"), true);
  var notificationSessionSeenKey = "notification_session_seen_v1";
  var lastNotificationSessionKey = getStoredValue(notificationSessionSeenKey);
  var notificationBandwidthStateKey = "notification_bandwidth_daily_v1";
  var notificationBandwidthSamplesKey = "notification_bandwidth_samples_v1";
  var notificationBandwidthEventTimer = null;
  var lastNetworkStatsAt = 0;
  var notificationBandwidthSummary = {
    uploadKbps: 0,
    downloadKbps: 0,
    dominant: "upload",
    total24hBytes: 0
  };
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
  var adaptiveSleepEnabled = sanitizeBool(getStoredValue("adaptive_sleep_enabled"), false);
  var adaptiveSleepIdleSeconds = sanitizeAdaptiveSleepIdleSeconds(
    getStoredValue("adaptive_sleep_idle_seconds") || runtime.adaptiveSleepIdleSeconds || 3600
  );
  var adaptiveSleepStatusTimer = null;
  var adaptiveSleepOverlayTimer = null;
  var adaptiveSleepIdleTimer = null;
  var adaptiveSleepOverlayVisible = false;
  var adaptiveSleepLastStatus = null;
  var adaptiveSleepLastActivityPostAt = 0;
  var qqIdleBlurSeconds = sanitizeInt(getStoredValue("qq_idle_blur_seconds"), 600, 0, 1800);
  var lanDiscoveryEnabled = sanitizeBool(getStoredValue("lan_discovery_enabled"), false);
  var lanBroadcastName = sanitizeLanBroadcastName(getStoredValue("lan_broadcast_name"), "AXISNSBOX-000");
  var lastNotificationActivityReportAt = 0;
  var autoSplitEnabled = sanitizeBool(getStoredValue("auto_split_enabled"), false);
  var autoSplitStateLoaded = false;
  var autoSplitEntryPending = true;
  var autoSplitAppliedSessionKey = "";
  var autoSplitTimer = null;
  var autoSplitAttemptCount = 0;
  var bottomActionDockTimer = null;
  var bottomActionSplitOpen = false;
  var bottomActionDockCollapsed = sanitizeBool(getStoredValue("bottom_action_dock_collapsed"), false);
  var bottomActionClipboardButtonsEnabled = sanitizeBool(getStoredValue("bottom_action_clipboard_buttons_enabled"), false);
  var bottomActionDockPosition = sanitizeDockPosition(getStoredValue("bottom_action_dock_position"));
  var bottomActionDockRestoreTimer = null;
  var managedFileTransfers = Object.create(null);
  var fileTransferSockets = typeof WeakMap === "function" ? new WeakMap() : null;
  var uploadTransportStates = [];
  var legacyUploadFallbackEnabled = sanitizeBool(getStoredValue("legacy_upload_fallback_enabled"), false);
  var LEGACY_UPLOAD_ENABLED = sanitizeBool(runtime.legacyUploadEnabled, false) || legacyUploadFallbackEnabled;
  var uploadDiagnostics = [];
  var uploadDiagnosticsFlushTimer = null;
  var uploadDiagnosticsSampleTimer = null;
  var uploadDiagnosticsLongTaskCount = 0;
  var uploadDiagnosticsLongTaskMaxMs = 0;
  var UPLOAD_QUEUE_HIGH_WATER_CHUNKS = sanitizeInt(runtime.uploadQueueHighWaterChunks, 4, 1, 64);
  var UPLOAD_BUFFERED_HIGH_WATER_BYTES = sanitizeInt(runtime.uploadBufferedHighWaterBytes, 4 * 1024 * 1024, 256 * 1024, 64 * 1024 * 1024);
  var UPLOAD_READ_GATE_DELAY_MS = sanitizeInt(runtime.uploadReadGateDelayMs, 35, 5, 250);
  var CLIPBOARD_UPLOAD_CHUNK_SIZE = sanitizeInt(runtime.clipboardUploadChunkSize, 750 * 1024, 64 * 1024, 2 * 1024 * 1024);
  var CLIPBOARD_BUFFERED_HIGH_WATER_BYTES = sanitizeInt(runtime.clipboardBufferedHighWaterBytes, 2 * 1024 * 1024, 256 * 1024, 64 * 1024 * 1024);
  var CLIPBOARD_SEND_YIELD_MS = sanitizeInt(runtime.clipboardSendYieldMs, 12, 0, 250);
  var managedClipboardNativeSender = null;
  var managedClipboardSenderInstalled = false;
  var debugNotificationTargetAt = 0;
  var debugNotificationTimeout = null;
  var debugNotificationInterval = null;
  var debugWechatAudioTargetAt = 0;
  var debugWechatAudioTimeout = null;
  var debugWechatAudioInterval = null;
  var nativeSelkiesControlGuardTimer = null;
  var nativePaintOverToggleClickAt = 0;
  var modifierGestureState = {
    remoteToClient: { down: false, chorded: false, lastTapAt: 0, lastTriggerAt: 0, holdTimer: null }
  };

  function clientClipboardPermissionDepth(kind) {
    var key = kind === "write" ? "__SELKIES_CLIENT_CLIPBOARD_WRITE_DEPTH__" : "__SELKIES_CLIENT_CLIPBOARD_READ_DEPTH__";
    return Math.max(0, Number(window[key]) || 0);
  }

  function pushClientClipboardPermission(kind) {
    var key = kind === "write" ? "__SELKIES_CLIENT_CLIPBOARD_WRITE_DEPTH__" : "__SELKIES_CLIENT_CLIPBOARD_READ_DEPTH__";
    window[key] = clientClipboardPermissionDepth(kind) + 1;
    return function () {
      window[key] = Math.max(0, clientClipboardPermissionDepth(kind) - 1);
    };
  }

  function clientClipboardReadAllowed() {
    return clientClipboardPermissionDepth("read") > 0;
  }

  function clientClipboardWriteAllowed() {
    return clientClipboardPermissionDepth("write") > 0;
  }

  function withClientClipboardReadPermission(callback) {
    var release = pushClientClipboardPermission("read");
    try {
      return Promise.resolve(callback()).then(
        function (value) {
          release();
          return value;
        },
        function (err) {
          release();
          throw err;
        }
      );
    } catch (err) {
      release();
      return Promise.reject(err);
    }
  }

  function withClientClipboardWritePermission(callback) {
    var release = pushClientClipboardPermission("write");
    try {
      return Promise.resolve(callback()).then(
        function (value) {
          release();
          return value;
        },
        function (err) {
          release();
          throw err;
        }
      );
    } catch (err) {
      release();
      return Promise.reject(err);
    }
  }

  function withClientClipboardTransferPermission(callback) {
    var releaseRead = pushClientClipboardPermission("read");
    var releaseWrite = pushClientClipboardPermission("write");
    var release = function () {
      releaseWrite();
      releaseRead();
    };
    try {
      return Promise.resolve(callback()).then(
        function (value) {
          release();
          return value;
        },
        function (err) {
          release();
          throw err;
        }
      );
    } catch (err) {
      release();
      return Promise.reject(err);
    }
  }

  function isClientClipboardWriteCommand(payload) {
    if (typeof payload !== "string") return false;
    return /^(cw|cb|cws|cbs|cwd|cbd|cwe|cbe)(?:,|$)/.test(payload);
  }

  function blockedClipboardReadPromise() {
    var error;
    try {
      error = new DOMException("Client clipboard reads are disabled until an explicit paste action.", "NotAllowedError");
    } catch (_err) {
      error = new Error("Client clipboard reads are disabled until an explicit paste action.");
      error.name = "NotAllowedError";
    }
    return Promise.reject(error);
  }

  function installClientClipboardGuard() {
    try {
      Object.defineProperty(window, "clipboard_enabled", {
        configurable: true,
        enumerable: true,
        get: function () {
          return false;
        },
        set: function () {}
      });
    } catch (_err) {
      window.clipboard_enabled = false;
    }

    window.__selkiesWithClientClipboardRead = withClientClipboardReadPermission;
    window.__selkiesWithClientClipboardWrite = withClientClipboardWritePermission;
    window.__selkiesWithClientClipboardTransfer = withClientClipboardTransferPermission;
    window.__selkiesClientClipboardReadAllowed = clientClipboardReadAllowed;
    window.__selkiesClientClipboardWriteAllowed = clientClipboardWriteAllowed;

    try {
      if (navigator.clipboard && !navigator.clipboard.__selkiesReadGuardInstalled) {
        var nativeRead = typeof navigator.clipboard.read === "function" ? navigator.clipboard.read.bind(navigator.clipboard) : null;
        var nativeReadText = typeof navigator.clipboard.readText === "function" ? navigator.clipboard.readText.bind(navigator.clipboard) : null;
        if (nativeRead) {
          navigator.clipboard.read = function () {
            if (!clientClipboardReadAllowed()) return blockedClipboardReadPromise();
            return nativeRead.apply(navigator.clipboard, arguments);
          };
        }
        if (nativeReadText) {
          navigator.clipboard.readText = function () {
            if (!clientClipboardReadAllowed()) return blockedClipboardReadPromise();
            return nativeReadText.apply(navigator.clipboard, arguments);
          };
        }
        Object.defineProperty(navigator.clipboard, "__selkiesReadGuardInstalled", {
          configurable: false,
          enumerable: false,
          value: true
        });
      }
    } catch (_err2) {}

    try {
      if (window.WebSocket && !window.WebSocket.prototype.__selkiesClipboardGuardInstalled) {
        var nativeWsSend = window.WebSocket.prototype.send;
        window.WebSocket.prototype.send = function (payload) {
          if (isClientClipboardWriteCommand(payload) && !clientClipboardWriteAllowed()) {
            console.warn("[selkies] blocked client clipboard upload outside explicit paste action");
            return;
          }
          return nativeWsSend.apply(this, arguments);
        };
        Object.defineProperty(window.WebSocket.prototype, "__selkiesClipboardGuardInstalled", {
          configurable: false,
          enumerable: false,
          value: true
        });
      }
    } catch (_err3) {}

    try {
      if (window.RTCDataChannel && !window.RTCDataChannel.prototype.__selkiesClipboardGuardInstalled) {
        var nativeDcSend = window.RTCDataChannel.prototype.send;
        window.RTCDataChannel.prototype.send = function (payload) {
          if (isClientClipboardWriteCommand(payload) && !clientClipboardWriteAllowed()) {
            console.warn("[selkies] blocked client clipboard data-channel upload outside explicit paste action");
            return;
          }
          return nativeDcSend.apply(this, arguments);
        };
        Object.defineProperty(window.RTCDataChannel.prototype, "__selkiesClipboardGuardInstalled", {
          configurable: false,
          enumerable: false,
          value: true
        });
      }
    } catch (_err4) {}
  }

  function copyStaticProperties(source, target) {
    try {
      Object.getOwnPropertyNames(source).forEach(function (key) {
        if (key in target) return;
        try {
          Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key));
        } catch (_err) {}
      });
    } catch (_err2) {}
  }

  function trackAudioContext(context) {
    if (!context || trackedAudioContexts.indexOf(context) >= 0) return context;
    trackedAudioContexts.push(context);
    try {
      context.addEventListener("statechange", function () {
        if (context.state === "running") {
          lastAudioDecodedAt = Math.max(lastAudioDecodedAt, Date.now());
        }
      });
    } catch (_err) {}
    return context;
  }

  function trackAudioWorker(worker) {
    if (!worker || worker.__selkiesWorkerTracked) return worker;
    worker.__selkiesWorkerTracked = true;
    try {
      var nativePostMessage = worker.postMessage;
      if (typeof nativePostMessage === "function" && !nativePostMessage.__selkiesAudioWorkerWrapped) {
        worker.postMessage = function (payload) {
          if (payload && typeof payload === "object") {
            var type = String(payload.type || "");
            if (
              type === "init" &&
              payload.data &&
              Object.prototype.hasOwnProperty.call(payload.data, "initialPipelineStatus")
            ) {
              markAudioWorker(worker);
            } else if (worker.__selkiesAudioDecoderWorker && (type === "decode" || type === "reinitialize" || type === "updatePipelineStatus")) {
              markAudioWorker(worker);
            }
          }
          return nativePostMessage.apply(worker, arguments);
        };
        worker.postMessage.__selkiesAudioWorkerWrapped = true;
      }
    } catch (_postErr) {}
    try {
      worker.addEventListener("message", function (event) {
        var data = event && event.data;
        if (!data || typeof data !== "object") return;
        var type = String(data.type || "");
        if (
          type === "decoderInitialized" ||
          type === "decoderInitFailed" ||
          type === "decoderError" ||
          type === "decodedAudioData"
        ) {
          markAudioWorker(worker);
          if (type === "decodedAudioData") {
            lastAudioDecodedAt = Date.now();
          }
        }
      });
    } catch (_eventErr) {}
    return worker;
  }

  function markAudioWorker(worker) {
    if (!worker || worker.__selkiesAudioDecoderWorker) return;
    worker.__selkiesAudioDecoderWorker = true;
    trackedAudioWorkers.push(worker);
  }

  function installMediaPlaybackWakeGuard() {
    if (window.__selkiesMediaPlaybackWakeGuardInstalled) return;
    window.__selkiesMediaPlaybackWakeGuardInstalled = true;

    ["AudioContext", "webkitAudioContext"].forEach(function (key) {
      var NativeAudioContext = window[key];
      if (!NativeAudioContext || NativeAudioContext.__selkiesPlaybackWrapped) return;
      var WrappedAudioContext = function () {
        var args = [null].concat(Array.prototype.slice.call(arguments));
        var ContextCtor = Function.prototype.bind.apply(NativeAudioContext, args);
        return trackAudioContext(new ContextCtor());
      };
      WrappedAudioContext.prototype = NativeAudioContext.prototype;
      copyStaticProperties(NativeAudioContext, WrappedAudioContext);
      WrappedAudioContext.__selkiesPlaybackWrapped = true;
      window[key] = WrappedAudioContext;
    });

    var NativeWorker = window.Worker;
    if (NativeWorker && !NativeWorker.__selkiesPlaybackWrapped) {
      var WrappedWorker = function (url, options) {
        var worker =
          typeof options === "undefined"
            ? new NativeWorker(url)
            : new NativeWorker(url, options);
        return trackAudioWorker(worker);
      };
      WrappedWorker.prototype = NativeWorker.prototype;
      copyStaticProperties(NativeWorker, WrappedWorker);
      WrappedWorker.__selkiesPlaybackWrapped = true;
      window.Worker = WrappedWorker;
    }

    function wakeFromGesture() {
      noteUiInteraction();
      resumeTrackedAudioContexts("user-gesture");
      requestServerAudio("user-gesture");
    }

    ["pointerdown", "keydown", "touchstart", "click"].forEach(function (eventName) {
      document.addEventListener(eventName, wakeFromGesture, true);
    });
    window.addEventListener("focus", function () {
      resumeTrackedAudioContexts("focus");
      requestServerAudio("focus");
      kickLocalRenderSurfaces("focus");
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        resumeTrackedAudioContexts("visible");
        requestServerAudio("visible");
        kickLocalRenderSurfaces("visible");
      }
    });
  }

  function isForcedSelkiesOffKey(name) {
    return /(^|_)(use_paint_over_quality|gamepad_enabled|isGamepadEnabled|ui_sidebar_show_gamepads)(_display2)?$/.test(String(name || ""));
  }

  function nativeSelkiesStoragePrefix() {
    return window.location.href.split("#")[0].replace(/[^a-zA-Z0-9.-_]/g, "_");
  }

  function nativeSelkiesStorageKey(name, displaySuffix) {
    return nativeSelkiesStoragePrefix() + "_" + String(name || "") + (displaySuffix ? "_display2" : "");
  }

  function setForcedSelkiesOffValue(name, displaySuffix) {
    try {
      window.localStorage.setItem(nativeSelkiesStorageKey(name, displaySuffix), "false");
    } catch (_err) {}
  }

  function primeNativeSelkiesForcedDefaults() {
    ["use_paint_over_quality", "gamepad_enabled", "isGamepadEnabled", "ui_sidebar_show_gamepads"].forEach(function (name) {
      setForcedSelkiesOffValue(name, false);
    });
    setForcedSelkiesOffValue("use_paint_over_quality", true);
  }

  function sanitizeSettingsPayload(settings) {
    if (!settings || typeof settings !== "object") return settings;
    var safe = Object.assign({}, settings);
    safe.use_paint_over_quality = false;
    safe.gamepad_enabled = false;
    safe.isGamepadEnabled = false;
    safe.ui_sidebar_show_gamepads = false;
    return safe;
  }

  function sanitizeServerSettingDefinitions(payload) {
    if (!payload || typeof payload !== "object") return payload;
    var safe = Object.assign({}, payload);
    ["use_paint_over_quality", "gamepad_enabled", "ui_sidebar_show_gamepads"].forEach(function (name) {
      if (safe[name] && typeof safe[name] === "object") {
        safe[name] = Object.assign({}, safe[name], { value: false, default: false });
      }
    });
    return safe;
  }

  function sanitizeWindowMessage(message) {
    if (!message || typeof message !== "object") return message;
    if (message.type === "settings" && message.settings) {
      return Object.assign({}, message, { settings: sanitizeSettingsPayload(message.settings) });
    }
    if (message.type === "gamepadControl") {
      return Object.assign({}, message, { enabled: false });
    }
    if (message.type === "serverSettings" && message.payload) {
      return Object.assign({}, message, { payload: sanitizeServerSettingDefinitions(message.payload) });
    }
    return message;
  }

  function sanitizeOutgoingWebSocketPayload(data) {
    if (typeof data !== "string" || data.indexOf("SETTINGS,") !== 0) return data;
    try {
      var payload = JSON.parse(data.slice("SETTINGS,".length));
      return "SETTINGS," + JSON.stringify(sanitizeSettingsPayload(payload));
    } catch (_err) {
      return data;
    }
  }

  function installForcedSelkiesDefaultsGuard() {
    if (window.__selkiesForcedDefaultsGuardInstalled) return;
    window.__selkiesForcedDefaultsGuardInstalled = true;
    primeNativeSelkiesForcedDefaults();

    try {
      var nativeSetItem = window.Storage && window.Storage.prototype && window.Storage.prototype.setItem;
      if (nativeSetItem && !nativeSetItem.__selkiesForcedDefaultsWrapped) {
        var wrappedSetItem = function (name, value) {
          return nativeSetItem.call(this, name, isForcedSelkiesOffKey(name) ? "false" : value);
        };
        wrappedSetItem.__selkiesForcedDefaultsWrapped = true;
        window.Storage.prototype.setItem = wrappedSetItem;
      }
      var nativeRemoveItem = window.Storage && window.Storage.prototype && window.Storage.prototype.removeItem;
      if (nativeSetItem && nativeRemoveItem && !nativeRemoveItem.__selkiesForcedDefaultsWrapped) {
        var wrappedRemoveItem = function (name) {
          if (isForcedSelkiesOffKey(name)) {
            return nativeSetItem.call(this, name, "false");
          }
          return nativeRemoveItem.call(this, name);
        };
        wrappedRemoveItem.__selkiesForcedDefaultsWrapped = true;
        window.Storage.prototype.removeItem = wrappedRemoveItem;
      }
    } catch (_storageErr) {}

    try {
      var nativePostMessage = window.postMessage;
      if (nativePostMessage && !nativePostMessage.__selkiesForcedDefaultsWrapped) {
        var wrappedPostMessage = function (message, targetOrigin, transfer) {
          return nativePostMessage.call(this, sanitizeWindowMessage(message), targetOrigin, transfer);
        };
        wrappedPostMessage.__selkiesForcedDefaultsWrapped = true;
        window.postMessage = wrappedPostMessage;
      }
    } catch (_postErr) {}
  }

  function stopFrontendShortcutEvent(event) {
    if (!event) return;
    event.preventDefault();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    } else if (typeof event.stopPropagation === "function") {
      event.stopPropagation();
    }
  }

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
    if (staleSessionHandled) return;
    staleSessionHandled = true;
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

  function isReloadNavigation() {
    try {
      var entries = window.performance && window.performance.getEntriesByType ? window.performance.getEntriesByType("navigation") : [];
      if (entries && entries[0] && entries[0].type === "reload") return true;
    } catch (_err) {}
    try {
      return !!(window.performance && window.performance.navigation && window.performance.navigation.type === 1);
    } catch (_err2) {}
    return false;
  }

  function enforcePinOnBrowserReload() {
    if (!isReloadNavigation()) return false;
    forcePinLogin();
    return true;
  }

  function refreshSessionIdentity(force) {
    if (!window.fetch) return Promise.resolve(false);
    var now = Date.now();
    if (!force && now - lastSessionCheckAt < 5000) return Promise.resolve(false);
    lastSessionCheckAt = now;
    return window
      .fetch(withSessionIdentity(authBasePath() + "session"), {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "X-Requested-With": "XMLHttpRequest" }
      })
      .then(function (response) {
        if (response.status === 401 || response.status === 403) {
          forcePinLogin();
          return false;
        }
        if (!response.ok) return false;
        return response.json();
      })
      .then(function (payload) {
        if (!payload || !payload.ok) return false;
        WS_SESSION_ID = String(payload.session_id || "");
        WS_SESSION_EPOCH = parseTimestamp(payload.session_epoch) || 0;
        try {
          if (WS_SESSION_ID) window.sessionStorage.setItem("selkies_session_id", WS_SESSION_ID);
          if (WS_SESSION_EPOCH) window.sessionStorage.setItem("selkies_session_epoch", String(WS_SESSION_EPOCH));
        } catch (_storeErr) {}
        recordSessionClientNotification(WS_SESSION_ID, WS_SESSION_EPOCH);
        scheduleAutoSplitForPinSession(1800);
        return true;
      })
      .catch(function () {
        return false;
      });
  }

  function startSessionMonitor() {
    if (sessionMonitorTimer) return;
    refreshSessionIdentity(true);
    sessionMonitorTimer = window.setInterval(function () {
      if (document.hidden) return;
      if (typeof document.hasFocus === "function" && !document.hasFocus()) return;
      refreshSessionIdentity(false);
    }, 10000);
    window.addEventListener("focus", function () {
      refreshSessionIdentity(true);
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        refreshSessionIdentity(true);
      }
    });
  }

  function withSessionIdentity(url) {
    var raw = String(url || "");
    if (!WS_SESSION_ID) {
      try {
        WS_SESSION_ID = String(window.sessionStorage.getItem("selkies_session_id") || "");
      } catch (_sidErr) {}
    }
    if (!WS_SESSION_EPOCH) {
      try {
        WS_SESSION_EPOCH = parseTimestamp(window.sessionStorage.getItem("selkies_session_epoch")) || 0;
      } catch (_epochErr) {}
    }
    if (!WS_SESSION_ID || !WS_SESSION_EPOCH) return raw;
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

      try {
        var nativeSend = ws.send;
        if (nativeSend && !nativeSend.__selkiesForcedSettingsWrapped) {
          var wrappedSend = function (data) {
            return nativeSend.call(ws, sanitizeOutgoingWebSocketPayload(data));
          };
          wrappedSend.__selkiesForcedSettingsWrapped = true;
          ws.send = wrappedSend;
        }
      } catch (_sendErr) {}

      ws.addEventListener("message", function (event) {
        if (!event || event.data !== "FORCE_PIN_LOGIN") return;
        try {
          ws.close(4002, "single-session takeover");
        } catch (_closeErr) {}
        forcePinLogin();
      });
      ws.addEventListener("message", function (event) {
        if (!event) return;
        if (event.data instanceof ArrayBuffer) {
          noteInboundStreamPacket(event.data);
          return;
        }
        if (typeof event.data !== "string") return;
        if (event.data === "AUDIO_STARTED") {
          lastAudioPipelineActive = true;
          lastAudioStartRequestAt = 0;
        } else if (event.data === "AUDIO_STOPPED") {
          lastAudioPipelineActive = false;
        } else if (event.data === "VIDEO_STARTED") {
          lastVideoPipelineActive = true;
          lastRenderProgressAt = Date.now();
        } else if (event.data === "VIDEO_STOPPED") {
          lastVideoPipelineActive = false;
        }
        if (event.data.indexOf("FILE_UPLOAD_STATUS:") === 0) {
          try {
            var uploadStatus = JSON.parse(event.data.slice("FILE_UPLOAD_STATUS:".length));
            if (typeof window.__selkiesApplyManagedUploadStatus === "function") {
              window.__selkiesApplyManagedUploadStatus(uploadStatus);
            } else {
              window.postMessage({ type: "fileUploadStatus", payload: uploadStatus }, window.location.origin);
            }
          } catch (_uploadStatusErr) {}
          if (typeof event.stopImmediatePropagation === "function") {
            event.stopImmediatePropagation();
          }
          return;
        }
        if (event.data.charAt(0) === "{") {
          try {
            recordNetworkStatsBandwidth(JSON.parse(event.data));
          } catch (_statsErr) {}
        }
        if (event.data.indexOf("PIPELINE_RESETTING ") === 0) {
          noteVideoHealthEvent("pipeline-reset");
        }
        if (event.data === "clipboard_nochange" || event.data === "clipboard_unavailable") {
          if (pendingRemoteClipboardPull && pendingRemoteClipboardPull.timerId) {
            window.clearTimeout(pendingRemoteClipboardPull.timerId);
          }
          var statusTaskId = pendingRemoteClipboardPull && pendingRemoteClipboardPull.taskId ? pendingRemoteClipboardPull.taskId : "clipboard-force-remote";
          pendingRemoteClipboardPull = null;
          setActivityTask(statusTaskId, {
            title: event.data === "clipboard_nochange" ? "\u8fdc\u7aef\u526a\u8d34\u677f\u6ca1\u6709\u65b0\u53d8\u5316" : "\u672a\u8bfb\u53d6\u5230\u8fdc\u7aef\u526a\u8d34\u677f",
            detail: event.data === "clipboard_nochange"
              ? "\u5df2\u68c0\u67e5 Selkies \u4f1a\u8bdd\u526a\u8d34\u677f\uff0c\u5185\u5bb9\u4e0e\u4e0a\u6b21\u540c\u6b65\u4e00\u81f4\uff0c\u672a\u8986\u76d6\u672c\u673a\u526a\u8d34\u677f\u3002"
              : "\u8fdc\u7aef\u5f53\u524d\u6ca1\u6709\u53ef\u8bfb\u53d6\u7684\u526a\u8d34\u677f\u5185\u5bb9\uff0c\u672a\u8986\u76d6\u672c\u673a\u526a\u8d34\u677f\u3002",
            phase: "\u8fdc\u7aef -> \u5ba2\u6237\u7aef",
            kind: event.data === "clipboard_nochange" ? "success" : "warning",
            progress: event.data === "clipboard_nochange" ? 100 : null,
            indeterminate: event.data !== "clipboard_nochange",
            priority: 76,
            expiresAt: Date.now() + 3200
          });
        }
        if (
          event.data.indexOf("clipboard_start,") === 0 ||
          event.data.indexOf("clipboard_binary,") === 0 ||
          event.data.indexOf("clipboard,") === 0
        ) {
          var taskId = pendingRemoteClipboardPull && pendingRemoteClipboardPull.taskId ? pendingRemoteClipboardPull.taskId : "clipboard-auto-remote";
          setActivityTask(taskId, {
            title: pendingRemoteClipboardPull ? "\u6b63\u5728\u63a5\u6536\u8fdc\u7aef\u526a\u8d34\u677f" : "\u68c0\u6d4b\u5230\u8fdc\u7aef\u526a\u8d34\u677f\u53d8\u5316",
            detail: pendingRemoteClipboardPull
              ? "\u8fdc\u7aef\u526a\u8d34\u677f\u5df2\u6709\u53d8\u5316\uff0c\u6b63\u5728\u5199\u5165\u672c\u673a\u526a\u8d34\u677f\u3002"
              : "\u8fdc\u7aef\u526a\u8d34\u677f\u5df2\u81ea\u52a8\u53d8\u5316\uff0c\u6b63\u5728\u6536\u53d6\u5230\u672c\u673a\u3002",
            phase: "\u8fdc\u7aef -> \u5ba2\u6237\u7aef",
            kind: "info",
            progress: null,
            indeterminate: true,
            priority: pendingRemoteClipboardPull ? 76 : 70,
            expiresAt: Date.now() + 7000
          });
        }
      });
      activeDataSockets.push(ws);
      ws.addEventListener("open", function () {
        reportClientAwakeState();
        scheduleAutoSplitForPinSession(1800);
        window.setTimeout(function () {
          requestServerAudio("socket-open");
        }, 600);
      });
      ws.addEventListener("close", function () {
        activeDataSockets = activeDataSockets.filter(function (item) {
          return item !== ws;
        });
      });
      ws.addEventListener("close", function (event) {
        var code = event && typeof event.code === "number" ? event.code : 0;
        var reason = String((event && event.reason) || "").toLowerCase();
        recordUploadDiagnostic("websocket-close", {
          code: code,
          reason: String((event && event.reason) || "").slice(0, 240),
          wasClean: !!(event && event.wasClean)
        });
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

  function selectAutoSplitLayout(pageWidth, pageHeight) {
    var width = Math.max(1, Number(pageWidth) || 1);
    var height = Math.max(1, Number(pageHeight) || 1);
    if (width * 3 > height * 4) {
      return {
        mode: "lr",
        activeSide: "left",
        title: "\u5df2\u81ea\u52a8\u5de6\u53f3\u5206\u5c4f"
      };
    }
    if (height * 3 > width * 4) {
      return {
        mode: "tb",
        activeSide: "top",
        title: "\u5df2\u81ea\u52a8\u4e0a\u4e0b\u5206\u5c4f"
      };
    }
    return {
      mode: "fullscreen",
      activeSide: "left",
      title: "\u5df2\u81ea\u52a8\u5168\u90e8\u5168\u5c4f"
    };
  }

  function getCurrentPageSize() {
    var root = document.documentElement;
    return {
      width: Math.max(1, Number((root && root.clientWidth) || window.innerWidth) || 1),
      height: Math.max(1, Number((root && root.clientHeight) || window.innerHeight) || 1)
    };
  }

  function scheduleAutoSplitForPinSession(delayMs) {
    if (!autoSplitEntryPending || !autoSplitStateLoaded || !autoSplitEnabled) return;
    if (!WS_SESSION_ID || !WS_SESSION_EPOCH) return;
    var sessionKey = WS_SESSION_ID + "|" + String(WS_SESSION_EPOCH);
    if (autoSplitAppliedSessionKey === sessionKey || autoSplitTimer) return;
    if (autoSplitAttemptCount >= 40) {
      autoSplitEntryPending = false;
      return;
    }
    autoSplitTimer = window.setTimeout(function () {
      autoSplitTimer = null;
      if (!autoSplitEntryPending || !autoSplitEnabled || staleSessionHandled) return;
      var currentSessionKey = WS_SESSION_ID + "|" + String(WS_SESSION_EPOCH);
      if (currentSessionKey !== sessionKey) {
        autoSplitAttemptCount = 0;
        scheduleAutoSplitForPinSession(500);
        return;
      }
      if (!hasOpenDataSocket()) {
        autoSplitAttemptCount += 1;
        scheduleAutoSplitForPinSession(500);
        return;
      }
      var pageSize = getCurrentPageSize();
      var pageWidth = pageSize.width;
      var pageHeight = pageSize.height;
      var layout = selectAutoSplitLayout(pageWidth, pageHeight);
      var sent = sendRawDataCommand(
        "cmd,python3 /scripts/window_tiler.py split --mode " + layout.mode + " --active-side " + layout.activeSide
      );
      if (!sent) {
        autoSplitAttemptCount += 1;
        scheduleAutoSplitForPinSession(500);
        return;
      }
      autoSplitAppliedSessionKey = sessionKey;
      autoSplitEntryPending = false;
      setActivityTask("auto-split-session", {
        title: layout.title,
        detail:
          "\u5df2\u6839\u636e\u5f53\u524d\u9875\u9762 " +
          Math.round(pageWidth) +
          "\u00d7" +
          Math.round(pageHeight) +
          " \u7684\u5bbd\u9ad8\u6bd4\u5e94\u7528\u7a97\u53e3\u5e03\u5c40\uff1a\u8d85\u8fc7 4:3 / 3:4 \u9608\u503c\u65f6\u5206\u5c4f\uff0c\u9608\u503c\u5185\u5168\u90e8\u5168\u5c4f\u3002",
        kind: "success",
        progress: 100,
        indeterminate: false,
        priority: 72,
        expiresAt: Date.now() + 2800
      });
    }, Math.max(0, Number(delayMs) || 0));
  }

  function getPrimaryOpenDataSocket() {
    for (var i = activeDataSockets.length - 1; i >= 0; i -= 1) {
      var socket = activeDataSockets[i];
      if (socket && socket.readyState === window.WebSocket.OPEN) {
        return socket;
      }
    }
    return null;
  }

  function sleepMs(ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, Math.max(0, Number(ms) || 0));
    });
  }

  function bytesToBase64(bytes) {
    var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var parts = [];
    var stride = 0x8000;
    for (var i = 0; i < view.length; i += stride) {
      var chunk = view.subarray(i, Math.min(i + stride, view.length));
      var text = "";
      for (var j = 0; j < chunk.length; j += 1) {
        text += String.fromCharCode(chunk[j]);
      }
      parts.push(text);
    }
    return btoa(parts.join(""));
  }

  function emitClipboardTransferState(status, detail, extra) {
    var payload = Object.assign(
      {
        type: "clipboardTransferState",
        status: String(status || ""),
        detail: String(detail || "")
      },
      extra || {}
    );
    window.postMessage(payload, window.location.origin);
  }

  async function waitForSocketBufferedAmount(socket, maxBufferedBytes) {
    var ceiling = Math.max(0, Number(maxBufferedBytes) || 0);
    while (socket && socket.readyState === window.WebSocket.OPEN && socket.bufferedAmount > ceiling) {
      await sleepMs(25);
    }
  }

  async function sendManagedClipboardPayload(payload, mimeType) {
    var nativeSender = managedClipboardNativeSender;
    var socket = getPrimaryOpenDataSocket();
    if (!socket || socket.readyState !== window.WebSocket.OPEN) {
      if (typeof nativeSender === "function") {
        return nativeSender.apply(window, arguments);
      }
      throw new Error("WebSocket is not open.");
    }

    var isBinary = payload instanceof ArrayBuffer || ArrayBuffer.isView(payload);
    var bytes = isBinary
      ? payload instanceof Uint8Array
        ? payload
        : new Uint8Array(payload instanceof ArrayBuffer ? payload : payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength))
      : new TextEncoder().encode(String(payload || ""));
    var safeMime = isBinary ? String(mimeType || "application/octet-stream") : "text/plain";
    var totalBytes = bytes.byteLength;
    var isLargePayload = totalBytes >= CLIPBOARD_UPLOAD_CHUNK_SIZE;

    if (!isLargePayload) {
      await waitForSocketBufferedAmount(socket, CLIPBOARD_BUFFERED_HIGH_WATER_BYTES);
      var singlePayload = bytesToBase64(bytes);
      if (safeMime === "text/plain") {
        socket.send("cw," + singlePayload);
      } else {
        socket.send("cb," + safeMime + "," + singlePayload);
      }
      return true;
    }

    emitClipboardTransferState("start", "\u6b63\u5728\u5206\u7247\u53d1\u9001\u526a\u8d34\u677f\u5185\u5bb9\u3002", {
      sentBytes: 0,
      totalBytes: totalBytes,
      progress: 1
    });

    if (safeMime === "text/plain") {
      socket.send("cws," + totalBytes);
    } else {
      socket.send("cbs," + safeMime + "," + totalBytes);
    }

    var lastProgressAt = 0;
    for (var offset = 0; offset < totalBytes; offset += CLIPBOARD_UPLOAD_CHUNK_SIZE) {
      await waitForSocketBufferedAmount(socket, CLIPBOARD_BUFFERED_HIGH_WATER_BYTES);
      var chunk = bytes.subarray(offset, Math.min(offset + CLIPBOARD_UPLOAD_CHUNK_SIZE, totalBytes));
      var encodedChunk = bytesToBase64(chunk);
      if (safeMime === "text/plain") {
        socket.send("cwd," + encodedChunk);
      } else {
        socket.send("cbd," + encodedChunk);
      }
      var sentBytes = Math.min(totalBytes, offset + chunk.byteLength);
      var now = Date.now();
      if (now - lastProgressAt > 120 || sentBytes >= totalBytes) {
        lastProgressAt = now;
        emitClipboardTransferState("progress", "\u6b63\u5728\u53d1\u9001\u526a\u8d34\u677f\u5185\u5bb9\u3002", {
          sentBytes: sentBytes,
          totalBytes: totalBytes,
          progress: clamp((sentBytes / Math.max(1, totalBytes)) * 100, 1, 99)
        });
      }
      if (CLIPBOARD_SEND_YIELD_MS > 0) {
        await sleepMs(CLIPBOARD_SEND_YIELD_MS);
      } else {
        await sleepMs(0);
      }
    }

    await waitForSocketBufferedAmount(socket, Math.min(CLIPBOARD_BUFFERED_HIGH_WATER_BYTES, CLIPBOARD_UPLOAD_CHUNK_SIZE));
    socket.send(safeMime === "text/plain" ? "cwe" : "cbe");
    emitClipboardTransferState("progress", "\u526a\u8d34\u677f\u5185\u5bb9\u5df2\u53d1\u9001\uff0c\u7b49\u5f85\u8fdc\u7aef\u5199\u5165\u3002", {
      sentBytes: totalBytes,
      totalBytes: totalBytes,
      progress: 99
    });
    return true;
  }

  function installManagedClipboardSender() {
    if (managedClipboardSenderInstalled) return;
    managedClipboardSenderInstalled = true;
    var currentSender = window.selkiesSendClipboard;
    var managedSender = function (payload, mimeType) {
      return sendManagedClipboardPayload(payload, mimeType);
    };
    managedSender.__selkiesManagedClipboardSender = true;
    try {
      Object.defineProperty(window, "selkiesSendClipboard", {
        configurable: true,
        enumerable: true,
        get: function () {
          return managedSender;
        },
        set: function (value) {
          if (value && value.__selkiesManagedClipboardSender) return;
          managedClipboardNativeSender = typeof value === "function" ? value : null;
        }
      });
      if (typeof currentSender === "function" && !currentSender.__selkiesManagedClipboardSender) {
        managedClipboardNativeSender = currentSender;
      }
    } catch (_err) {
      if (typeof currentSender === "function" && !currentSender.__selkiesManagedClipboardSender) {
        managedClipboardNativeSender = currentSender;
      }
      window.selkiesSendClipboard = managedSender;
    }
  }

  function isForegroundControllerPage() {
    if (document.hidden) return false;
    if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
    return hasOpenDataSocket();
  }

  function noteVideoHealthEvent(source) {
    if (!VIDEO_CORRUPTION_WATCHDOG) return;
    if (!isForegroundControllerPage()) return;
    var now = Date.now();
    videoHealthEvents = videoHealthEvents.filter(function (event) {
      return now - event.ts < 30000;
    });
    videoHealthEvents.push({ source: String(source || "video"), ts: now });
    if (videoHealthEvents.length < 2) return;
    if (streamRecoveryInFlight) return;
    waitingSinceMs = now - STREAM_WAIT_THRESHOLD_MS - 1;
    tryRecoverFromWaiting();
  }

  function installVideoDecoderHealthGuard() {
    var NativeVideoDecoder = window.VideoDecoder;
    if (!NativeVideoDecoder || NativeVideoDecoder.__selkiesHealthWrapped) return;
    var WrappedVideoDecoder = function (init) {
      var safeInit = init || {};
      var originalError = safeInit.error;
      var wrappedInit = Object.assign({}, safeInit, {
        error: function (error) {
          noteVideoHealthEvent("decoder-error");
          if (typeof originalError === "function") {
            return originalError.apply(this, arguments);
          }
        }
      });
      return new NativeVideoDecoder(wrappedInit);
    };
    WrappedVideoDecoder.prototype = NativeVideoDecoder.prototype;
    Object.getOwnPropertyNames(NativeVideoDecoder).forEach(function (key) {
      if (key in WrappedVideoDecoder) return;
      try {
        WrappedVideoDecoder[key] = NativeVideoDecoder[key];
      } catch (_err) {}
    });
    WrappedVideoDecoder.__selkiesHealthWrapped = true;
    window.VideoDecoder = WrappedVideoDecoder;
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
    if (!hasOpenDataSocket()) return false;
    if (document.hidden) return false;
    if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
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
      config.disablePaintOver ? "1" : "0",
      config.mode
    ].join(",");
    sendRawDataCommand(payload);
  }

  function isRecentlyInteractive(windowMs) {
    return Date.now() - dynamicLatencyInteractionAt < (typeof windowMs === "number" ? windowMs : 1800);
  }

  function isRemoteAudioPlaying() {
    var bufferSize = Number(window.currentAudioBufferSize || 0);
    if (Number.isFinite(bufferSize) && bufferSize > 0) return true;
    return false;
  }

  function isTransportBusy() {
    return Object.keys(highLoadStateMap).length > 0 || Date.now() < highLoadBusyUntil;
  }

  function registerUploadTransportState(state) {
    if (!state) return;
    for (var i = 0; i < uploadTransportStates.length; i += 1) {
      if (uploadTransportStates[i] === state) return;
    }
    uploadTransportStates.push(state);
  }

  function getUploadReadGateDelayMs() {
    uploadTransportStates = uploadTransportStates.filter(function (state) {
      return !!(state && state.socket && state.socket.readyState !== window.WebSocket.CLOSED);
    });
    for (var i = 0; i < uploadTransportStates.length; i += 1) {
      var state = uploadTransportStates[i];
      if (!state || !state.uploadState) continue;
      if (state.queue && state.queue.length >= UPLOAD_QUEUE_HIGH_WATER_CHUNKS) {
        return UPLOAD_READ_GATE_DELAY_MS;
      }
      if (state.socket && state.socket.bufferedAmount >= UPLOAD_BUFFERED_HIGH_WATER_BYTES) {
        return UPLOAD_READ_GATE_DELAY_MS;
      }
    }
    return 0;
  }

  function installFileUploadReadBackpressure() {
    if (!window.FileReader || !window.FileReader.prototype || window.FileReader.prototype.__selkiesUploadReadGateWrapped) {
      return;
    }
    var nativeReadAsArrayBuffer = window.FileReader.prototype.readAsArrayBuffer;
    window.FileReader.prototype.readAsArrayBuffer = function () {
      var reader = this;
      var args = Array.prototype.slice.call(arguments);
      var delayMs = getUploadReadGateDelayMs();
      if (delayMs <= 0 || reader.readyState !== 0) {
        return nativeReadAsArrayBuffer.apply(reader, args);
      }
      var retry = function () {
        var nextDelay = getUploadReadGateDelayMs();
        if (nextDelay > 0) {
          window.setTimeout(retry, nextDelay);
          return;
        }
        nativeReadAsArrayBuffer.apply(reader, args);
      };
      window.setTimeout(retry, delayMs);
    };
    window.FileReader.prototype.__selkiesUploadReadGateWrapped = true;
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
    var wasBusy = Object.keys(highLoadStateMap).length > 0 || Date.now() < highLoadBusyUntil;
    if (active) {
      highLoadStateMap[key] = Date.now();
      highLoadBusyUntil = Math.max(highLoadBusyUntil, Date.now() + 16000);
    } else {
      delete highLoadStateMap[key];
      highLoadBusyUntil = Object.keys(highLoadStateMap).length ? Math.max(highLoadBusyUntil, Date.now() + 900) : 0;
    }
    updateTransportBusyTask();
    var isBusy = Object.keys(highLoadStateMap).length > 0 || Date.now() < highLoadBusyUntil;
    // Notify the server only when the aggregate state changes.  Progress
    // updates for an existing source must not repeatedly prune the video queue.
    if (wasBusy !== isBusy) {
      sendRawDataCommand(["HIGH_LOAD_STATE", isBusy ? "1" : "0", "client aggregate"].join(","));
    }
  }

  function clearAllHighLoadState(source) {
    var keys = Object.keys(highLoadStateMap);
    var wasBusy = keys.length > 0 || Date.now() < highLoadBusyUntil;
    highLoadStateMap = Object.create(null);
    highLoadBusyUntil = 0;
    if (highLoadReleaseTimer) {
      window.clearTimeout(highLoadReleaseTimer);
      highLoadReleaseTimer = null;
    }
    updateTransportBusyTask();
    if (wasBusy || keys.length) {
      sendRawDataCommand(["HIGH_LOAD_STATE", "0", "client aggregate"].join(","));
    }
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

  function pruneTrackedAudioContexts() {
    trackedAudioContexts = trackedAudioContexts.filter(function (context) {
      return context && context.state !== "closed";
    });
  }

  function resumeTrackedAudioContexts(source) {
    pruneTrackedAudioContexts();
    var resumed = false;
    for (var i = 0; i < trackedAudioContexts.length; i += 1) {
      var context = trackedAudioContexts[i];
      if (!context || context.state !== "suspended" || typeof context.resume !== "function") continue;
      try {
        context.resume().then(
          function () {
            lastAudioDecodedAt = Math.max(lastAudioDecodedAt, Date.now());
          },
          function () {}
        );
        resumed = true;
      } catch (_err) {}
    }
    if (resumed) {
      console.log("[selkies] requested audio context resume:", source || "watchdog");
    }
    return resumed;
  }

  function requestServerAudio(source, force) {
    if (!AUDIO_WATCHDOG && !force) return false;
    if (document.hidden && !force) return false;
    if (!hasOpenDataSocket()) return false;
    var now = Date.now();
    if (!force && now - lastAudioStartRequestAt < AUDIO_START_INTERVAL_MS) return false;
    lastAudioStartRequestAt = now;
    console.log("[selkies] requesting server audio:", source || "watchdog");
    return sendRawDataCommand("START_AUDIO");
  }

  function reinitializeTrackedAudioWorkers(source) {
    var now = Date.now();
    if (now - lastAudioReinitAt < AUDIO_START_INTERVAL_MS) return false;
    lastAudioReinitAt = now;
    var requested = false;
    trackedAudioWorkers = trackedAudioWorkers.filter(function (worker) {
      return !!worker;
    });
    trackedAudioWorkers.forEach(function (worker) {
      try {
        worker.postMessage({ type: "reinitialize" });
        requested = true;
      } catch (_err) {}
    });
    if (requested) {
      console.log("[selkies] requested audio decoder reinitialize:", source || "watchdog");
    }
    return requested;
  }

  function noteInboundStreamPacket(payload) {
    if (!payload || !(payload instanceof ArrayBuffer) || payload.byteLength < 1) return;
    var type = 0;
    try {
      type = new DataView(payload).getUint8(0);
    } catch (_err) {
      return;
    }
    if (type === 1) {
      lastAudioPacketAt = Date.now();
    } else if (type === 0 || type === 3 || type === 4) {
      lastVideoPacketAt = Date.now();
    }
  }

  function kickLocalRenderSurfaces(source) {
    if (document.hidden) return false;
    var nodes = [];
    var primary = findPrimaryStreamSurface();
    if (primary) nodes.push(primary);
    nodes = nodes.concat(Array.prototype.slice.call(document.querySelectorAll("#stream,video,canvas")));
    var seen = [];
    var kicked = false;
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (!node || seen.indexOf(node) >= 0 || !isElementVisible(node)) continue;
      seen.push(node);
      kicked = true;
      if (node.tagName && String(node.tagName).toLowerCase() === "video") {
        try {
          if (typeof node.play === "function") {
            var playResult = node.play();
            if (playResult && typeof playResult.catch === "function") playResult.catch(function () {});
          }
        } catch (_playErr) {}
      }
      try {
        var previousTransform = node.style.transform;
        var nextTransform = previousTransform ? previousTransform + " translateZ(0)" : "translateZ(0)";
        node.style.willChange = "transform";
        node.style.transform = nextTransform;
        window.setTimeout(
          (function (target, oldTransform, expectedTransform) {
            return function () {
              if (!target || !target.style) return;
              if (target.style.transform === expectedTransform) {
                target.style.transform = oldTransform;
              }
            };
          })(node, previousTransform, nextTransform),
          140
        );
      } catch (_styleErr) {}
      try {
        void node.offsetHeight;
      } catch (_layoutErr) {}
    }
    if (kicked) {
      try {
        window.dispatchEvent(new Event("resize"));
      } catch (_eventErr) {}
      console.log("[selkies] kicked visible render surfaces:", source || "watchdog");
    }
    return kicked;
  }

  function recoverRenderStall(source) {
    var now = Date.now();
    if (now - lastRenderKickAt < RENDER_STALL_COOLDOWN_MS) return false;
    lastRenderKickAt = now;
    kickLocalRenderSurfaces(source || "render-stall");
    suppressDynamicLatency(6000);
    if (dynamicLatencyApplied) {
      restoreDynamicLatency();
    }
    sendRawDataCommand("RESET_IO_MODULES");
    sendRawDataCommand("FORCE_STREAM_RECOVER,primary");
    window.setTimeout(function () {
      if (!hasOpenDataSocket() || document.hidden) return;
      if (!lastVideoPipelineActive) {
        sendRawDataCommand("START_VIDEO");
      }
    }, 350);
    return true;
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
    postContainerSleepActivity(false);
    scheduleAdaptiveSleepIdleWarning();
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

  function containerSleepApiPath(pathSuffix) {
    var base = appBasePath();
    if (!base.endsWith("/")) {
      base += "/";
    }
    return base + "api/container-sleep/" + String(pathSuffix || "").replace(/^\/+/, "");
  }

  function postContainerSleepActivity(force) {
    if (!window.fetch) return;
    var now = Date.now();
    if (!force && now - adaptiveSleepLastActivityPostAt < 900) return;
    adaptiveSleepLastActivityPostAt = now;
    window.fetch(containerSleepApiPath("activity"), {
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

  function loadContainerSleepStatus() {
    if (!window.fetch) return Promise.resolve(null);
    return window
      .fetch(containerSleepApiPath("status"), {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "X-Requested-With": "XMLHttpRequest" }
      })
      .then(function (response) {
        if (!response.ok) return null;
        return response.json();
      })
      .catch(function () {
        return null;
      });
  }

  function requestContainerSleepNow() {
    if (!window.fetch) return Promise.resolve(false);
    return window
      .fetch(containerSleepApiPath("sleep"), {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "X-Requested-With": "XMLHttpRequest" }
      })
      .then(function (response) {
        return response.ok;
      })
      .catch(function () {
        return false;
      });
  }

  function formatAdaptiveSleepRemaining(seconds) {
    var safe = Math.max(0, Math.ceil(Number(seconds) || 0));
    var mins = Math.floor(safe / 60);
    var secs = safe % 60;
    if (mins > 0) {
      return mins + ":" + String(secs).padStart(2, "0");
    }
    return String(secs) + "s";
  }

  function ensureAdaptiveSleepOverlayStyle() {
    if (document.getElementById("selkies-adaptive-sleep-style")) return;
    var style = document.createElement("style");
    style.id = "selkies-adaptive-sleep-style";
    style.textContent =
      "#selkies-adaptive-sleep-overlay{position:fixed;inset:0;z-index:10080;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(2,6,23,.42);opacity:0;pointer-events:none;transition:opacity .28s ease;color:#e5eefb;" +
      "font-family:\"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif}" +
      "#selkies-adaptive-sleep-overlay[data-open='1']{opacity:1;pointer-events:auto}" +
      "#selkies-adaptive-sleep-panel{display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center;padding:0 24px;max-width:min(92vw,620px)}" +
      "#selkies-adaptive-sleep-count{font-size:clamp(48px,12vw,112px);line-height:1;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:0;color:#f8fafc;text-shadow:0 16px 48px rgba(0,0,0,.45)}" +
      "#selkies-adaptive-sleep-title{font-size:clamp(18px,3vw,28px);font-weight:800;letter-spacing:0;color:#e0f2fe}" +
      "#selkies-adaptive-sleep-detail{font-size:clamp(13px,2vw,16px);line-height:1.7;color:#cbd5e1;max-width:560px}" +
      "#selkies-adaptive-sleep-bar{width:min(72vw,420px);height:5px;border-radius:999px;background:rgba(148,163,184,.28);overflow:hidden}" +
      "#selkies-adaptive-sleep-bar span{display:block;height:100%;width:0;background:#38bdf8;border-radius:inherit;transition:width .4s linear}";
    document.head.appendChild(style);
  }

  function ensureAdaptiveSleepOverlay() {
    ensureAdaptiveSleepOverlayStyle();
    var overlay = document.getElementById("selkies-adaptive-sleep-overlay");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "selkies-adaptive-sleep-overlay";
    overlay.setAttribute("data-open", "0");
    overlay.innerHTML =
      '<div id="selkies-adaptive-sleep-panel">' +
      '<div id="selkies-adaptive-sleep-count">60s</div>' +
      '<div id="selkies-adaptive-sleep-title">\u5bb9\u5668\u5373\u5c06\u4f11\u7720</div>' +
      '<div id="selkies-adaptive-sleep-detail">\u70b9\u51fb\u9f20\u6807\u6216\u6309\u4efb\u610f\u952e\u53ef\u53d6\u6d88\u4f11\u7720\u5e76\u91cd\u7f6e\u5f85\u673a\u5012\u8ba1\u65f6\u3002</div>' +
      '<div id="selkies-adaptive-sleep-bar"><span></span></div>' +
      "</div>";
    document.body.appendChild(overlay);
    return overlay;
  }

  function renderAdaptiveSleepOverlay() {
    if (!adaptiveSleepOverlayVisible || !adaptiveSleepLastStatus) return;
    var overlay = ensureAdaptiveSleepOverlay();
    var deadlineAt = Number(adaptiveSleepLastStatus.warning_deadline_at || 0) * 1000;
    var warningSeconds = Math.max(1, Number(adaptiveSleepLastStatus.warning_seconds || 60));
    var remainingSeconds = Math.max(0, (deadlineAt - Date.now()) / 1000);
    var progress = clamp(((warningSeconds - remainingSeconds) / warningSeconds) * 100, 0, 100);
    var count = overlay.querySelector("#selkies-adaptive-sleep-count");
    var bar = overlay.querySelector("#selkies-adaptive-sleep-bar span");
    if (count) count.textContent = formatAdaptiveSleepRemaining(remainingSeconds);
    if (bar) bar.style.width = String(progress) + "%";
    if (remainingSeconds <= 0 && overlay.dataset.sleepRequested !== "1") {
      overlay.dataset.sleepRequested = "1";
      requestContainerSleepNow().finally(function () {
        forcePinLogin();
      });
    }
  }

  function showAdaptiveSleepOverlay(status) {
    var nextStatus = status || adaptiveSleepLastStatus || {};
    var previousDeadline = Number((adaptiveSleepLastStatus && adaptiveSleepLastStatus.warning_deadline_at) || 0);
    var nextDeadline = Number(nextStatus.warning_deadline_at || 0);
    var resetSleepRequest = !adaptiveSleepOverlayVisible || Math.abs(nextDeadline - previousDeadline) > 0.25;
    adaptiveSleepLastStatus = nextStatus;
    adaptiveSleepOverlayVisible = true;
    var overlay = ensureAdaptiveSleepOverlay();
    if (resetSleepRequest) {
      overlay.dataset.sleepRequested = "0";
    }
    overlay.setAttribute("data-open", "1");
    renderAdaptiveSleepOverlay();
    if (!adaptiveSleepOverlayTimer) {
      adaptiveSleepOverlayTimer = window.setInterval(renderAdaptiveSleepOverlay, 1000);
    }
  }

  function hideAdaptiveSleepOverlay() {
    adaptiveSleepOverlayVisible = false;
    adaptiveSleepLastStatus = null;
    var overlay = document.getElementById("selkies-adaptive-sleep-overlay");
    if (overlay) {
      overlay.setAttribute("data-open", "0");
      overlay.dataset.sleepRequested = "0";
    }
    if (adaptiveSleepOverlayTimer) {
      window.clearInterval(adaptiveSleepOverlayTimer);
      adaptiveSleepOverlayTimer = null;
    }
  }

  function scheduleAdaptiveSleepIdleWarning() {
    if (adaptiveSleepIdleTimer) {
      window.clearTimeout(adaptiveSleepIdleTimer);
      adaptiveSleepIdleTimer = null;
    }
    if (!adaptiveSleepEnabled) {
      hideAdaptiveSleepOverlay();
      return;
    }
    var elapsed = Math.max(0, Date.now() - lastFrontendInteractionAt);
    var delay = Math.max(0, adaptiveSleepIdleSeconds * 1000 - elapsed);
    adaptiveSleepIdleTimer = window.setTimeout(function () {
      adaptiveSleepIdleTimer = null;
      beginLocalAdaptiveSleepWarning();
    }, delay);
  }

  function beginLocalAdaptiveSleepWarning() {
    if (!adaptiveSleepEnabled) return;
    var now = Date.now();
    if (now - lastFrontendInteractionAt < adaptiveSleepIdleSeconds * 1000) {
      scheduleAdaptiveSleepIdleWarning();
      return;
    }
    showAdaptiveSleepOverlay({
      ok: true,
      adaptive_sleep_enabled: true,
      pending_sleep: true,
      local_warning: true,
      warning_started_at: now / 1000,
      warning_deadline_at: (now + 60000) / 1000,
      warning_seconds: 60
    });
  }

  function cancelAdaptiveSleepWarning(event) {
    if (!adaptiveSleepOverlayVisible) return;
    stopFrontendShortcutEvent(event);
    noteFrontendInteraction();
    reportFrontendInteractionState(true);
    postContainerSleepActivity(true);
    hideAdaptiveSleepOverlay();
    scheduleAdaptiveSleepIdleWarning();
    window.setTimeout(pollAdaptiveSleepStatus, 400);
  }

  function applyAdaptiveSleepStatus(status) {
    if (!status || !status.ok) {
      if (!(adaptiveSleepLastStatus && adaptiveSleepLastStatus.local_warning)) {
        hideAdaptiveSleepOverlay();
      }
      return;
    }
    if (status.sleeping) {
      hideAdaptiveSleepOverlay();
      forcePinLogin();
      return;
    }
    if (!status.adaptive_sleep_enabled || !status.pending_sleep) {
      if (!(adaptiveSleepLastStatus && adaptiveSleepLastStatus.local_warning)) {
        hideAdaptiveSleepOverlay();
      }
      return;
    }
    showAdaptiveSleepOverlay(status);
  }

  function pollAdaptiveSleepStatus() {
    loadContainerSleepStatus().then(applyAdaptiveSleepStatus);
  }

  function startAdaptiveSleepStatusWatcher() {
    if (adaptiveSleepStatusTimer) return;
    reportFrontendInteractionState(true);
    postContainerSleepActivity(true);
    pollAdaptiveSleepStatus();
    scheduleAdaptiveSleepIdleWarning();
    adaptiveSleepStatusTimer = window.setInterval(pollAdaptiveSleepStatus, 2000);
    document.addEventListener("pointerdown", cancelAdaptiveSleepWarning, true);
    document.addEventListener("keydown", cancelAdaptiveSleepWarning, true);
    window.addEventListener("beforeunload", function () {
      hideAdaptiveSleepOverlay();
    });
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
    autoSplitEnabled = sanitizeBool(payload.auto_split_enabled, autoSplitEnabled);
    autoSplitStateLoaded = true;
    setStoredValue("auto_split_enabled", autoSplitEnabled);
    if (!autoSplitEnabled) {
      autoSplitEntryPending = false;
      if (autoSplitTimer) {
        window.clearTimeout(autoSplitTimer);
        autoSplitTimer = null;
      }
    }
    adaptiveSleepEnabled = sanitizeBool(payload.adaptive_sleep_enabled, adaptiveSleepEnabled);
    setStoredValue("adaptive_sleep_enabled", adaptiveSleepEnabled);
    adaptiveSleepIdleSeconds = sanitizeAdaptiveSleepIdleSeconds(payload.adaptive_sleep_idle_seconds || adaptiveSleepIdleSeconds);
    setStoredValue("adaptive_sleep_idle_seconds", adaptiveSleepIdleSeconds);
    scheduleAdaptiveSleepIdleWarning();
    qqIdleBlurSeconds = sanitizeInt(payload.idle_focus_seconds, qqIdleBlurSeconds, 0, 1800);
    if ([0, 60, 300, 600, 1800].indexOf(qqIdleBlurSeconds) < 0) {
      qqIdleBlurSeconds = 600;
    }
    setStoredValue("qq_idle_blur_seconds", qqIdleBlurSeconds);
    lanDiscoveryEnabled = sanitizeBool(payload.lan_discovery_enabled, lanDiscoveryEnabled);
    lanBroadcastName = sanitizeLanBroadcastName(payload.lan_broadcast_name, lanBroadcastName);
    setStoredValue("lan_discovery_enabled", lanDiscoveryEnabled);
    setStoredValue("lan_broadcast_name", lanBroadcastName);
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

  function getNotificationHistory() {
    var raw = getStoredValue(notificationHistoryKey);
    if (!raw) return [];
    try {
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(function (item) {
        return !isStreamNotificationEntry(item);
      });
    } catch (_err) {
      return [];
    }
  }

  function setNotificationHistory(items) {
    var trimmed = (items || []).filter(function (item) {
      return !isStreamNotificationEntry(item);
    }).slice(0, NOTIFICATION_HISTORY_LIMIT);
    var encoded = JSON.stringify(trimmed);
    while (trimmed.length > 20 && encoded.length > NOTIFICATION_HISTORY_MAX_BYTES) {
      trimmed.pop();
      encoded = JSON.stringify(trimmed);
    }
    setStoredValue(notificationHistoryKey, encoded);
  }

  function postNotificationBridgeEvent(entry) {
    if (!window.fetch || !entry) return;
    try {
      window.fetch(notificationApiPath("event"), {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest"
        },
        body: JSON.stringify(entry)
      }).catch(function () {});
    } catch (_err) {}
  }

  function recordNotificationCenterEvent(entry, dedupeMs) {
    if (isStreamNotificationEntry(entry)) return false;
    var added = addNotificationHistoryItem(entry, dedupeMs);
    if (added) {
      postNotificationBridgeEvent(entry);
    }
    return added;
  }

  function notificationHistoryEventKey(event, eventId) {
    var safe = event || {};
    return [
      String(eventId || ""),
      String(parseTimestamp(safe.ts) || ""),
      String(safe.app || ""),
      String(safe.title || ""),
      String(safe.body || "")
    ].join("|");
  }

  function getClientDeviceLabel() {
    var nav = window.navigator || {};
    var parts = [];
    if (nav.platform) parts.push(String(nav.platform));
    if (nav.userAgent) parts.push(String(nav.userAgent).replace(/\s+/g, " ").slice(0, 96));
    return parts.join(" / ") || "\u5f53\u524d\u6d4f\u89c8\u5668";
  }

  function recordSessionClientNotification(sessionId, sessionEpoch) {
    var sid = String(sessionId || "");
    if (!sid) return;
    var sessionKey = sid + "|" + String(sessionEpoch || "");
    if (sessionKey === lastNotificationSessionKey) return;
    lastNotificationSessionKey = sessionKey;
    setStoredValue(notificationSessionSeenKey, sessionKey);
    recordNotificationCenterEvent(
      {
        key: "session|" + sessionKey,
        id: parseTimestamp(sessionEpoch) || Date.now(),
        ts: Date.now(),
        app: "client",
        title: "\u5ba2\u6237\u7aef\u5df2\u767b\u5165",
        body: "\u767b\u5165\u8bbe\u5907\uff1a" + getClientDeviceLabel() + "\uff1b\u65f6\u95f4\uff1a" + new Date().toLocaleString("zh-CN"),
        source: "\u4f1a\u8bdd " + sid.slice(0, 8),
        device: getClientDeviceLabel(),
        session_id: sid,
        session_epoch: sessionEpoch
      },
      5000
    );
  }

  function notificationHistorySimilarKey(entry) {
    var safe = entry || {};
    return [
      String(safe.app || ""),
      String(safe.title || "").replace(/\s+/g, " ").trim()
    ].join("|");
  }

  function notificationHistoryHeaderKey(entry) {
    var app = String(entry && entry.app || "system").trim() || "system";
    return app;
  }

  function shouldMergeNotificationByHeader(entry) {
    var app = notificationHistoryHeaderKey(entry);
    return ["clipboard", "system", "tool", "audio", "client", "link"].indexOf(app) >= 0;
  }

  function isStreamNotificationEntry(entry) {
    var safe = entry || {};
    var app = String(safe.app || "").toLowerCase();
    var key = String(safe.key || "").toLowerCase();
    var title = String(safe.title || "");
    var source = String(safe.source || "");
    return app === "stream" ||
      key.indexOf("bandwidth|") === 0 ||
      title.indexOf("\u4eca\u65e5\u63a8\u6d41\u6d41\u91cf\u7edf\u8ba1") >= 0 ||
      source.indexOf("\u7f51\u7edc\u7edf\u8ba1\u91c7\u6837") >= 0;
  }

  function updateNotificationHistoryItem(currentItem, safe, key, ts, app, title, body, source) {
    return Object.assign({}, currentItem || {}, {
      key: key || (currentItem && currentItem.key),
      id: safe.id || ts,
      ts: ts,
      app: app,
      title: title || (currentItem && currentItem.title) || "\u9875\u9762\u901a\u77e5",
      body: body || "",
      source: source || ""
    });
  }

  function pruneNotificationHistoryRecent(now) {
    var keys = Object.keys(notificationHistoryRecentKeys);
    if (keys.length < 200) return;
    for (var i = 0; i < keys.length; i += 1) {
      if (now - (notificationHistoryRecentKeys[keys[i]] || 0) > 60000) {
        delete notificationHistoryRecentKeys[keys[i]];
      }
    }
  }

  function addNotificationHistoryItem(entry, dedupeMs) {
    var safe = entry || {};
    if (isStreamNotificationEntry(safe)) return false;
    var now = Date.now();
    var title = String(safe.title || "").trim();
    var body = String(safe.body || "").trim();
    if (!title && !body) return false;
    var app = String(safe.app || "system").trim() || "system";
    var source = String(safe.source || "").trim();
    var ts = parseTimestamp(safe.ts) || now;
    var similarKey = notificationHistorySimilarKey({
      app: app,
      title: title,
      body: body,
      source: source
    });
    var mergeWindowMs = typeof dedupeMs === "number" ? dedupeMs : NOTIFICATION_MERGE_WINDOW_MS;
    var key = String(safe.key || ["notice", app, ts, title, body, source].join("|"));
    var headerKey = notificationHistoryHeaderKey({ app: app });
    var mergeByHeader = shouldMergeNotificationByHeader({ app: app });
    var current = getNotificationHistory();
    for (var i = 0; i < current.length; i += 1) {
      if (String(current[i] && current[i].key) === key) {
        current[i] = updateNotificationHistoryItem(current[i], safe, key, ts, app, title, body, source);
        setNotificationHistory(current);
        notificationHistoryRecentKeys[similarKey] = now;
        pruneNotificationHistoryRecent(now);
        renderNotificationCenterHistory();
        return true;
      }
      if (
        mergeByHeader &&
        notificationHistoryHeaderKey(current[i]) === headerKey &&
        Math.abs((parseTimestamp(current[i] && current[i].ts) || 0) - ts) < NOTIFICATION_HEADER_MERGE_WINDOW_MS
      ) {
        current[i] = updateNotificationHistoryItem(current[i], safe, key, ts, app, title, body, source);
        setNotificationHistory(current);
        notificationHistoryRecentKeys[similarKey] = now;
        pruneNotificationHistoryRecent(now);
        renderNotificationCenterHistory();
        return true;
      }
      if (
        mergeWindowMs &&
        notificationHistorySimilarKey(current[i]) === similarKey &&
        Math.abs((parseTimestamp(current[i] && current[i].ts) || 0) - ts) < mergeWindowMs
      ) {
        current[i] = updateNotificationHistoryItem(current[i], safe, key, ts, app, title || current[i].title, body || current[i].body, source || current[i].source);
        setNotificationHistory(current);
        notificationHistoryRecentKeys[similarKey] = now;
        pruneNotificationHistoryRecent(now);
        renderNotificationCenterHistory();
        return true;
      }
    }
    notificationHistoryRecentKeys[similarKey] = now;
    pruneNotificationHistoryRecent(now);
    current.unshift({
      key: key,
      id: safe.id || ts,
      ts: ts,
      app: app,
      title: title || "\u9875\u9762\u901a\u77e5",
      body: body,
      source: source
    });
    current.sort(function (a, b) {
      var bTime = parseTimestamp(b && b.ts) || parseTimestamp(b && b.id);
      var aTime = parseTimestamp(a && a.ts) || parseTimestamp(a && a.id);
      return bTime - aTime;
    });
    setNotificationHistory(current);
    renderNotificationCenterHistory();
    return true;
  }

  function addNotificationHistoryEvents(events) {
    if (!Array.isArray(events) || !events.length) return;
    var seen = Object.create(null);
    for (var i = 0; i < events.length; i += 1) {
      var event = events[i] || {};
      var app = String(event.app || "");
      if (app === "stream" || isStreamNotificationEntry(event)) continue;
      if (["wechat", "qq", "clipboard", "stream", "client", "audio", "tool", "system", "link"].indexOf(app) < 0) continue;
      var eventId = parseTimestamp(event.id) || parseTimestamp(event.ts) || Date.now() + i;
      var eventKey = String(event.key || notificationHistoryEventKey(event, eventId));
      if (seen[eventKey]) continue;
      seen[eventKey] = true;
      addNotificationHistoryItem({
        key: eventKey,
        id: eventId,
        ts: parseTimestamp(event.ts) || Date.now(),
        app: app,
        title: String(event.title || (app === "wechat" ? "\u5fae\u4fe1\u65b0\u6d88\u606f" : app === "qq" ? "QQ \u65b0\u6d88\u606f" : "\u9875\u9762\u901a\u77e5")),
        body: String(event.body || ""),
        source: String(event.source || "")
      }, NOTIFICATION_MERGE_WINDOW_MS);
    }
    renderNotificationCenterHistory();
  }

  function formatNotificationCenterTime(ts) {
    var value = parseTimestamp(ts);
    if (!value) return "";
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    return date.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function todayKey() {
    var date = new Date();
    var month = String(date.getMonth() + 1).padStart(2, "0");
    var day = String(date.getDate()).padStart(2, "0");
    return date.getFullYear() + "-" + month + "-" + day;
  }

  function readBandwidthState() {
    var day = todayKey();
    var fallback = { day: day, bytes: 0, lastNoticeMb: 0, updatedAt: Date.now() };
    var raw = getStoredValue(notificationBandwidthStateKey);
    if (!raw) return fallback;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.day !== day) return fallback;
      parsed.bytes = Math.max(0, Number(parsed.bytes) || 0);
      parsed.lastNoticeMb = Math.max(0, Number(parsed.lastNoticeMb) || 0);
      parsed.updatedAt = parseTimestamp(parsed.updatedAt) || Date.now();
      return parsed;
    } catch (_err) {
      return fallback;
    }
  }

  function writeBandwidthState(state) {
    setStoredValue(notificationBandwidthStateKey, JSON.stringify(state || {}));
  }

  function readBandwidthSamples() {
    var raw = getStoredValue(notificationBandwidthSamplesKey);
    if (!raw) return [];
    try {
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_err) {
      return [];
    }
  }

  function writeBandwidthSamples(samples) {
    var cutoff = Date.now() - 24 * 60 * 60 * 1000;
    var cleaned = [];
    var total = 0;
    var items = Array.isArray(samples) ? samples : [];
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i] || {};
      var ts = parseTimestamp(item.ts);
      if (!ts || ts < cutoff) continue;
      var uploadBytes = Math.max(0, Number(item.uploadBytes) || 0);
      var downloadBytes = Math.max(0, Number(item.downloadBytes) || 0);
      cleaned.push({ ts: ts, uploadBytes: uploadBytes, downloadBytes: downloadBytes });
      total += uploadBytes + downloadBytes;
    }
    while (cleaned.length > 720) {
      var removed = cleaned.shift();
      total -= (Number(removed.uploadBytes) || 0) + (Number(removed.downloadBytes) || 0);
    }
    notificationBandwidthSummary.total24hBytes = Math.max(0, total);
    setStoredValue(notificationBandwidthSamplesKey, JSON.stringify(cleaned));
    return cleaned;
  }

  function formatTrafficSpeed(kbps) {
    var value = Math.max(0, Number(kbps) || 0);
    if (value >= 1024) return (value / 1024).toFixed(value >= 10240 ? 1 : 2) + " MB/s";
    return value.toFixed(value >= 10 ? 0 : 1) + " KB/s";
  }

  function formatTrafficTotal(bytes) {
    var gb = Math.max(0, Number(bytes) || 0) / 1024 / 1024 / 1024;
    return gb.toFixed(gb >= 10 ? 1 : 2) + " GB";
  }

  function renderNotificationBandwidthSummary() {
    var root = document.getElementById("selkies-notification-center");
    var el = root && root.querySelector(".selkies-notification-center-bandwidth");
    if (!el) return;
    var upload = Math.max(0, Number(notificationBandwidthSummary.uploadKbps) || 0);
    var download = Math.max(0, Number(notificationBandwidthSummary.downloadKbps) || 0);
    var dominant = upload >= download ? "upload" : "download";
    notificationBandwidthSummary.dominant = dominant;
    var speed = dominant === "upload" ? upload : download;
    var speedEl = el.querySelector("[data-bandwidth='speed']");
    var totalEl = el.querySelector("[data-bandwidth='total']");
    if (speedEl) {
      speedEl.textContent = formatTrafficSpeed(speed);
      speedEl.setAttribute("data-direction", dominant);
    }
    if (totalEl) {
      totalEl.textContent = formatTrafficTotal(notificationBandwidthSummary.total24hBytes);
    }
  }

  function maybeRecordDailyBandwidthNotice(force) {
    var state = readBandwidthState();
    var mb = state.bytes / 1024 / 1024;
    if (!force && mb < 1) return;
    if (!force && mb - (state.lastNoticeMb || 0) < 50) return;
    state.lastNoticeMb = mb;
    state.updatedAt = Date.now();
    writeBandwidthState(state);
    recordNotificationCenterEvent(
      {
        key: "bandwidth|" + state.day + "|" + Math.floor(mb),
        ts: Date.now(),
        app: "stream",
        title: "\u4eca\u65e5\u63a8\u6d41\u6d41\u91cf\u7edf\u8ba1",
        body: "\u5f53\u65e5\u63a8\u6d41\u7cfb\u7edf\u5df2\u4f30\u7b97\u4ea7\u751f " + mb.toFixed(mb >= 10 ? 1 : 2) + " MB \u5e26\u5bbd\u6d88\u8017\u3002",
        source: "\u7f51\u7edc\u7edf\u8ba1\u91c7\u6837",
        date: state.day,
        bytes: Math.round(state.bytes),
        mb: Number(mb.toFixed(2))
      },
      60000
    );
  }

  function recordNetworkStatsBandwidth(payload) {
    if (!payload || payload.type !== "network_stats") return;
    var uploadKbps = Number(payload.upload_kbps);
    var downloadKbps = Number(payload.download_kbps);
    if (!Number.isFinite(uploadKbps)) uploadKbps = Number(payload.bandwidth_mbps) * 1000;
    if (!Number.isFinite(downloadKbps)) downloadKbps = 0;
    uploadKbps = Math.max(0, uploadKbps || 0);
    downloadKbps = Math.max(0, downloadKbps || 0);
    if (uploadKbps <= 0 && downloadKbps <= 0) return;
    var now = Date.now();
    var elapsedSeconds = lastNetworkStatsAt ? Math.max(1, Math.min(30, (now - lastNetworkStatsAt) / 1000)) : 5;
    lastNetworkStatsAt = now;
    var uploadBytes = (uploadKbps * 1000 / 8) * elapsedSeconds;
    var downloadBytes = (downloadKbps * 1000 / 8) * elapsedSeconds;
    var bytes = uploadBytes + downloadBytes;
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    var samples = readBandwidthSamples();
    samples.push({ ts: now, uploadBytes: uploadBytes, downloadBytes: downloadBytes });
    writeBandwidthSamples(samples);
    notificationBandwidthSummary.uploadKbps = uploadKbps;
    notificationBandwidthSummary.downloadKbps = downloadKbps;
    renderNotificationBandwidthSummary();
    var state = readBandwidthState();
    state.bytes = Math.max(0, Number(state.bytes) || 0) + bytes;
    state.updatedAt = now;
    writeBandwidthState(state);
    maybeRecordDailyBandwidthNotice(false);
  }

  function startBandwidthNoticeTimer() {
    if (notificationBandwidthEventTimer) return;
    writeBandwidthSamples(readBandwidthSamples());
    renderNotificationBandwidthSummary();
    notificationBandwidthEventTimer = window.setInterval(function () {
      writeBandwidthSamples(readBandwidthSamples());
      renderNotificationBandwidthSummary();
      maybeRecordDailyBandwidthNotice(true);
    }, 10 * 60 * 1000);
  }

  function ensureNotificationCenterStyle() {
    if (document.getElementById("selkies-notification-center-style")) return;
    var style = document.createElement("style");
    style.id = "selkies-notification-center-style";
    style.textContent =
      "#selkies-notification-center{position:fixed;right:0;top:64px;bottom:44px;z-index:10024;display:flex;align-items:stretch;pointer-events:none}" +
      "#selkies-notification-center[data-enabled='0']{display:none}" +
      "#selkies-notification-center[data-open='1']{pointer-events:auto}" +
      "#selkies-notification-center-toggle{position:absolute;right:0;top:33.333%;transform:translateY(-50%);appearance:none;border:1px solid rgba(148,163,184,.38);border-right:none;border-radius:8px 0 0 8px;background:rgba(15,23,42,.42);width:10px;min-width:10px;height:76px;padding:0;font-size:0;line-height:0;cursor:pointer;box-shadow:none;backdrop-filter:blur(10px);pointer-events:auto;transition:right .22s ease,background .18s ease,border-color .18s ease}" +
      "#selkies-notification-center-toggle:hover{background:rgba(30,41,59,.64);border-color:#93c5fd}" +
      "#selkies-notification-center[data-open='1'] #selkies-notification-center-toggle{right:320px}" +
      "#selkies-notification-center-panel{width:320px;max-width:calc(100vw - 42px);height:100%;display:flex;flex-direction:column;background:rgba(8,15,28,.96);border:1px solid rgba(51,65,85,.92);border-right:none;border-radius:12px 0 0 12px;box-shadow:none;opacity:0;backdrop-filter:blur(16px);transform:translateX(100%);transition:transform .22s ease,opacity .22s ease}" +
      "#selkies-notification-center[data-open='1'] #selkies-notification-center-panel{transform:translateX(0);opacity:1;box-shadow:-18px 0 36px rgba(2,6,23,.28)}" +
      ".selkies-notification-center-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 12px 10px;border-bottom:1px solid rgba(148,163,184,.14)}" +
      ".selkies-notification-center-title{font-size:13px;font-weight:800;color:#f8fafc}" +
      ".selkies-notification-center-bandwidth{margin-left:auto;display:flex;align-items:center;gap:4px;font-size:10px;font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap}" +
      ".selkies-notification-center-bandwidth [data-bandwidth='speed'][data-direction='upload']{color:#fb923c}" +
      ".selkies-notification-center-bandwidth [data-bandwidth='speed'][data-direction='download']{color:#f472b6}" +
      ".selkies-notification-center-bandwidth [data-bandwidth='sep']{color:#475569}" +
      ".selkies-notification-center-bandwidth [data-bandwidth='total']{color:#cbd5e1}" +
      ".selkies-notification-center-count{font-size:11px;color:#93c5fd}" +
      ".selkies-notification-center-list{flex:1;overflow:auto;padding:10px 10px 8px;display:flex;flex-direction:column;gap:8px;scrollbar-width:thin;scrollbar-color:#64748b rgba(15,23,42,.55);scrollbar-gutter:stable}" +
      ".selkies-notification-center-list::-webkit-scrollbar{width:9px;height:9px}" +
      ".selkies-notification-center-list::-webkit-scrollbar-track{background:rgba(15,23,42,.55);border-radius:999px}" +
      ".selkies-notification-center-list::-webkit-scrollbar-thumb{background:linear-gradient(180deg,#64748b,#475569);border:2px solid rgba(15,23,42,.85);border-radius:999px}" +
      ".selkies-notification-center-list::-webkit-scrollbar-thumb:hover{background:linear-gradient(180deg,#94a3b8,#64748b)}" +
      ".selkies-notification-center-empty{font-size:12px;line-height:1.6;color:#94a3b8;padding:12px 4px}" +
      ".selkies-notification-center-item{border:1px solid rgba(71,85,105,.9);border-radius:8px;background:#0b1220;padding:9px 10px;display:flex;flex-direction:column;gap:5px}" +
      ".selkies-notification-center-row{display:flex;align-items:center;justify-content:space-between;gap:8px}" +
      ".selkies-notification-center-app{font-size:11px;font-weight:800;color:#bfdbfe;text-transform:uppercase}" +
      ".selkies-notification-center-time{font-size:10px;color:#64748b;white-space:nowrap}" +
      ".selkies-notification-center-subject{font-size:12px;font-weight:700;color:#e2e8f0;line-height:1.35;overflow-wrap:anywhere}" +
      ".selkies-notification-center-body{font-size:11px;line-height:1.45;color:#94a3b8;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}" +
      ".selkies-notification-center-source{font-size:10px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".selkies-notification-center-footer{padding:10px;border-top:1px solid rgba(148,163,184,.14)}" +
      ".selkies-notification-center-clear{appearance:none;width:100%;height:34px;border:1px solid #7f1d1d;border-radius:8px;background:#991b1b;color:#fee2e2;font-size:12px;font-weight:800;cursor:pointer}" +
      ".selkies-notification-center-clear:hover{filter:brightness(1.06)}" +
      "@media (max-width:640px){#selkies-notification-center{top:48px;bottom:34px}#selkies-notification-center[data-open='1'] #selkies-notification-center-toggle{right:min(320px,calc(100vw - 42px))}}";
    document.head.appendChild(style);
  }

  function ensureNotificationCenter() {
    if (!document.body) return null;
    ensureNotificationCenterStyle();
    var root = document.getElementById("selkies-notification-center");
    if (root) {
      root.setAttribute("data-enabled", notificationCenterEnabled ? "1" : "0");
      return root;
    }
    root = document.createElement("div");
    root.id = "selkies-notification-center";
    root.setAttribute("data-open", notificationCenterOpen ? "1" : "0");
    root.setAttribute("data-enabled", notificationCenterEnabled ? "1" : "0");
    root.innerHTML =
      '<button type="button" id="selkies-notification-center-toggle" title="\u901a\u77e5\u4e2d\u5fc3" aria-label="\u901a\u77e5\u4e2d\u5fc3"></button>' +
      '<aside id="selkies-notification-center-panel" aria-label="\u901a\u77e5\u4e2d\u5fc3\u5386\u53f2">' +
      '<div class="selkies-notification-center-head"><div class="selkies-notification-center-title">\u901a\u77e5\u4e2d\u5fc3</div><div class="selkies-notification-center-bandwidth"><span data-bandwidth="speed" data-direction="upload">0 KB/s</span><span data-bandwidth="sep">|</span><span data-bandwidth="total">0.00 GB</span></div><div class="selkies-notification-center-count"></div></div>' +
      '<div class="selkies-notification-center-list"></div>' +
      '<div class="selkies-notification-center-links"></div>' +
      '<div class="selkies-notification-center-footer"><button type="button" class="selkies-notification-center-clear">\u4e00\u952e\u6e05\u7406</button></div>' +
      "</aside>";
    document.body.appendChild(root);
    root.querySelector("#selkies-notification-center-toggle").addEventListener("click", function () {
      notificationCenterOpen = !notificationCenterOpen;
      setStoredValue("notification_center_open", notificationCenterOpen);
      root.setAttribute("data-open", notificationCenterOpen ? "1" : "0");
    });
    root.querySelector(".selkies-notification-center-clear").addEventListener("click", function () {
      setNotificationHistory([]);
      setUnreadState("wechat", false);
      setUnreadState("qq", false);
      renderNotificationCenterHistory();
    });
    renderNotificationBandwidthSummary();
    return root;
  }

  function notificationHistoryAppLabel(entry) {
    var app = String(entry && entry.app || "");
    if (app === "wechat") return "\u5fae\u4fe1";
    if (app === "qq") return "QQ";
    if (app === "clipboard") return "\u526a\u677f";
    if (app === "stream") return "\u63a8\u6d41";
    if (app === "client") return "\u5ba2\u6237\u7aef";
    if (app === "audio") return "\u97f3\u9891";
    if (app === "tool") return "\u5de5\u5177";
    if (app === "link") return "\u94fe\u63a5";
    if (app === "system") return "\u7cfb\u7edf";
    return app || "\u9875\u9762";
  }

  function createNotificationCenterItem(entry) {
    var item = document.createElement("div");
    item.className = "selkies-notification-center-item";
    var row = document.createElement("div");
    row.className = "selkies-notification-center-row";
    var app = document.createElement("div");
    app.className = "selkies-notification-center-app";
    app.textContent = notificationHistoryAppLabel(entry);
    var time = document.createElement("div");
    time.className = "selkies-notification-center-time";
    time.textContent = formatNotificationCenterTime(entry.ts);
    row.appendChild(app);
    row.appendChild(time);
    var subject = document.createElement("div");
    subject.className = "selkies-notification-center-subject";
    subject.textContent = entry.title || "";
    var body = document.createElement("div");
    body.className = "selkies-notification-center-body";
    body.textContent = entry.body || "";
    item.appendChild(row);
    item.appendChild(subject);
    if (entry.body) item.appendChild(body);
    if (entry.source) {
      var source = document.createElement("div");
      source.className = "selkies-notification-center-source";
      source.textContent = entry.source;
      item.appendChild(source);
    }
    return item;
  }

  function renderNotificationCenterHistory() {
    var root = ensureNotificationCenter();
    if (!root) return;
    root.setAttribute("data-open", notificationCenterOpen ? "1" : "0");
    root.setAttribute("data-enabled", notificationCenterEnabled ? "1" : "0");
    renderNotificationBandwidthSummary();
    var historyItems = getNotificationHistory().slice(0, NOTIFICATION_HISTORY_LIMIT);
    var count = root.querySelector(".selkies-notification-center-count");
    if (count) count.textContent = String(historyItems.length) + "/" + String(NOTIFICATION_HISTORY_LIMIT);
    var list = root.querySelector(".selkies-notification-center-list");
    if (!list) return;
    list.innerHTML = "";
    if (!historyItems.length) {
      var empty = document.createElement("div");
      empty.className = "selkies-notification-center-empty";
      empty.textContent = "\u6682\u65f6\u8fd8\u6ca1\u6709\u901a\u77e5\u5386\u53f2\u3002";
      list.appendChild(empty);
      renderLocalLinkHistory();
      return;
    }
    for (var i = 0; i < historyItems.length; i += 1) {
      list.appendChild(createNotificationCenterItem(historyItems[i]));
    }
    renderLocalLinkHistory();
  }

  function startNotificationHistoryCenter() {
    if (notificationHistoryRenderTimer) return;
    renderNotificationCenterHistory();
    notificationHistoryRenderTimer = window.setInterval(renderNotificationCenterHistory, 3000);
  }

  function applyNotificationEvents(events) {
    if (!Array.isArray(events) || !events.length) return;
    events.sort(function (a, b) {
      return parseTimestamp(a && a.id) - parseTimestamp(b && b.id);
    });
    addNotificationHistoryEvents(events);
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
      scheduleAutoSplitForPinSession(1800);
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
    clearStreamRecoveryNoticeTimer();
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
    clearStreamRecoveryNoticeTimer();
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

  function sanitizeAdaptiveSleepIdleSeconds(value) {
    var n = parseInt(String(value), 10);
    if ([60, 900, 1800, 2700, 3600].indexOf(n) >= 0) return n;
    return 3600;
  }

  function sanitizeDockPosition(value) {
    return String(value || "").toLowerCase() === "top" ? "top" : "bottom";
  }

  function sanitizeLanBroadcastName(value, fallbackValue) {
    var candidate = String(value || "").trim().toUpperCase();
    if (/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(candidate)) return candidate;
    var fallback = String(fallbackValue || "AXISNSBOX-000").trim().toUpperCase();
    return /^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(fallback) ? fallback : "AXISNSBOX-000";
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

  function summarizeClipboardContent(text) {
    var safe = String(text || "").replace(/\s+/g, " ").trim();
    if (!safe) return "\u7a7a\u526a\u8d34\u677f";
    if (isImageClipboardStatusText(safe)) return "\u56fe\u7247\u5185\u5bb9";
    if (safe.length > 120) return safe.slice(0, 120) + "...";
    return safe;
  }

  function recordClipboardReplacement(direction, text, source) {
    var summary = summarizeClipboardContent(text);
    var ts = Date.now();
    recordNotificationCenterEvent(
      {
        key: "clipboard|" + String(direction || "update") + "|" + ts + "|" + summary,
        ts: ts,
        app: "clipboard",
        title: "\u526a\u8d34\u677f\u5df2\u66ff\u6362",
        body: "\u65b9\u5411\uff1a" + String(direction || "\u672a\u77e5") + "\uff1b\u65b0\u5185\u5bb9\uff1a" + summary,
        source: source || "\u526a\u8d34\u677f\u540c\u6b65"
      },
      1200
    );
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

  function applyLegacyUploadFallback(enabled) {
    legacyUploadFallbackEnabled = !!enabled;
    setStoredValue("legacy_upload_fallback_enabled", legacyUploadFallbackEnabled);
    if (typeof window.__selkiesSetLegacyUploadFallback === "function") {
      window.__selkiesSetLegacyUploadFallback(legacyUploadFallbackEnabled);
    }
    LEGACY_UPLOAD_ENABLED = sanitizeBool(runtime.legacyUploadEnabled, false) || legacyUploadFallbackEnabled;
    if (legacyUploadFallbackEnabled) {
      installFileUploadReadBackpressure();
      installFileTransferTransportInterceptor();
    }
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
    var binaryClipboard = sanitizeBool(runtime.defaultBinaryClipboard, true);
    var defaultUseCpu = sanitizeBool(runtime.defaultUseCpu, false);
    var defaultStreamingMode = sanitizeBool(runtime.defaultH264StreamingMode, true);
    var defaultPaintOver = false;
    var defaultH264Crf = sanitizeInt(runtime.defaultH264Crf, 30, 5, 50);
    var dynamicLatencyEnabled = sanitizeBool(runtime.dynamicLowLatencyEnabled, true);
    var dynamicLatencyHoldMs = sanitizeInt(runtime.dynamicLowLatencyHoldMs, 15000, 300, 30000);
    var dynamicThrottleMode = sanitizeThrottleMode(runtime.dynamicThrottleMode || runtime.dynamicLowLatencyMode);
    var dynamicLatencyFps = sanitizeInt(runtime.dynamicLowLatencyFps, 8, 1, 120);
    var dynamicLatencyCrf = sanitizeInt(runtime.dynamicLowLatencyH264Crf, 33, 5, 50);
    var dynamicLatencySample = sanitizeInt(runtime.dynamicLowLatencySamplePercent, 91, 10, 100);
    var dynamicThrottleStrength = 10;

    primeNativeSelkiesForcedDefaults();
    setStoredDefault("framerate", frameRate);
    setStoredValue("isGamepadEnabled", false);
    setStoredValue("gamepad_enabled", false);
    setStoredValue("ui_sidebar_show_gamepads", false);
    setStoredValue("ui_sidebar_show_apps", false);
    setStoredValue("ui_sidebar_show_sharing", false);
    setStoredValue("enable_sharing", false);
    setStoredValue("enable_shared", false);
    setStoredValue("enable_player2", false);
    setStoredValue("enable_player3", false);
    setStoredValue("enable_player4", false);
    setStoredDefault("enable_binary_clipboard", binaryClipboard);
    setStoredDefault("use_cpu", defaultUseCpu);
    setStoredDefault("h264_streaming_mode", defaultStreamingMode);
    setStoredDefault("use_paint_over_quality", defaultPaintOver);
    setStoredDefault("h264_crf", defaultH264Crf);
    setStoredDefault("dynamic_low_latency_enabled", dynamicLatencyEnabled);
    setStoredDefault("dynamic_low_latency_hold_ms", dynamicLatencyHoldMs);
    setStoredDefault("dynamic_throttle_mode", dynamicThrottleMode);
    setStoredDefault("dynamic_low_latency_fps", dynamicLatencyFps);
    setStoredDefault("dynamic_low_latency_h264_crf", dynamicLatencyCrf);
    setStoredDefault("dynamic_low_latency_sample_percent", dynamicLatencySample);
    setStoredDefault("dynamic_throttle_strength", dynamicThrottleStrength);
    setStoredDefault("dynamic_low_latency_disable_paint_over", dynamicThrottleMode === "idle-low-occupancy");
    setStoredDefault("bottom_action_clipboard_buttons_enabled", false);
    setStoredDefault("bottom_action_dock_position", bottomActionDockPosition);
    setStoredValue("ui_show_sidebar", true);
    setStoredValue("ui_show_core_buttons", true);
    setStoredValue("ui_sidebar_show_fullscreen", true);

    var currentEncoder = getStoredValue("encoder");
    if (currentEncoder === null || !STABLE_ENCODERS.has(String(currentEncoder).toLowerCase())) {
      setStoredValue("encoder", preferredEncoder());
    }
    var currentRtcEncoder = getStoredValue("encoder_rtc");
    if (currentRtcEncoder === null || !STABLE_ENCODERS.has(String(currentRtcEncoder).toLowerCase())) {
      setStoredValue("encoder_rtc", preferredEncoder());
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

  function migrateVideoDefaultsOnce() {
    primeNativeSelkiesForcedDefaults();
    var paintMigrationKey = "static_area_optimization_default_off_v1";
    if (getStoredValue(paintMigrationKey) === null) {
      setStoredValue("use_paint_over_quality", false);
      setStoredValue(paintMigrationKey, "1");
    }

    var throttleMigrationKey = "dynamic_throttle_strength_default_10_v1";
    if (getStoredValue(throttleMigrationKey) === null) {
      setStoredValue("dynamic_throttle_strength", 10);
      setStoredValue("dynamic_low_latency_h264_crf", strengthToCrf(10));
      setStoredValue("dynamic_low_latency_sample_percent", strengthToSamplePercent(10));
      setStoredValue(throttleMigrationKey, "1");
    }
  }

  function primeRuntimeStorageDefaults() {
    initUseCpuHint();
    applyRuntimeDefaults();
    migrateUseCpuPreferenceOnce();
    migrateVideoDefaultsOnce();
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
      "box-shadow:0 14px 34px rgba(2,6,23,.28);color:#e2e8f0;opacity:0;pointer-events:none;" +
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

  function activityNotificationHistoryApp(id, task) {
    var raw = String(id || "") + " " + String(task && task.title || "") + " " + String(task && task.detail || "");
    if (/clipboard|\u526a\u8d34\u677f|\u526a\u677f/i.test(raw)) return "clipboard";
    if (/stream|\u63a8\u6d41|video|pipeline/i.test(raw)) return "stream";
    if (/audio|\u97f3\u9891|wechat-audio/i.test(raw)) return "audio";
    if (/session|client|browser|\u5ba2\u6237\u7aef|\u6d4f\u89c8\u5668/i.test(raw)) return "client";
    if (/setting|tools|repair|dock|bar|\u5de5\u5177|\u4fee\u590d/i.test(raw)) return "tool";
    return "system";
  }

  function recordActivityNotificationHistory(id, task) {
    if (!task || task.skipNotificationHistory) return;
    var title = String(task.title || "").trim();
    var detail = String(task.detail || "").trim();
    if (!title && !detail) return;
    var now = Date.now();
    addNotificationHistoryItem(
      {
        key: ["activity", String(id || ""), String(task.kind || ""), String(now), String(title), String(detail)].join("|"),
        id: "activity-" + String(id || "") + "-" + String(now),
        ts: task.updatedAt || now,
        app: activityNotificationHistoryApp(id, task),
        title: title || "\u9875\u9762\u901a\u77e5",
        body: detail,
        source: "\u9875\u9762\u901a\u77e5"
      },
      5000
    );
  }

  function setActivityTask(id, taskPatch) {
    if (!id) return;
    var now = Date.now();
    var existing = activityTasks[id];
    var current = existing || {
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
    var next = Object.assign({}, current, taskPatch || {}, {
      id: id,
      updatedAt: now
    });
    var historySignature = [
      String(next.title || ""),
      String(next.phase || ""),
      String(next.kind || "info"),
      String(next.status || "")
    ].join("|");
    var meaningfulHistoryChange = !existing ||
      String(current.title || "") !== String(next.title || "") ||
      String(current.phase || "") !== String(next.phase || "") ||
      String(current.kind || "info") !== String(next.kind || "info") ||
      String(current.status || "") !== String(next.status || "") ||
      ((Number(next.progress) >= 100 || next.kind === "success" || next.kind === "error") &&
        next.__historySignature !== historySignature);
    next.__historySignature = historySignature;
    activityTasks[id] = next;
    if (meaningfulHistoryChange && next.__historySignature !== (existing && existing.__historySignature)) {
      recordActivityNotificationHistory(id, next);
    }
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

  function ensureEncoderOptions(select) {
    if (!select) return;
    var values = Array.prototype.slice.call(select.options || []).map(function (opt) {
      return String(opt.value || "").toLowerCase();
    });
    if (values.indexOf("x264enc-striped") < 0) {
      var option = document.createElement("option");
      option.value = "x264enc-striped";
      option.textContent = "x264enc-striped";
      var insertAfter = Array.prototype.slice.call(select.options || []).find(function (opt) {
        return String(opt.value || "").toLowerCase() === "x264enc";
      });
      if (insertAfter && insertAfter.nextSibling) {
        select.insertBefore(option, insertAfter.nextSibling);
      } else {
        select.appendChild(option);
      }
    }
    if (String(getStoredValue("encoder") || "").toLowerCase() === "x264enc-striped") {
      select.value = "x264enc-striped";
    }
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
    ensureEncoderOptions(select);
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

  function elementStringValue(value) {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (typeof value.baseVal === "string") return value.baseVal;
    return String(value);
  }

  function sidebarToggleCandidateInfo(element) {
    var attrs = [
      elementStringValue(element.id),
      elementStringValue(element.className),
      element.getAttribute && element.getAttribute("aria-label"),
      element.getAttribute && element.getAttribute("title"),
      element.getAttribute && element.getAttribute("data-testid"),
      element.getAttribute && element.getAttribute("data-dock-action"),
      element.getAttribute && element.getAttribute("role")
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    var text = String(element.innerText || element.textContent || "").trim().toLowerCase();
    return {
      attrs: attrs,
      text: text,
      haystack: (attrs + " " + text).toLowerCase()
    };
  }

  function isRejectedSidebarToggleCandidate(element) {
    if (!element || !isElementVisible(element)) return true;
    if (
      element.closest &&
      element.closest(
        "#selkies-activity-layer,#selkies-local-link-prompt,#selkies-link-history-section,#selkies-dynamic-latency-section,#selkies-bottom-action-dock-shell,[data-dock-action]"
      )
    ) {
      return true;
    }
    var info = sidebarToggleCandidateInfo(element);
    var haystack = info.haystack;
    if (
      haystack.indexOf("fullscreen") >= 0 ||
      haystack.indexOf("full-screen") >= 0 ||
      haystack.indexOf("full screen") >= 0 ||
      haystack.indexOf("\u5168\u5c4f") >= 0 ||
      haystack.indexOf("split") >= 0 ||
      haystack.indexOf("\u5206\u5c4f") >= 0 ||
      haystack.indexOf("clipboard") >= 0 ||
      haystack.indexOf("\u526a\u8d34\u677f") >= 0 ||
      haystack.indexOf("wechat") >= 0 ||
      haystack.indexOf("\u5fae\u4fe1") >= 0 ||
      info.text === "qq" ||
      /(^|[\s_-])qq($|[\s_-])/.test(haystack)
    ) {
      return true;
    }
    return false;
  }

  function scoreSidebarToggleCandidate(element, options) {
    if (isRejectedSidebarToggleCandidate(element)) return -1;
    var opts = options || {};
    var rect = element.getBoundingClientRect();
    var nearSide = rect.left <= 44 || window.innerWidth - rect.right <= 44;
    if (!nearSide) return -1;
    var isThinBar = rect.width >= 8 && rect.width <= 42 && rect.height >= 56 && rect.height <= 420;
    var isSmallButton = rect.width >= 20 && rect.width <= 84 && rect.height >= 20 && rect.height <= 84;
    if (!isThinBar && !isSmallButton) return -1;
    var leftEdgeTab = rect.left <= 24 && isThinBar;
    var nearEdge =
      rect.left <= 96 || window.innerWidth - rect.right <= 96 || rect.top <= 96 || window.innerHeight - rect.bottom <= 96;
    var info = sidebarToggleCandidateInfo(element);
    var hasStrongSignal = info.haystack.indexOf("sidebar") >= 0 || info.haystack.indexOf("drawer") >= 0;
    var hasMenuSignal = /(^|[\s_-])menu($|[\s_-])/.test(info.haystack) || info.text === "\u2261" || info.text === "\u2630";
    if (opts.requireStrongSignal && !hasStrongSignal) return -1;
    if (!hasStrongSignal && !hasMenuSignal && !leftEdgeTab) return -1;
    if (!hasStrongSignal && opts.allowMenuOnly === false) return -1;
    var style = window.getComputedStyle(element);
    var score = 0;
    if (hasStrongSignal) score += 140;
    if (hasMenuSignal) score += 45;
    if (leftEdgeTab) score += 130;
    if (style.cursor === "pointer") score += 15;
    if (nearEdge) score += 25;
    if (rect.left <= 96) score += 20;
    if (isThinBar) score += 80;
    if (info.text === "" || info.text === "\u2261" || info.text === "\u2630") score += 10;
    score += Math.min(40, Math.round(rect.height / 6));
    score -= Math.min(30, Math.round(rect.width));
    return score;
  }

  function isStrongSidebarToggleCandidate(element) {
    if (isRejectedSidebarToggleCandidate(element)) return false;
    var tag = String(element.tagName || "").toLowerCase();
    var role = element.getAttribute && String(element.getAttribute("role") || "").toLowerCase();
    if (tag !== "button" && role !== "button") return false;
    var info = sidebarToggleCandidateInfo(element);
    return info.haystack.indexOf("sidebar") >= 0 || info.haystack.indexOf("drawer") >= 0;
  }

  function findSidebarToggleButton() {
    var nativeHandle = document.querySelector(".toggle-handle");
    if (nativeHandle && !isRejectedSidebarToggleCandidate(nativeHandle)) return nativeHandle;

    var strongSelectors = [
      'button[data-testid*="sidebar" i]',
      'button[data-testid*="drawer" i]',
      '[role="button"][data-testid*="sidebar" i]',
      '[role="button"][data-testid*="drawer" i]',
      'button[aria-label*="sidebar" i]',
      'button[aria-label*="drawer" i]',
      'button[title*="sidebar" i]',
      '[role="button"][aria-label*="sidebar" i]',
      '[role="button"][aria-label*="drawer" i]'
    ];
    for (var i = 0; i < strongSelectors.length; i += 1) {
      var strongMatches = Array.prototype.slice.call(document.querySelectorAll(strongSelectors[i]));
      for (var s = 0; s < strongMatches.length; s += 1) {
        if (isStrongSidebarToggleCandidate(strongMatches[s])) return strongMatches[s];
      }
    }

    var menuSelectors = [
      'button[aria-label*="menu" i]',
      'button[title*="menu" i]',
      '[role="button"][aria-label*="menu" i]'
    ];
    for (var m = 0; m < menuSelectors.length; m += 1) {
      var menuMatches = Array.prototype.slice.call(document.querySelectorAll(menuSelectors[m]));
      for (var n = 0; n < menuMatches.length; n += 1) {
        if (scoreSidebarToggleCandidate(menuMatches[n], { allowMenuOnly: true }) >= 95) return menuMatches[n];
      }
    }

    var nodes = Array.prototype.slice.call(document.querySelectorAll("button,[role='button'],div,span"));
    var best = null;
    var bestScore = 70;
    for (var j = 0; j < nodes.length; j += 1) {
      var button = nodes[j];
      var score = scoreSidebarToggleCandidate(button, { allowMenuOnly: true });
      if (score > bestScore) {
        bestScore = score;
        best = button;
      }
    }
    return best;
  }

  function findMainSidebarElement() {
    var direct = document.querySelector(".sidebar");
    if (direct && isElementVisible(direct)) return direct;
    var candidates = getSidebarCandidates();
    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = candidates[i];
      if (!isElementVisible(candidate)) continue;
      var rect = candidate.getBoundingClientRect();
      if (rect.width < 180 || rect.height < 200) continue;
      return candidate;
    }
    return null;
  }

  function toggleSidebarDrawer() {
    var sidebar = findMainSidebarElement();
    if (sidebar && sidebar.classList) {
      sidebar.classList.toggle("is-open");
      return true;
    }
    var toggle = findSidebarToggleButton();
    if (toggle && typeof toggle.click === "function") {
      toggle.click();
      return true;
    }
    return false;
  }

  function bindSidebarKeyboardShortcut() {
    if (sidebarKeyboardShortcutBound) return;
    sidebarKeyboardShortcutBound = true;
    var lastToggleAt = 0;
    function handleShortcut(event) {
      if (!event || event.defaultPrevented) return;
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      var key = String(event.key || "").toLowerCase();
      var code = String(event.code || "").toLowerCase();
      if (key !== "m" && code !== "keym") return;
      if (isFormLikeElement(event.target)) return;
      var now = Date.now();
      if (now - lastToggleAt < 350) {
        stopFrontendShortcutEvent(event);
        return;
      }
      if (!toggleSidebarDrawer()) return;
      lastToggleAt = now;
      stopFrontendShortcutEvent(event);
    }
    window.addEventListener("keydown", handleShortcut, true);
    window.addEventListener("keyup", handleShortcut, true);
    document.addEventListener("keydown", handleShortcut, true);
    document.addEventListener("keyup", handleShortcut, true);
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
    lastRenderProgressAt = lastFrameProgressAt;
    waitingSinceMs = 0;
    if (streamRecoveryInFlight || streamRecoveryStage > 0) {
      finishStreamRecoveryActivity("\u89c6\u9891\u5e27\u5df2\u6062\u590d\u66f4\u65b0\u3002", "success", 1800);
    }
  }

  function clearStreamRecoveryNoticeTimer() {
    if (!streamRecoveryNoticeTimer) return;
    window.clearTimeout(streamRecoveryNoticeTimer);
    streamRecoveryNoticeTimer = null;
  }

  function finishStreamRecoveryActivity(detail, kind, ttlMs) {
    clearStreamRecoveryNoticeTimer();
    streamRecoveryInFlight = false;
    streamRecoveryStage = 0;
    waitingSinceMs = 0;
    if (activityTasks["stream-reconfig"]) {
      completeActivityTask("stream-reconfig", detail, kind, ttlMs);
    }
  }

  function scheduleStreamRecoveryNoticeTimeout() {
    clearStreamRecoveryNoticeTimer();
    streamRecoveryNoticeTimer = window.setTimeout(function () {
      streamRecoveryNoticeTimer = null;
      if (!activityTasks["stream-reconfig"]) {
        streamRecoveryInFlight = false;
        streamRecoveryStage = 0;
        waitingSinceMs = 0;
        return;
      }
      if (!isStreamLikelyStalled()) {
        finishStreamRecoveryActivity("\u89c6\u9891\u5e27\u5df2\u6062\u590d\u66f4\u65b0\u3002", "success", 1800);
        return;
      }
      streamRecoveryInFlight = false;
      streamRecoveryStage = 0;
      waitingSinceMs = 0;
      completeActivityTask(
        "stream-reconfig",
        "\u81ea\u52a8\u6062\u590d\u547d\u4ee4\u5df2\u53d1\u9001\uff1b\u5982\u679c\u753b\u9762\u4ecd\u5f02\u5e38\uff0c\u8bf7\u5728\u4fa7\u8fb9\u680f\u70b9\u51fb\u91cd\u4fee\u590d\u3002",
        "warning",
        3200
      );
    }, STREAM_RECOVERY_NOTICE_MAX_MS);
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
    if (dynamicLatencyApplied) return false;
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
    if (!VIDEO_CORRUPTION_WATCHDOG) return;
    var now = Date.now();
    var lastRecoverAt = lastRecoverTimestamp();
    if (streamRecoveryInFlight) return;
    if (streamRecoveryStage === 0 && now - lastRecoverAt < Math.max(STREAM_RECOVER_COOLDOWN_MS, VIDEO_RECOVER_COOLDOWN_MS)) return;
    if (streamRecoveryStage === 0) {
      markRecoverTimestamp(now);
    }
    waitingSinceMs = 0;
    streamRecoveryInFlight = true;
    streamRecoveryStage += 1;
    if (streamRecoveryStage <= Math.max(1, VIDEO_SOFT_RECOVER_LIMIT)) {
      sendRawDataCommand("RESET_IO_MODULES");
      sendRawDataCommand("FORCE_STREAM_RECOVER,primary");
      window.setTimeout(function () {
        streamRecoveryInFlight = false;
      }, 900);
      return;
    }
    setActivityTask("stream-reconfig", {
      title: "\u63a8\u6d41\u8f7b\u91cf\u6062\u590d\u672a\u7a33\u5b9a",
      detail: "\u81ea\u52a8\u6062\u590d\u4ec5\u6267\u884c\u8f7b\u91cf\u91cd\u5efa\uff1b\u5982\u679c\u753b\u9762\u4ecd\u65e0\u6cd5\u6062\u590d\uff0c\u8bf7\u5728\u4fa7\u8fb9\u680f\u624b\u52a8\u70b9\u51fb\u91cd\u4fee\u590d\u3002",
      phase: "\u7b49\u5f85\u624b\u52a8\u91cd\u4fee\u590d",
      kind: "warning",
      progress: null,
      indeterminate: true,
      priority: 97,
      startedAt: now,
      expiresAt: now + STREAM_RECOVERY_NOTICE_MAX_MS + 4000
    });
    scheduleStreamRecoveryNoticeTimeout();
    markRecoverTimestamp(now);
    sendRawDataCommand("RESET_IO_MODULES");
    sendRawDataCommand("FORCE_STREAM_RECOVER,primary");
    window.setTimeout(function () {
      streamRecoveryInFlight = false;
    }, 1200);
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
        if (streamRecoveryStage > 0 && !streamRecoveryInFlight) {
          finishStreamRecoveryActivity("\u89c6\u9891\u5e27\u5df2\u6062\u590d\u66f4\u65b0\u3002", "success", 1800);
        }
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

  function getLastPageStallReloadAt() {
    return parseTimestamp(getStoredValue("page_stall_reload_at"));
  }

  function markPageStallReloadAt(tsMs) {
    setStoredValue("page_stall_reload_at", String(tsMs));
  }

  function recordUploadDiagnostic(eventName, fields) {
    var record = Object.assign(
      {
        event: String(eventName || "sample"),
        timestampMs: Date.now(),
        visibility: document.visibilityState || "unknown"
      },
      fields || {}
    );
    uploadDiagnostics.push(record);
    if (uploadDiagnostics.length > 120) {
      uploadDiagnostics.splice(0, uploadDiagnostics.length - 120);
    }
    try {
      console.debug("[selkies-diagnostics]", record);
    } catch (_err) {}
  }

  function flushUploadDiagnostics() {
    if (!uploadDiagnostics.length) return;
    var batch = uploadDiagnostics.splice(0, uploadDiagnostics.length);
    fetch("api/upload-diagnostics", {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: batch })
    }).catch(function () {
      uploadDiagnostics = batch.slice(-60).concat(uploadDiagnostics).slice(-120);
    });
  }

  function sampleUploadDiagnostics() {
    var heap = window.performance && window.performance.memory ? window.performance.memory : null;
    var bufferedAmount = 0;
    for (var i = 0; i < activeDataSockets.length; i += 1) {
      bufferedAmount += Math.max(0, Number(activeDataSockets[i] && activeDataSockets[i].bufferedAmount) || 0);
    }
    var queuedChunks = 0;
    var activeUploads = 0;
    for (var j = 0; j < uploadTransportStates.length; j += 1) {
      var state = uploadTransportStates[j];
      if (!state) continue;
      queuedChunks += state.queue ? state.queue.length : 0;
      if (state.uploadState) activeUploads += 1;
    }
    recordUploadDiagnostic("browser-sample", {
      jsHeapUsedBytes: heap ? Number(heap.usedJSHeapSize || 0) : null,
      jsHeapTotalBytes: heap ? Number(heap.totalJSHeapSize || 0) : null,
      jsHeapLimitBytes: heap ? Number(heap.jsHeapSizeLimit || 0) : null,
      bufferedAmountBytes: bufferedAmount,
      legacyUploadQueueChunks: queuedChunks,
      legacyActiveUploads: activeUploads,
      longTaskCount: uploadDiagnosticsLongTaskCount,
      longTaskMaxMs: Math.round(uploadDiagnosticsLongTaskMaxMs)
    });
    uploadDiagnosticsLongTaskCount = 0;
    uploadDiagnosticsLongTaskMaxMs = 0;
  }

  function startUploadDiagnostics() {
    if (uploadDiagnosticsSampleTimer) return;
    window.__selkiesRecordUploadDiagnostic = recordUploadDiagnostic;
    var previousReloadReason = getStoredValue("page_reload_reason");
    if (previousReloadReason) {
      recordUploadDiagnostic("previous-page-reload", { reason: previousReloadReason });
      setStoredValue("page_reload_reason", "");
    }
    uploadDiagnosticsSampleTimer = window.setInterval(sampleUploadDiagnostics, 5000);
    uploadDiagnosticsFlushTimer = window.setInterval(flushUploadDiagnostics, 15000);
    window.addEventListener("pagehide", function () {
      flushUploadDiagnostics();
    });
    sampleUploadDiagnostics();
  }

  function runSilentStreamSoftRecover(source) {
    var now = Date.now();
    if (streamRecoveryInFlight) return false;
    if (now - pageStallSoftRecoverAt < Math.min(60000, PAGE_STALL_THRESHOLD_MS)) return false;
    pageStallSoftRecoverAt = now;
    waitingSinceMs = 0;
    sendRawDataCommand("RESET_IO_MODULES");
    sendRawDataCommand("FORCE_STREAM_RECOVER,primary");
    markRecoverTimestamp(now);
    return true;
  }

  function maybeReloadForPageStall(stalledForMs, source) {
    if (stalledForMs < PAGE_STALL_RELOAD_THRESHOLD_MS) return false;
    var now = Date.now();
    if (now - getLastPageStallReloadAt() < PAGE_STALL_COOLDOWN_MS) return false;
    markPageStallReloadAt(now);
    var reloadReason = String(source || "page-stall") + ":" + String(Math.round(stalledForMs));
    setStoredValue("page_reload_reason", reloadReason);
    recordUploadDiagnostic("page-reload", {
      reason: reloadReason,
      stalledForMs: Math.round(stalledForMs)
    });
    flushUploadDiagnostics();
    try {
      window.location.reload();
      return true;
    } catch (_err) {
      return false;
    }
  }

  function checkPageStallHealth() {
    if (!PAGE_STALL_WATCHDOG) return;
    var now = Date.now();
    var expectedLag = now - lastPageWatchdogTickAt - 5000;
    lastPageWatchdogTickAt = now;
    if (document.hidden) return;
    if (isTransportBusy()) return;
    if (!hasOpenDataSocket()) return;

    var streamStalled = isStreamLikelyStalled();
    if (streamStalled && !waitingSinceMs) {
      waitingSinceMs = now;
    }
    var streamStalledFor = streamStalled && waitingSinceMs ? now - waitingSinceMs : 0;
    var frameStalledFor = lastFrameProgressAt && hasVisibleVideoStream() ? now - lastFrameProgressAt : 0;
    var loopWasBlocked = expectedLag >= PAGE_STALL_LOOP_LAG_MS;
    var shouldRecover =
      streamStalledFor >= PAGE_STALL_THRESHOLD_MS ||
      (frameStalledFor >= PAGE_STALL_THRESHOLD_MS && lastVideoPipelineActive) ||
      (loopWasBlocked && hasVisibleStreamSurface());
    if (!shouldRecover) return;

    runSilentStreamSoftRecover(loopWasBlocked ? "event-loop-lag" : "stream-stall");
    maybeReloadForPageStall(Math.max(frameStalledFor, streamStalledFor), "stream-stall");
  }

  function startPageStallWatchdog() {
    if (!PAGE_STALL_WATCHDOG || pageStallWatchdogTimer) return;
    lastPageWatchdogTickAt = Date.now();
    pageStallWatchdogTimer = window.setInterval(checkPageStallHealth, 5000);
    window.addEventListener("focus", function () {
      lastPageWatchdogTickAt = Date.now();
      window.setTimeout(checkPageStallHealth, 1200);
    });
    document.addEventListener("visibilitychange", function () {
      lastPageWatchdogTickAt = Date.now();
      if (!document.hidden) {
        window.setTimeout(checkPageStallHealth, 1200);
      }
    });
  }

  function checkAudioPlaybackHealth() {
    if (!AUDIO_WATCHDOG) return;
    if (document.hidden) return;
    if (!hasOpenDataSocket()) return;
    resumeTrackedAudioContexts("watchdog");
    if (!lastAudioPipelineActive) {
      requestServerAudio("pipeline-inactive");
      return;
    }
    var now = Date.now();
    if (!lastAudioPacketAt || now - lastAudioPacketAt >= AUDIO_PACKET_STALL_MS) {
      requestServerAudio("packet-stall");
      return;
    }
    var noRecentDecode = !lastAudioDecodedAt || now - lastAudioDecodedAt >= AUDIO_PACKET_STALL_MS;
    var bufferSize = Number(window.currentAudioBufferSize || 0);
    if (noRecentDecode && bufferSize <= 0) {
      reinitializeTrackedAudioWorkers("decode-stall");
      requestServerAudio("decode-stall");
    }
  }

  function startAudioPlaybackWatchdog() {
    if (!AUDIO_WATCHDOG || audioWatchdogTimer) return;
    audioWatchdogTimer = window.setInterval(checkAudioPlaybackHealth, 4000);
    window.addEventListener("focus", function () {
      window.setTimeout(checkAudioPlaybackHealth, 250);
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        window.setTimeout(checkAudioPlaybackHealth, 250);
      }
    });
  }

  function noteRenderProgressFromFps() {
    var fps = Number(window.fps || 0);
    if (!Number.isFinite(fps)) fps = 0;
    if (fps > 0) {
      lastObservedFps = fps;
      lastRenderProgressAt = Date.now();
    }
  }

  function checkRenderStallHealth() {
    if (!RENDER_STALL_WATCHDOG) return;
    if (document.hidden) return;
    if (!hasOpenDataSocket()) return;
    if (!lastVideoPipelineActive) return;
    if (isTransportBusy()) return;
    if (!hasVisibleStreamSurface()) return;
    noteRenderProgressFromFps();
    var now = Date.now();
    var recentInteraction = now - lastUiInteractionAt < Math.max(30000, RENDER_STALL_THRESHOLD_MS * 2);
    var recentVideoPackets = lastVideoPacketAt && now - lastVideoPacketAt < Math.max(30000, RENDER_STALL_THRESHOLD_MS * 3);
    var waitingStatus = isStreamLikelyStalled();
    if (!recentInteraction && !recentVideoPackets && !waitingStatus) return;
    var referenceAt = lastRenderProgressAt || lastFrameProgressAt || lastVideoPacketAt || now;
    if (now - referenceAt < RENDER_STALL_THRESHOLD_MS) return;
    recoverRenderStall(recentVideoPackets ? "render-stall-with-packets" : "render-stall-no-packets");
  }

  function startRenderStallWatchdog() {
    if (!RENDER_STALL_WATCHDOG || renderStallWatchdogTimer) return;
    lastRenderProgressAt = Date.now();
    renderStallWatchdogTimer = window.setInterval(checkRenderStallHealth, 3000);
    window.addEventListener("focus", function () {
      kickLocalRenderSurfaces("focus");
      window.setTimeout(checkRenderStallHealth, 800);
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        kickLocalRenderSurfaces("visible");
        window.setTimeout(checkRenderStallHealth, 800);
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
          uploadDiagnosticsLongTaskCount += entries.length;
          uploadDiagnosticsLongTaskMaxMs = Math.max(uploadDiagnosticsLongTaskMaxMs, worst);
          recordUploadDiagnostic("long-task", {
            count: entries.length,
            worstDurationMs: Math.round(worst)
          });
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
        receivedBytes: 0,
        active: true,
        transportAware: false,
        serverAware: false,
        status: "start",
        startedAt: Date.now(),
        completionTimer: null
      };
      managedFileTransfers[key] = state;
      if (state.active && dynamicLatencyApplied) {
        suppressDynamicLatency(6000);
        restoreDynamicLatency();
      }
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
      var receivedBytes = Math.max(0, Number(state.receivedBytes) || 0);
      var measuredBytes = state.serverAware ? receivedBytes : sentBytes;
      var title = state.direction === "download" ? "\u6b63\u5728\u4e0b\u8f7d\u6587\u4ef6" : "\u6b63\u5728\u4e0a\u4f20\u6587\u4ef6";
      var detail = state.fileName;
      var phase = "\u51c6\u5907\u4e2d";
      var progress = totalBytes > 0 ? clamp((measuredBytes / totalBytes) * 100, 1, 100) : null;
      var indeterminate = totalBytes <= 0;

      if (state.status === "progress") {
        phase = state.direction === "download" ? "\u4f20\u8f93\u4e2d" : state.serverAware ? "\u8fdc\u7aef\u63a5\u6536\u4e2d" : "\u53d1\u9001\u4e2d";
        if (progress !== null && state.direction === "upload") {
          progress = Math.min(progress, state.serverAware ? 99 : 90);
        }
      } else if (state.status === "finalizing") {
        phase = state.direction === "download" ? "\u6d4f\u89c8\u5668\u6536\u5c3e" : "\u8fdc\u7aef\u5199\u5165\u4e2d";
        progress = progress === null ? 96 : Math.max(progress, 96);
        indeterminate = false;
      } else if (state.status === "done") {
        phase = state.direction === "download" ? "\u4e0b\u8f7d\u5b8c\u6210" : "\u8fdc\u7aef\u5df2\u5199\u5165";
        progress = 100;
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
          (isRecentlyInteractive(1800)
            ? "\uff0c\u68c0\u6d4b\u5230\u4ea4\u4e92\uff0c\u4e0a\u4f20\u6b63\u5728\u4e3a\u64cd\u4f5c\u54cd\u5e94\u8ba9\u51fa\u5e26\u5bbd\u3002"
            : "\uff0c\u540e\u53f0\u4e0a\u4f20\u7ee7\u7eed\uff0c\u4f46\u4e0d\u4f1a\u4e3b\u52a8\u8ba9\u89c6\u9891\u8fdb\u5165\u95f2\u7f6e\u9650\u5e27\u3002");
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
        meta: totalBytes ? formatBytes(measuredBytes) + " / " + formatBytes(totalBytes) : ""
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

    function applyManagedUploadStatus(payload) {
      if (!payload || typeof payload !== "object") return;
      var name = String(payload.fileName || payload.name || "\u6587\u4ef6\u4f20\u8f93");
      var state = ensureManagedFileTransfer(name, payload.fileSize || payload.totalBytes, "upload");
      if (payload.transport === "http-sidecar") state.transport = "http-sidecar";
      var totalBytes = Math.max(state.totalBytes || 0, Number(payload.fileSize || payload.totalBytes) || 0);
      var receivedBytes = Math.max(0, Number(payload.receivedBytes || payload.bytesReceived) || 0);
      cancelManagedTransferCompletion(state);
      state.serverAware = true;
      state.totalBytes = totalBytes;
      state.receivedBytes = Math.max(state.receivedBytes || 0, receivedBytes);

      if (payload.status === "start") {
        state.active = true;
        state.status = "start";
        state.receivedBytes = 0;
        if (state.transport !== "http-sidecar") setHighLoadState(true, "file upload");
        renderManagedFileTransfer(state);
        return;
      }

      if (payload.status === "progress") {
        state.active = true;
        state.status = "progress";
        if (state.transport !== "http-sidecar") setHighLoadState(true, "file upload");
        renderManagedFileTransfer(state);
        return;
      }

      if (payload.status === "done") {
        state.active = true;
        state.status = "done";
        if (totalBytes > 0) state.receivedBytes = totalBytes;
        renderManagedFileTransfer(state);
        scheduleManagedTransferCompletion(state, 550);
        return;
      }

      if (payload.status === "error") {
        markManagedTransferError(name, payload.message || "\u4e0a\u4f20\u672a\u5b8c\u6210\u3002", "upload");
      }
    }

    window.__selkiesHasActiveFileTransfer = hasActiveFileTransfer;
    window.__selkiesEnsureManagedFileTransfer = ensureManagedFileTransfer;
    window.__selkiesRenderManagedFileTransfer = renderManagedFileTransfer;
    window.__selkiesScheduleManagedTransferCompletion = scheduleManagedTransferCompletion;
    window.__selkiesMarkManagedTransferError = markManagedTransferError;
    window.__selkiesApplyManagedUploadStatus = applyManagedUploadStatus;

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

    window.addEventListener("message", function (event) {
      var data = event && event.data;
      if (!data || data.type !== "fileUploadStatus" || !data.payload) return;
      applyManagedUploadStatus(data.payload);
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
        if (data.status === "progress") {
          setHighLoadState(true, "clipboard image");
          scheduleHighLoadRelease("clipboard image", 12000);
          setActivityTask("clipboard-image", {
            title: "\u6b63\u5728\u7c98\u8d34\u56fe\u7247",
            detail: data.detail || "\u6b63\u5728\u5206\u7247\u53d1\u9001\u56fe\u7247\u526a\u8d34\u677f\u3002",
            phase: "\u526a\u8d34\u677f\u6865\u63a5",
            kind: "info",
            progress: Number(data.progress) > 0 ? clamp(Number(data.progress), 1, 99) : null,
            indeterminate: !(Number(data.progress) > 0),
            priority: 78,
            meta:
              Number(data.totalBytes) > 0
                ? formatBytes(Number(data.sentBytes) || 0) + " / " + formatBytes(Number(data.totalBytes) || 0)
                : "",
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
      var hasIncomingText = typeof data.text === "string";
      var incomingText = hasIncomingText ? data.text : "";
      if (pendingRemoteClipboardPull && hasIncomingText) {
        var pullTaskId = pendingRemoteClipboardPull.taskId || "clipboard-force-remote";
        var pullSource = pendingRemoteClipboardPull.source || "remote";
        if (pendingRemoteClipboardPull.timerId) {
          window.clearTimeout(pendingRemoteClipboardPull.timerId);
        }
        if (isImageClipboardStatusText(incomingText)) {
          setActivityTask(pullTaskId, {
            title: pullSource.indexOf("shortcut") === 0 ? "\u590d\u5236\u5185\u5bb9\u5df2\u6536\u5230\u672c\u673a" : "\u5df2\u8986\u76d6\u672c\u673a\u526a\u8d34\u677f",
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
              recordClipboardReplacement("\u8fdc\u7aef -> \u5ba2\u6237\u7aef", incomingText, pullSource.indexOf("shortcut") === 0 ? "\u5feb\u6377\u952e\u6536\u53d6" : "\u624b\u52a8\u6536\u526a\u677f");
              setActivityTask(pullTaskId, {
                title: pullSource.indexOf("shortcut") === 0 ? "\u590d\u5236\u5185\u5bb9\u5df2\u6536\u5230\u672c\u673a" : "\u5df2\u8986\u76d6\u672c\u673a\u526a\u8d34\u677f",
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
              setActivityTask(pullTaskId, {
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
      } else if (hasIncomingText) {
        recordClipboardReplacement("\u8fdc\u7aef -> \u5ba2\u6237\u7aef", incomingText, "\u8fdc\u7aef\u526a\u8d34\u677f\u81ea\u52a8\u53d8\u5316");
        setActivityTask("clipboard-auto-remote", {
          title: "\u68c0\u6d4b\u5230\u8fdc\u7aef\u526a\u8d34\u677f\u53d8\u5316",
          detail: isImageClipboardStatusText(incomingText)
            ? "\u8fdc\u7aef\u526a\u8d34\u677f\u56fe\u7247\u5df2\u81ea\u52a8\u5199\u5165\u672c\u673a\u526a\u8d34\u677f\u3002"
            : "\u8fdc\u7aef\u526a\u8d34\u677f\u53d8\u5316\u5df2\u81ea\u52a8\u6536\u53d6\u5230\u672c\u673a\u526a\u8d34\u677f\u3002",
          phase: "\u8fdc\u7aef -> \u5ba2\u6237\u7aef",
          kind: "success",
          progress: 100,
          indeterminate: false,
          priority: 70,
          expiresAt: Date.now() + 2600
        });
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
          socket: socket,
          queue: [],
          flushing: false,
          uploadState: null,
          pendingEndMessage: null
        };
        fileTransferSockets.set(socket, state);
        registerUploadTransportState(state);
      }
      return state;
    }

    function getUploadFlushDelayMs() {
      if (isRecentlyInteractive(1800)) {
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
          }
          transportState.pendingEndMessage = null;
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
            transportState.uploadState.serverAware = false;
            transportState.uploadState.status = "start";
            transportState.uploadState.sentBytes = 0;
            transportState.uploadState.receivedBytes = 0;
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
    if (now - lastClipboardTriggerAt < 120) return false;
    lastClipboardTriggerAt = now;
    return sendRawDataCommand("cr");
  }

  function startRemoteClipboardPull(source, title, detail) {
    var safeSource = String(source || "remote");
    var taskId = safeSource.indexOf("shortcut") === 0 ? "clipboard-shortcut" : "clipboard-force-remote";
    if (pendingRemoteClipboardPull && pendingRemoteClipboardPull.timerId) {
      window.clearTimeout(pendingRemoteClipboardPull.timerId);
    }
    pendingRemoteClipboardPull = {
      source: safeSource,
      taskId: taskId,
      startedAt: Date.now(),
      timerId: window.setTimeout(function () {
        var timedOutTaskId = pendingRemoteClipboardPull && pendingRemoteClipboardPull.taskId ? pendingRemoteClipboardPull.taskId : taskId;
        pendingRemoteClipboardPull = null;
        setActivityTask(timedOutTaskId, {
          title: "\u6536\u53d6\u8fdc\u7aef\u526a\u8d34\u677f\u8d85\u65f6",
          detail: "\u672a\u5728\u9884\u671f\u65f6\u95f4\u5185\u83b7\u5f97 Selkies \u4f1a\u8bdd\u7684\u526a\u8d34\u677f\u5185\u5bb9\u3002",
          phase: "\u8fdc\u7aef -> \u5ba2\u6237\u7aef",
          kind: "warning",
          progress: null,
          indeterminate: true,
          priority: 80,
          expiresAt: Date.now() + 5200
        });
      }, 7000)
    };
    setActivityTask(taskId, {
      title: title || "\u6b63\u5728\u6536\u53d6\u8fdc\u7aef\u526a\u8d34\u677f",
      detail: detail || "\u6b63\u5728\u68c0\u67e5 Selkies \u4f1a\u8bdd\u7684\u526a\u8d34\u677f\u53d8\u5316\uff0c\u6709\u5dee\u5f02\u65f6\u4f1a\u8986\u76d6\u672c\u673a\u526a\u8d34\u677f\u3002",
      phase: "\u8fdc\u7aef -> \u5ba2\u6237\u7aef",
      kind: "info",
      progress: null,
      indeterminate: true,
      priority: 76,
      expiresAt: Date.now() + 7600
    });
    return requestClipboardSync(safeSource);
  }

  function clearClipboardSyncBurst() {
    clipboardShortcutBusy = false;
  }

  function getClipboardShortcutKey(event) {
    if (!event || event.repeat || event.isComposing || event.keyCode === 229) return "";
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return "";
    var key = String(event.key || "").toLowerCase();
    var code = String(event.code || "");
    if (key === "c" || code === "KeyC") return "c";
    if (key === "x" || code === "KeyX") return "x";
    if (key === "v" || code === "KeyV") return "v";
    return "";
  }

  function isLocalClipboardShortcutTarget(target) {
    if (!target || !target.closest) return false;
    if (target.closest("#overlayInput,#keyboard-input-assist,#videoCanvas,.video-container")) return false;
    return isFormLikeElement(target);
  }

  function canSendRemoteClipboardShortcut() {
    return !!(window.webrtcInput && typeof window.webrtcInput._sendKeyEvent === "function");
  }

  function markModifierGestureChorded() {
    if (modifierGestureState.remoteToClient.down) {
      modifierGestureState.remoteToClient.chorded = true;
      clearModifierHold(modifierGestureState.remoteToClient);
    }
  }

  function sendRemoteClipboardShortcut(shortcut) {
    var keysymByShortcut = { c: 99, x: 120, v: 118 };
    var codeByShortcut = { c: "KeyC", x: "KeyX", v: "KeyV" };
    var keysym = keysymByShortcut[shortcut];
    var code = codeByShortcut[shortcut];
    var input = window.webrtcInput;
    if (!keysym || !code || !input || typeof input._sendKeyEvent !== "function") return false;
    input._sendKeyEvent(65507, "ControlLeft", true);
    input._sendKeyEvent(keysym, code, true);
    input._sendKeyEvent(keysym, code, false);
    input._sendKeyEvent(65507, "ControlLeft", false);
    return true;
  }

  function clipboardDelay(ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, ms);
    });
  }

  function releaseClipboardShortcutLock() {
    window.setTimeout(function () {
      clipboardShortcutBusy = false;
    }, 80);
  }

  async function sendClientClipboardPayloadToRemote(payload) {
    if (!payload) return false;
    return withClientClipboardWritePermission(async function () {
      if (typeof window.__selkiesSendClipboardPayload === "function") {
        return !!(await window.__selkiesSendClipboardPayload(payload, { skipDuplicateCheck: true }));
      }
      if (window.selkiesSendClipboard && typeof window.selkiesSendClipboard === "function") {
        if (payload.type === "text") {
          await window.selkiesSendClipboard(payload.text || "", "text/plain");
          return true;
        }
        if (payload.type === "image" && payload.buffer && payload.mime) {
          await window.selkiesSendClipboard(payload.buffer, payload.mime);
          return true;
        }
      }
      return false;
    });
  }

  async function handleRemoteCopyShortcut(shortcut) {
    try {
      setActivityTask("clipboard-shortcut", {
        title: shortcut === "x" ? "\u6b63\u5728\u6267\u884c\u8fdc\u7aef\u526a\u5207" : "\u6b63\u5728\u6267\u884c\u8fdc\u7aef\u590d\u5236",
        detail: "\u5df2\u62e6\u622a\u5feb\u6377\u952e\uff0c\u6b63\u5728\u5148\u8ba9\u8fdc\u7aef\u5e94\u7528\u5199\u5165\u526a\u8d34\u677f\u3002",
        phase: "\u8fdc\u7aef\u5feb\u6377\u952e",
        kind: "info",
        progress: null,
        indeterminate: true,
        priority: 76,
        expiresAt: Date.now() + 3600
      });
      sendRemoteClipboardShortcut(shortcut);
      await clipboardDelay(shortcut === "x" ? 350 : 300);
      startRemoteClipboardPull(
        shortcut === "x" ? "shortcut-cut" : "shortcut-copy",
        "\u6b63\u5728\u6536\u53d6\u8fdc\u7aef\u526a\u8d34\u677f",
        shortcut === "x"
          ? "\u8fdc\u7aef\u526a\u5207\u5df2\u53d1\u9001\uff0c\u6b63\u5728\u62c9\u53d6\u65b0\u7684\u8fdc\u7aef\u526a\u8d34\u677f\u5230\u672c\u673a\u3002"
          : "\u8fdc\u7aef\u590d\u5236\u5df2\u53d1\u9001\uff0c\u6b63\u5728\u62c9\u53d6\u65b0\u7684\u8fdc\u7aef\u526a\u8d34\u677f\u5230\u672c\u673a\u3002"
      );
    } finally {
      releaseClipboardShortcutLock();
    }
  }

  async function handleRemotePasteShortcut() {
    return withClientClipboardTransferPermission(async function () {
      try {
      setActivityTask("clipboard-shortcut", {
        title: "\u6b63\u5728\u7c98\u8d34\u5230\u8fdc\u7aef",
        detail: "\u6b63\u5728\u8bfb\u53d6\u672c\u673a\u526a\u8d34\u677f\uff0c\u51c6\u5907\u5148\u540c\u6b65\u5230\u8fdc\u7aef\u518d\u6267\u884c Ctrl+V\u3002",
        phase: "\u5ba2\u6237\u7aef -> \u8fdc\u7aef",
        kind: "info",
        progress: null,
        indeterminate: true,
        priority: 76,
        expiresAt: Date.now() + 5200
      });
      var payload = await readClientClipboardPayload();
      if (payload) {
        try {
          var sent = await sendClientClipboardPayloadToRemote(payload);
          await clipboardDelay(70);
          if (sent) {
            setActivityTask("clipboard-shortcut", {
              title: "\u5df2\u540c\u6b65\u5230\u8fdc\u7aef\uff0c\u6b63\u5728\u7c98\u8d34",
              detail: "\u672c\u673a\u526a\u8d34\u677f\u5df2\u5199\u5165\u8fdc\u7aef\u4f1a\u8bdd\uff0c\u6b63\u5728\u5411\u8fdc\u7aef\u5e94\u7528\u53d1\u9001 Ctrl+V\u3002",
              phase: "\u5ba2\u6237\u7aef -> \u8fdc\u7aef",
              kind: "success",
              progress: 100,
              indeterminate: false,
              priority: 76,
              expiresAt: Date.now() + 2400
            });
          } else {
            setActivityTask("clipboard-shortcut", {
              title: "\u672a\u5199\u5165\u8fdc\u7aef\u526a\u8d34\u677f",
              detail: "\u672c\u673a\u526a\u8d34\u677f\u672a\u80fd\u540c\u6b65\u5230\u8fdc\u7aef\uff0c\u5df2\u6539\u4e3a\u76f4\u63a5\u5411\u8fdc\u7aef\u53d1\u9001 Ctrl+V\u3002",
              phase: "\u964d\u7ea7\u7c98\u8d34",
              kind: "warning",
              progress: null,
              indeterminate: true,
              priority: 82,
              expiresAt: Date.now() + 3600
            });
          }
        } catch (_err) {
          setActivityTask("clipboard-shortcut", {
            title: "\u8bfb\u53d6\u6216\u5199\u5165\u526a\u8d34\u677f\u5931\u8d25",
            detail: "\u6d4f\u89c8\u5668\u526a\u8d34\u677f\u6743\u9650\u6216\u8fdc\u7aef\u5199\u5165\u5931\u8d25\uff0c\u5df2\u6539\u4e3a\u76f4\u63a5\u5411\u8fdc\u7aef\u53d1\u9001 Ctrl+V\u3002",
            phase: "\u964d\u7ea7\u7c98\u8d34",
            kind: "warning",
            progress: null,
            indeterminate: true,
            priority: 82,
            expiresAt: Date.now() + 3600
          });
        }
      } else {
        setActivityTask("clipboard-shortcut", {
          title: "\u672a\u8bfb\u53d6\u5230\u672c\u673a\u526a\u8d34\u677f",
          detail: "\u672a\u53d6\u5230\u53ef\u540c\u6b65\u7684\u672c\u673a\u526a\u8d34\u677f\u5185\u5bb9\uff0c\u5df2\u76f4\u63a5\u5411\u8fdc\u7aef\u53d1\u9001 Ctrl+V\u3002",
          phase: "\u964d\u7ea7\u7c98\u8d34",
          kind: "warning",
          progress: null,
          indeterminate: true,
          priority: 78,
          expiresAt: Date.now() + 3000
        });
      }
      sendRemoteClipboardShortcut("v");
    } finally {
      releaseClipboardShortcutLock();
    }
    });
  }

  function bindClipboardSyncTriggers() {
    if (clipboardSyncTriggersBound) return;
    clipboardSyncTriggersBound = true;
    var seenKeydownEvents = typeof WeakSet === "function" ? new WeakSet() : null;
    var seenKeyupEvents = typeof WeakSet === "function" ? new WeakSet() : null;

    function isSeenOrMark(set, event, fallbackKey) {
      if (!event) return true;
      if (set) {
        if (set.has(event)) return true;
        set.add(event);
        return false;
      }
      if (event[fallbackKey]) return true;
      try {
        event[fallbackKey] = true;
      } catch (_err) {}
      return false;
    }

    function markActiveModifierGesturesChorded() {
      if (modifierGestureState.remoteToClient.down) {
        modifierGestureState.remoteToClient.chorded = true;
        clearModifierHold(modifierGestureState.remoteToClient);
      }
    }

    function handleKeydown(event) {
      if (isSeenOrMark(seenKeydownEvents, event, "__selkiesClipboardKeydownSeen")) return;
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
      } else {
        markActiveModifierGesturesChorded();
      }

      var shortcut = getClipboardShortcutKey(event);
      if (!shortcut || isLocalClipboardShortcutTarget(event.target)) return;
      if (!canSendRemoteClipboardShortcut()) return;

      stopFrontendShortcutEvent(event);
      noteUiInteraction();
      markModifierGestureChorded();
      if (clipboardShortcutBusy) return;

      clipboardShortcutBusy = true;
      if (shortcut === "v") {
        handleRemotePasteShortcut();
      } else {
        handleRemoteCopyShortcut(shortcut);
      }
    }

    function handleKeyup(event) {
      if (isSeenOrMark(seenKeyupEvents, event, "__selkiesClipboardKeyupSeen")) return;
      var bucket = getModifierGestureBucket(event);
      if (!bucket) return;
      clearModifierHold(bucket);
      var shouldRememberTap = bucket.down && !bucket.chorded && Date.now() - bucket.lastTriggerAt > 120;
      bucket.down = false;
      bucket.chorded = false;
      if (shouldRememberTap) {
        bucket.lastTapAt = Date.now();
      }
    }

    window.addEventListener("keydown", handleKeydown, true);
    window.addEventListener("keyup", handleKeyup, true);
    document.addEventListener("keydown", handleKeydown, true);
    document.addEventListener("keyup", handleKeyup, true);
  }

  function ensureForcedSelkiesControlStyle() {
    if (!document.head || document.getElementById("selkies-forced-control-style")) return;
    var style = document.createElement("style");
    style.id = "selkies-forced-control-style";
    style.textContent =
      "#touch-gamepad-host,[data-selkies-native-gamepad-hidden='1']{display:none!important}";
    document.head.appendChild(style);
  }

  function controlDescriptorText(node) {
    if (!node || typeof node.getAttribute !== "function") return "";
    var className = typeof node.className === "string" ? node.className : "";
    return [
      node.id,
      className,
      node.getAttribute("title"),
      node.getAttribute("aria-label"),
      node.getAttribute("name"),
      node.getAttribute("value"),
      node.innerText || node.textContent
    ]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isNativeGamepadControlText(text) {
    var safe = String(text || "").toLowerCase();
    return safe.indexOf("gamepad") >= 0 || safe.indexOf("\u624b\u67c4") >= 0;
  }

  function findNativeGamepadHideTarget(node) {
    if (!node || node === document.body || node === document.documentElement) return null;
    if (node.id === "touch-gamepad-host") return node;
    var target = typeof node.closest === "function"
      ? node.closest("button,[role='button'],label,li,details,section,article")
      : null;
    if (target && target !== document.body && target !== document.documentElement) return target;

    var parent = node;
    for (var depth = 0; parent && depth < 4; depth += 1) {
      if (parent === document.body || parent === document.documentElement) break;
      var rect = typeof parent.getBoundingClientRect === "function"
        ? parent.getBoundingClientRect()
        : { height: 0 };
      if (rect.height > 0 && rect.height < 180 && controlDescriptorText(parent).length < 180) {
        return parent;
      }
      parent = parent.parentElement;
    }
    return node;
  }

  function hideNativeSelkiesGamepadControls() {
    if (!document.body) return;
    ensureForcedSelkiesControlStyle();

    var host = document.getElementById("touch-gamepad-host");
    if (host) {
      host.innerHTML = "";
      host.style.display = "none";
      host.setAttribute("data-selkies-native-gamepad-hidden", "1");
    }

    var nodes = document.querySelectorAll(
      "button,[role='button'],input,label,summary,a,[title],[aria-label]," +
        "[id*='gamepad'],[id*='Gamepad'],[class*='gamepad'],[class*='Gamepad']"
    );
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (!node || node.getAttribute("data-selkies-native-gamepad-hidden") === "1") continue;
      if (!isNativeGamepadControlText(controlDescriptorText(node))) continue;
      var target = findNativeGamepadHideTarget(node);
      if (!target) continue;
      if (target !== node && target.getAttribute("data-selkies-native-gamepad-hidden") === "1") continue;
      target.style.display = "none";
      target.setAttribute("data-selkies-native-gamepad-hidden", "1");
      if ("checked" in node) {
        try {
          node.checked = false;
        } catch (_checkedErr) {}
      }
    }
  }

  function isToggleElementOn(node) {
    if (!node) return false;
    if ("checked" in node && node.checked === true) return true;
    var ariaPressed = node.getAttribute("aria-pressed");
    var ariaChecked = node.getAttribute("aria-checked");
    var dataState = node.getAttribute("data-state");
    return ariaPressed === "true" || ariaChecked === "true" || dataState === "checked" || dataState === "on";
  }

  function reflectToggleElementOff(node) {
    if (!node) return;
    if ("checked" in node) {
      try {
        node.checked = false;
      } catch (_checkedErr) {}
    }
    node.setAttribute("aria-pressed", "false");
    node.setAttribute("aria-checked", "false");
    if (node.getAttribute("data-state") === "checked" || node.getAttribute("data-state") === "on") {
      node.setAttribute("data-state", "off");
    }
    if (node.classList) {
      node.classList.remove("active", "checked", "enabled", "on");
    }
  }

  function forceNativePaintOverQualityToggleOff() {
    primeNativeSelkiesForcedDefaults();
    var toggle = document.getElementById("usePaintOverQualityToggle");
    if (!toggle) return;
    var active = isToggleElementOn(toggle);
    reflectToggleElementOff(toggle);
    if (!active || typeof toggle.click !== "function") return;
    var now = Date.now();
    if (now - nativePaintOverToggleClickAt < 1500) return;
    nativePaintOverToggleClickAt = now;
    try {
      toggle.click();
    } catch (_clickErr) {}
  }

  function enforceNativeSelkiesControls() {
    installForcedSelkiesDefaultsGuard();
    primeNativeSelkiesForcedDefaults();
    hideNativeSelkiesGamepadControls();
    forceNativePaintOverQualityToggleOff();
  }

  function startNativeSelkiesControlGuard() {
    enforceNativeSelkiesControls();
    window.setTimeout(enforceNativeSelkiesControls, 300);
    window.setTimeout(enforceNativeSelkiesControls, 1200);
    if (nativeSelkiesControlGuardTimer) return;
    nativeSelkiesControlGuardTimer = window.setInterval(enforceNativeSelkiesControls, 2500);
  }

  function maybeHideGameModeCloseButton(node, text) {
    var safe = String(text || "");
    if (safe !== "x" && safe !== "\u00d7" && safe !== "+" && safe !== "\u2715") return false;
    var parent = node && node.parentElement;
    for (var depth = 0; parent && depth < 4; depth += 1) {
      var parentText = String(parent.innerText || parent.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (parentText.indexOf("\u6e38\u620f\u6a21\u5f0f") >= 0 || parentText.indexOf("game mode") >= 0) {
        node.style.display = "none";
        node.setAttribute("data-selkies-game-mode-close-hidden", "1");
        return true;
      }
      parent = parent.parentElement;
    }
    return false;
  }

  function hideRemovedSidebarSections() {
    if (!document.body) return;

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
      "\u542f\u7528/\u7981\u7528\u624b\u67c4\u8f93\u5165",
      "\u542f\u7528\u624b\u67c4\u8f93\u5165",
      "\u7981\u7528\u624b\u67c4\u8f93\u5165",
      "player 2",
      "player 3",
      "player 4",
      "share",
      "sharing",
      "shared",
      "\u5171\u4eab",
      "\u5171\u4eab\u4f1a\u8bdd",
      "applications",
      "application",
      "apps",
      "\u5e94\u7528\u7a0b\u5e8f",
      "\u5e94\u7528"
    ];
    var containsTexts = ["touch gamepad", "gamepad", "\u624b\u67c4", "\u624b\u67c4\u8f93\u5165"];
    var nodes = sidebarHost.querySelectorAll("details,section,article,div,button,label,summary,span,a");
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (!isElementVisible(node)) continue;
      var text = String(node.innerText || node.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (!text) continue;
      if (maybeHideGameModeCloseButton(node, text)) continue;
      var shouldHide = exactTexts.indexOf(text) >= 0;
      for (var c = 0; !shouldHide && c < containsTexts.length; c += 1) {
        shouldHide = text.indexOf(containsTexts[c]) >= 0;
      }
      if (!shouldHide) continue;
      var container = node.closest("details,section,article,li,div");
      if (!container || container === sidebarHost) continue;
      if (container.getBoundingClientRect().height < 18) continue;
      container.style.display = "none";
      container.setAttribute("data-selkies-sidebar-section-hidden", "1");
    }
  }

  function startRemovedSidebarSectionGuard() {
    hideRemovedSidebarSections();
    window.setTimeout(hideRemovedSidebarSections, 1200);
    window.setInterval(hideRemovedSidebarSections, 4000);
  }

  function sanitizeThrottleMode(value) {
    var safe = String(value || "idle-low-occupancy").trim();
    if (safe === "idle-low-bandwidth" || safe === "bandwidth" || safe === "low-bandwidth") return "idle-low-bandwidth";
    if (safe === "idle-low-framerate" || safe === "framerate" || safe === "low-framerate") return "idle-low-framerate";
    return "idle-low-occupancy";
  }

  function deriveThrottleStrength(crf, samplePercent) {
    var sampleScore = Math.round((100 - sanitizeInt(samplePercent, 75, 10, 100)) / 0.9);
    var crfScore = Math.round((sanitizeInt(crf, 40, 5, 60) - 30) / 0.3);
    return Math.max(0, Math.min(100, Math.max(sampleScore, crfScore)));
  }

  function strengthToCrf(strength) {
    return Math.max(5, Math.min(60, Math.round(30 + sanitizeInt(strength, 35, 0, 100) * 0.3)));
  }

  function strengthToSamplePercent(strength) {
    return Math.max(10, Math.min(100, Math.round(100 - sanitizeInt(strength, 35, 0, 100) * 0.9)));
  }

  function modeUsesBandwidth(mode) {
    return mode === "idle-low-bandwidth" || mode === "idle-low-occupancy";
  }

  function modeUsesFramerate(mode) {
    return mode === "idle-low-framerate" || mode === "idle-low-occupancy";
  }

  function getDynamicLatencyConfig() {
    var mode = sanitizeThrottleMode(getStoredValue("dynamic_throttle_mode") || runtime.dynamicThrottleMode || runtime.dynamicLowLatencyMode);
    var fallbackStrength = deriveThrottleStrength(
      sanitizeInt(runtime.dynamicLowLatencyH264Crf, 35, 5, 60),
      sanitizeInt(runtime.dynamicLowLatencySamplePercent, 87, 10, 100)
    );
    var strength = sanitizeInt(getStoredValue("dynamic_throttle_strength"), fallbackStrength, 0, 100);
    var fps = sanitizeInt(getStoredValue("dynamic_low_latency_fps"), sanitizeInt(runtime.dynamicLowLatencyFps, 8, 1, 120), 1, 120);
    var crf = modeUsesBandwidth(mode) ? strengthToCrf(strength) : sanitizeInt(getStoredValue("h264_crf"), sanitizeInt(runtime.defaultH264Crf, 30, 5, 50), 5, 60);
    var samplePercent = modeUsesBandwidth(mode) ? strengthToSamplePercent(strength) : 100;
    return {
      enabled: sanitizeBool(getStoredValue("dynamic_low_latency_enabled"), sanitizeBool(runtime.dynamicLowLatencyEnabled, true)),
      mode: mode,
      holdMs: sanitizeInt(getStoredValue("dynamic_low_latency_hold_ms"), sanitizeInt(runtime.dynamicLowLatencyHoldMs, 15000, 300, 30000), 300, 30000),
      fps: modeUsesFramerate(mode) ? fps : sanitizeInt(getStoredValue("framerate"), sanitizeInt(runtime.defaultFramerate, 48, 1, 240), 1, 240),
      strength: strength,
      crf: crf,
      samplePercent: samplePercent,
      disablePaintOver: mode === "idle-low-occupancy"
    };
  }

  function syncDynamicLatencySettingsToBackend() {
    var config = getDynamicLatencyConfig();
    lastDynamicLatencyConfigSignature = getDynamicLatencyConfigSignature(config);
    postDashboardMessage("settings", {
      settings: {
        displayId: "primary",
        dynamic_low_latency_enabled: config.enabled,
        dynamic_throttle_mode: config.mode,
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
    clearStaleSidebarToggleState(toggle);
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

  function clearSidebarToggleState(element) {
    if (!element) return;
    element.removeAttribute("data-selkies-sidebar-toggle");
    element.removeAttribute("data-selkies-low-latency");
    element.style.removeProperty("position");
    element.style.removeProperty("left");
    element.style.removeProperty("right");
    element.style.removeProperty("top");
    element.style.removeProperty("bottom");
    element.style.removeProperty("transform");
    element.style.removeProperty("margin");
    element.style.removeProperty("z-index");
    var indicator = element.querySelector && element.querySelector(".selkies-sidebar-rainbow-core");
    if (indicator && indicator.parentElement) {
      indicator.parentElement.removeChild(indicator);
    }
  }

  function clearStaleSidebarToggleState(currentToggle) {
    var marked = Array.prototype.slice.call(document.querySelectorAll("[data-selkies-sidebar-toggle='1']"));
    for (var i = 0; i < marked.length; i += 1) {
      if (marked[i] !== currentToggle) {
        clearSidebarToggleState(marked[i]);
      }
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
      safe.mode,
      String(safe.fps),
      String(safe.crf),
      String(safe.samplePercent),
      String(safe.strength),
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
    sendDynamicLatencyState(active, active ? "inactive-limit" : "active-restore");
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
    document.body.setAttribute("data-selkies-throttle-mode", config.mode);
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
    if (isTransportBusy()) return;
    if (window.__selkiesHasActiveFileTransfer && window.__selkiesHasActiveFileTransfer()) return;
    if (lastDynamicLatencyConfigSignature !== getDynamicLatencyConfigSignature(config)) {
      syncDynamicLatencySettingsToBackend();
    }
    if (!dynamicLatencyApplied) {
      captureDynamicLatencyOriginals();
      dynamicLatencyApplied = true;
      applyDynamicLatencyProfile(true, config);
    }
  }

  function markDynamicLatencyInteractive(trigger) {
    var config = getDynamicLatencyConfig();
    dynamicLatencyInteractionAt = Date.now();
    dynamicLatencyUntil = Date.now() + config.holdMs;
    if (lastDynamicLatencyConfigSignature !== getDynamicLatencyConfigSignature(config)) {
      syncDynamicLatencySettingsToBackend();
    }
    if (dynamicLatencyApplied) {
      restoreDynamicLatency();
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
      '<span class="selkies-link-sidebar-title">\u52a8\u6001\u8282\u6d41</span>' +
      '<span class="selkies-link-summary-meta">\u95f2\u7f6e\u964d\u8f7d</span>' +
      "</summary>" +
      '<div class="selkies-link-details-body">' +
      '<div class="selkies-dll-grid">' +
      '<div class="selkies-dll-row selkies-dll-row-compact"><span>\u542f\u7528\u52a8\u6001\u8282\u6d41</span><input type="checkbox" data-dll="enabled"></div>' +
      '<div class="selkies-dll-field"><div class="selkies-dll-row"><span>\u8282\u6d41\u6a21\u5f0f</span></div><select class="selkies-dll-select" data-dll="mode"><option value="idle-low-bandwidth">\u95f2\u7f6e\u4f4e\u5e26\u5bbd</option><option value="idle-low-framerate">\u95f2\u7f6e\u4f4e\u5e27\u7387</option><option value="idle-low-occupancy">\u95f2\u7f6e\u4f4e\u5360\u7528</option></select></div>' +
      '<div class="selkies-dll-field"><div class="selkies-dll-row"><span>\u8fdb\u5165\u95f2\u7f6e\u5ef6\u8fdf</span><div class="selkies-dll-value" data-dll-value="hold"></div></div><input type="range" min="300" max="30000" step="100" data-dll="hold"></div>' +
      '<div class="selkies-dll-field" data-dll-field="fps"><div class="selkies-dll-row"><span>\u95f2\u7f6e\u5e27\u7387\u4e0a\u9650</span><div class="selkies-dll-value" data-dll-value="fps"></div></div><input type="range" min="1" max="60" step="1" data-dll="fps"></div>' +
      '<div class="selkies-dll-field" data-dll-field="strength"><div class="selkies-dll-row"><span>\u95f2\u7f6e\u8282\u6d41\u5f3a\u5ea6</span><div class="selkies-dll-value" data-dll-value="strength"></div></div><input type="range" min="0" max="100" step="1" data-dll="strength"></div>' +
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
        ".selkies-dll-select{width:100%;border:1px solid rgba(148,163,184,.28);border-radius:8px;background:#0f172a;color:#e2e8f0;padding:7px 8px;font-size:11px}" +
        ".selkies-dll-row input[type='checkbox']{accent-color:#38bdf8}" +
        ".selkies-dll-value{font-size:10px;color:#93c5fd;min-width:46px;text-align:right}";
      document.head.appendChild(style);
    }

    var config = getDynamicLatencyConfig();
    section.querySelector('[data-dll="enabled"]').checked = config.enabled;
    section.querySelector('[data-dll="mode"]').value = config.mode;
    section.querySelector('[data-dll="hold"]').value = String(config.holdMs);
    section.querySelector('[data-dll="fps"]').value = String(config.fps);
    section.querySelector('[data-dll="strength"]').value = String(config.strength);
    section.querySelector('[data-dll-value="hold"]').textContent = (config.holdMs / 1000).toFixed(1) + "s";
    section.querySelector('[data-dll-value="fps"]').textContent = String(config.fps);
    section.querySelector('[data-dll-value="strength"]').textContent = String(config.strength);
    var fpsField = section.querySelector('[data-dll-field="fps"]');
    var strengthField = section.querySelector('[data-dll-field="strength"]');
    if (fpsField) fpsField.style.display = modeUsesFramerate(config.mode) ? "" : "none";
    if (strengthField) strengthField.style.display = modeUsesBandwidth(config.mode) ? "" : "none";

    if (!section.dataset.bound) {
      section.dataset.bound = "1";
      section.addEventListener("input", function (event) {
        var target = event.target;
        if (!target || !target.dataset) return;
        var key = target.dataset.dll;
        if (key === "enabled") {
          setStoredValue("dynamic_low_latency_enabled", !!target.checked);
          syncDynamicLatencySettingsToBackend();
        } else if (key === "mode") {
          setStoredValue("dynamic_throttle_mode", target.value);
          syncDynamicLatencySettingsToBackend();
          renderDynamicLatencySection();
        } else if (key === "hold") {
          setStoredValue("dynamic_low_latency_hold_ms", target.value);
          section.querySelector('[data-dll-value="hold"]').textContent = (Number(target.value) / 1000).toFixed(1) + "s";
        } else if (key === "fps") {
          setStoredValue("dynamic_low_latency_fps", target.value);
          section.querySelector('[data-dll-value="fps"]').textContent = target.value;
          syncDynamicLatencySettingsToBackend();
        } else if (key === "strength") {
          setStoredValue("dynamic_throttle_strength", target.value);
          setStoredValue("dynamic_low_latency_h264_crf", strengthToCrf(target.value));
          setStoredValue("dynamic_low_latency_sample_percent", strengthToSamplePercent(target.value));
          section.querySelector('[data-dll-value="strength"]').textContent = target.value;
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
        } else if (key === "mode") {
          setStoredValue("dynamic_throttle_mode", target.value);
          renderDynamicLatencySection();
          syncDynamicLatencySettingsToBackend();
        }
      });
    }
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
      '<span class="selkies-link-summary-meta">\u901a\u77e5/\u526a\u677f/\u5e7f\u64ad/\u4e0a\u4f20</span>' +
      "</summary>" +
      '<div class="selkies-link-details-body">' +
      '<div class="selkies-repair-tools-body">' +
      '<label class="selkies-tool-row"><span>\u7a7f\u900f\u5f0f\u6d88\u606f\u63a8\u9001</span><input type="checkbox" data-debug-toggle="notification-passthrough"></label>' +
      '<label class="selkies-tool-row"><span>\u5f00\u542f\u901a\u77e5\u4fa7\u8fb9\u680f</span><input type="checkbox" data-debug-toggle="right-notification-center"></label>' +
      '<label class="selkies-tool-row"><span>\u81ea\u52a8\u5206\u5c4f</span><input type="checkbox" data-debug-toggle="auto-split"></label>' +
      '<label class="selkies-tool-row"><span>\u56de\u9000\u65e7\u7248\u4e0a\u4f20\u5de5\u5177</span><input type="checkbox" data-debug-toggle="legacy-upload-fallback"></label>' +
      '<label class="selkies-tool-row"><span>\u81ea\u9002\u5e94\u4f11\u7720</span><input type="checkbox" data-debug-toggle="adaptive-sleep"></label>' +
      '<label class="selkies-tool-row" data-debug-row="adaptive-sleep-idle-seconds"><span>\u5f85\u673a\u65f6\u95f4</span><select data-debug-select="adaptive-sleep-idle-seconds"><option value="60">1\u5206\u949f</option><option value="900">15\u5206\u949f</option><option value="1800">30\u5206\u949f</option><option value="2700">45\u5206\u949f</option><option value="3600">60\u5206\u949f</option></select></label>' +
      '<label class="selkies-tool-row"><span>\u5c40\u57df\u7f51\u5e7f\u64ad</span><input type="checkbox" data-debug-toggle="lan-discovery"></label>' +
      '<label class="selkies-tool-row" data-debug-row="lan-broadcast-name"><span>\u5e7f\u64ad\u540d</span><input type="text" maxlength="32" spellcheck="false" autocomplete="off" placeholder="AXISNSBOX-000" data-debug-input="lan-broadcast-name"></label>' +
      '<label class="selkies-tool-row"><span>\u5e95\u90e8\u680f\u526a\u677f\u6309\u94ae</span><input type="checkbox" data-debug-toggle="bottom-clipboard-buttons"></label>' +
      '<label class="selkies-tool-row"><span>\u5feb\u6377 Bar \u4f4d\u7f6e</span><select data-debug-select="bottom-dock-position"><option value="bottom">\u5e95\u90e8</option><option value="top">\u9876\u90e8</option></select></label>' +
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
        ".selkies-repair-tools-body{display:flex;flex-direction:column;gap:10px}" +
        ".selkies-repair-btn{appearance:none;border:1px solid #166534;background:linear-gradient(180deg,#166534,#14532d);color:#ecfdf5;border-radius:10px;padding:9px 10px;font-size:12px;font-weight:800;cursor:pointer;text-align:center}" +
        ".selkies-repair-btn:hover{filter:brightness(1.06)}" +
        ".selkies-repair-btn:active{transform:translateY(1px)}" +
        ".selkies-repair-btn:disabled{opacity:.55;cursor:not-allowed;filter:none}" +
        ".selkies-repair-btn.secondary{border-color:#334155;background:linear-gradient(180deg,#172554,#111827);color:#e2e8f0}" +
        ".selkies-repair-btn.danger{border-color:#7f1d1d;background:linear-gradient(180deg,#dc2626,#991b1b);color:#fee2e2}" +
        ".selkies-repair-note{font-size:10px;line-height:1.5;color:#94a3b8}" +
        ".selkies-tool-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:2px 0;font-size:12px;color:#e2e8f0}" +
        ".selkies-tool-row input[type='checkbox']{accent-color:#38bdf8}" +
        ".selkies-tool-row[data-hidden='1']{display:none}" +
        ".selkies-tool-row select,.selkies-tool-row input[type='text']{min-width:112px;width:132px;height:26px;padding:0 8px;border-radius:8px;border:1px solid rgba(71,85,105,.92);background:#101826;color:#e2e8f0;font-size:12px}" +
        ".selkies-tool-row input[type='text']:focus{outline:none;border-color:#38bdf8;box-shadow:0 0 0 2px rgba(56,189,248,.15)}";
      document.head.appendChild(style);
    }
    var notificationToggle = section.querySelector('[data-debug-toggle="notification-passthrough"]');
    var notificationCenterToggle = section.querySelector('[data-debug-toggle="right-notification-center"]');
    var autoSplitToggle = section.querySelector('[data-debug-toggle="auto-split"]');
    var legacyUploadToggle = section.querySelector('[data-debug-toggle="legacy-upload-fallback"]');
    var adaptiveSleepToggle = section.querySelector('[data-debug-toggle="adaptive-sleep"]');
    var adaptiveSleepIdleSelect = section.querySelector('[data-debug-select="adaptive-sleep-idle-seconds"]');
    var lanDiscoveryToggle = section.querySelector('[data-debug-toggle="lan-discovery"]');
    var lanBroadcastNameRow = section.querySelector('[data-debug-row="lan-broadcast-name"]');
    var lanBroadcastNameInput = section.querySelector('[data-debug-input="lan-broadcast-name"]');
    var bottomClipboardToggle = section.querySelector('[data-debug-toggle="bottom-clipboard-buttons"]');
    var bottomDockPositionSelect = section.querySelector('[data-debug-select="bottom-dock-position"]');
    var idleFocusRow = section.querySelector('[data-debug-row="idle-focus-seconds"]');
    var idleFocusSelect = section.querySelector('[data-debug-select="idle-focus-seconds"]');
    if (notificationToggle) {
      notificationToggle.checked = !!notificationPassthroughEnabled;
    }
    if (notificationCenterToggle) {
      notificationCenterToggle.checked = !!notificationCenterEnabled;
    }
    if (autoSplitToggle) {
      autoSplitToggle.checked = !!autoSplitEnabled;
    }
    if (legacyUploadToggle) {
      legacyUploadToggle.checked = !!legacyUploadFallbackEnabled;
      legacyUploadToggle.disabled = window.__selkiesStandaloneUploadAvailable === false;
    }
    if (adaptiveSleepToggle) {
      adaptiveSleepToggle.checked = !!adaptiveSleepEnabled;
    }
    if (adaptiveSleepIdleSelect) {
      adaptiveSleepIdleSelect.value = String(adaptiveSleepIdleSeconds);
      adaptiveSleepIdleSelect.disabled = !adaptiveSleepEnabled;
    }
    if (lanDiscoveryToggle) {
      lanDiscoveryToggle.checked = !!lanDiscoveryEnabled;
    }
    if (lanBroadcastNameRow) {
      lanBroadcastNameRow.setAttribute("data-hidden", lanDiscoveryEnabled ? "0" : "1");
    }
    if (lanBroadcastNameInput && document.activeElement !== lanBroadcastNameInput) {
      lanBroadcastNameInput.value = lanBroadcastName;
    }
    if (bottomClipboardToggle) {
      bottomClipboardToggle.checked = !!bottomActionClipboardButtonsEnabled;
    }
    if (bottomDockPositionSelect) {
      bottomDockPositionSelect.value = bottomActionDockPosition;
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
      section.querySelector('[data-debug-toggle="bottom-clipboard-buttons"]').addEventListener("change", function (event) {
        bottomActionClipboardButtonsEnabled = !!(event && event.target && event.target.checked);
        setStoredValue("bottom_action_clipboard_buttons_enabled", bottomActionClipboardButtonsEnabled);
        syncBottomActionSplitState();
        updateBottomActionDockVisibility();
        setActivityTask("bottom-clipboard-buttons-setting", {
          title: bottomActionClipboardButtonsEnabled ? "\u5df2\u663e\u793a\u5e95\u90e8\u680f\u526a\u677f\u6309\u94ae" : "\u5df2\u9690\u85cf\u5e95\u90e8\u680f\u526a\u677f\u6309\u94ae",
          detail: bottomActionClipboardButtonsEnabled
            ? "\u9001\u526a\u677f\u548c\u6536\u526a\u677f\u5df2\u56de\u5230\u5e95\u90e8\u5feb\u6377\u680f\u3002"
            : "\u5e95\u90e8\u5feb\u6377\u680f\u4ec5\u4fdd\u7559\u5fae\u4fe1\u3001\u5206\u5c4f\u3001QQ \u548c\u6298\u53e0\u6309\u94ae\u3002",
          kind: "success",
          progress: 100,
          indeterminate: false,
          priority: 70,
          expiresAt: Date.now() + 2600
        });
      });
      section.querySelector('[data-debug-toggle="legacy-upload-fallback"]').addEventListener("change", function (event) {
        var nextValue = !!(event && event.target && event.target.checked);
        applyLegacyUploadFallback(nextValue);
        setActivityTask("legacy-upload-fallback-setting", {
          title: nextValue ? "\u5df2\u56de\u9000\u65e7\u7248\u4e0a\u4f20\u5de5\u5177" : "\u5df2\u6062\u590d\u72ec\u7acb\u5206\u7247\u4e0a\u4f20",
          detail: nextValue
            ? "\u4e0b\u6b21\u9009\u62e9\u6216\u62d6\u653e\u6587\u4ef6\u5c06\u76f4\u63a5\u4f7f\u7528\u65e7 WebSocket \u4e0a\u4f20\u94fe\u8def\uff1b\u5df2\u5728\u8fdb\u884c\u7684\u72ec\u7acb\u4e0a\u4f20\u4e0d\u53d7\u5f71\u54cd\u3002"
            : "\u4e0b\u6b21\u9009\u62e9\u6216\u62d6\u653e\u6587\u4ef6\u5c06\u6062\u590d\u4f7f\u7528\u72ec\u7acb HTTP \u5206\u7247\u4e0a\u4f20\u3002",
          kind: nextValue ? "warning" : "success",
          progress: 100,
          indeterminate: false,
          priority: 78,
          expiresAt: Date.now() + 4200
        });
        renderDebugToolsSection();
      });
      section.querySelector('[data-debug-toggle="right-notification-center"]').addEventListener("change", function (event) {
        notificationCenterEnabled = !!(event && event.target && event.target.checked);
        setStoredValue("notification_center_enabled", notificationCenterEnabled);
        var root = ensureNotificationCenter();
        if (root) root.setAttribute("data-enabled", notificationCenterEnabled ? "1" : "0");
        renderNotificationCenterHistory();
        setActivityTask("right-notification-center-setting", {
          title: notificationCenterEnabled ? "\u5df2\u542f\u7528\u53f3\u4fa7\u901a\u77e5\u680f" : "\u5df2\u5173\u95ed\u53f3\u4fa7\u901a\u77e5\u680f",
          detail: notificationCenterEnabled ? "\u53f3\u4fa7\u7ad6\u6761\u6309\u94ae\u5df2\u6062\u590d\uff0c\u5386\u53f2\u4ecd\u4fdd\u7559\u6700\u8fd1 100 \u6761\u3002" : "\u901a\u77e5\u5386\u53f2\u4ecd\u4f1a\u8bb0\u5f55\uff0c\u4f46\u53f3\u4fa7\u5165\u53e3\u5df2\u9690\u85cf\u3002",
          kind: "success",
          progress: 100,
          indeterminate: false,
          priority: 70,
          expiresAt: Date.now() + 2400
        });
      });
      section.querySelector('[data-debug-toggle="auto-split"]').addEventListener("change", function (event) {
        var nextValue = !!(event && event.target && event.target.checked);
        var target = event.target;
        updateNotificationBridgeState({ auto_split_enabled: nextValue })
          .then(function () {
            setActivityTask("auto-split-setting", {
              title: nextValue ? "\u5df2\u5f00\u542f\u81ea\u52a8\u5206\u5c4f" : "\u5df2\u5173\u95ed\u81ea\u52a8\u5206\u5c4f",
              detail: nextValue
                ? "\u4e0b\u6b21\u4ece PIN \u8fdb\u5165\u65f6\uff0c\u5bbd\u9ad8\u6bd4\u8d85\u8fc7 4:3 \u5de6\u53f3\u5206\u5c4f\uff0c\u4f4e\u4e8e 3:4 \u4e0a\u4e0b\u5206\u5c4f\uff0c\u9608\u503c\u5185\u5168\u90e8\u5168\u5c4f\u3002"
                : "\u4ece PIN \u8fdb\u5165\u540e\u5c06\u4fdd\u7559\u5f53\u524d\u7a97\u53e3\u5e03\u5c40\u3002",
              kind: "success",
              progress: 100,
              indeterminate: false,
              priority: 72,
              expiresAt: Date.now() + 3200
            });
            renderDebugToolsSection();
          })
          .catch(function () {
            target.checked = autoSplitEnabled;
            setActivityTask("auto-split-setting", {
              title: "\u81ea\u52a8\u5206\u5c4f\u8bbe\u7f6e\u5931\u8d25",
              detail: "\u672a\u80fd\u5c06\u8bbe\u7f6e\u5199\u5165 /config \u6301\u4e45\u5316\u72b6\u6001\u3002",
              kind: "error",
              progress: null,
              indeterminate: true,
              priority: 82,
              expiresAt: Date.now() + 3600
            });
          });
      });
      section.querySelector('[data-debug-select="bottom-dock-position"]').addEventListener("change", function (event) {
        bottomActionDockPosition = sanitizeDockPosition(event && event.target && event.target.value);
        setStoredValue("bottom_action_dock_position", bottomActionDockPosition);
        syncBottomActionSplitState();
        updateBottomActionDockVisibility();
        setActivityTask("bottom-dock-position-setting", {
          title: bottomActionDockPosition === "top" ? "\u5feb\u6377 Bar \u5df2\u79fb\u5230\u9876\u90e8" : "\u5feb\u6377 Bar \u5df2\u79fb\u5230\u5e95\u90e8",
          detail: "\u6298\u53e0\u3001\u81ea\u52a8\u6062\u590d\u548c\u5206\u5c4f\u83dc\u5355\u89c4\u5219\u4fdd\u6301\u4e0d\u53d8\u3002",
          kind: "success",
          progress: 100,
          indeterminate: false,
          priority: 70,
          expiresAt: Date.now() + 2400
        });
      });
      section.querySelector('[data-debug-toggle="adaptive-sleep"]').addEventListener("change", function (event) {
        var nextValue = !!(event && event.target && event.target.checked);
        var target = event.target;
        adaptiveSleepEnabled = nextValue;
        lastFrontendInteractionAt = Date.now();
        setStoredValue("adaptive_sleep_enabled", adaptiveSleepEnabled);
        updateNotificationBridgeState({ adaptive_sleep_enabled: nextValue })
          .then(function () {
            postContainerSleepActivity(true);
            scheduleAdaptiveSleepIdleWarning();
            setActivityTask("adaptive-sleep-setting", {
              title: nextValue ? "\u5df2\u5f00\u542f\u81ea\u9002\u5e94\u4f11\u7720" : "\u5df2\u5173\u95ed\u81ea\u9002\u5e94\u4f11\u7720",
              detail: nextValue
                ? "\u8fbe\u5230\u5f85\u673a\u65f6\u95f4\u540e\u4f1a\u5148\u663e\u793a 60 \u79d2\u4f11\u7720\u786e\u8ba4\u906e\u7f69\uff0c\u65e0\u4ea4\u4e92\u518d\u8fdb\u5165\u5bb9\u5668\u4f11\u7720\u3002"
                : "\u5bb9\u5668\u4e0d\u518d\u6839\u636e\u5ba2\u6237\u7aef\u952e\u9f20\u7a7a\u95f2\u8fdb\u5165\u4f11\u7720\u3002",
              kind: "success",
              progress: 100,
              indeterminate: false,
              priority: 72,
              expiresAt: Date.now() + 3600
            });
            renderDebugToolsSection();
          })
          .catch(function () {
            adaptiveSleepEnabled = !nextValue;
            setStoredValue("adaptive_sleep_enabled", adaptiveSleepEnabled);
            scheduleAdaptiveSleepIdleWarning();
            target.checked = adaptiveSleepEnabled;
            setActivityTask("adaptive-sleep-setting", {
              title: "\u81ea\u9002\u5e94\u4f11\u7720\u8bbe\u7f6e\u5931\u8d25",
              detail: "\u672a\u80fd\u66f4\u65b0\u540e\u7aef\u4f11\u7720\u72b6\u6001\uff0c\u8bbe\u7f6e\u5df2\u56de\u9000\u3002",
              kind: "error",
              progress: null,
              indeterminate: true,
              priority: 82,
              expiresAt: Date.now() + 3600
            });
          });
      });
      section.querySelector('[data-debug-select="adaptive-sleep-idle-seconds"]').addEventListener("change", function (event) {
        var target = event && event.target;
        var nextValue = sanitizeAdaptiveSleepIdleSeconds(target && target.value);
        updateNotificationBridgeState({ adaptive_sleep_idle_seconds: nextValue })
          .then(function () {
            adaptiveSleepIdleSeconds = nextValue;
            lastFrontendInteractionAt = Date.now();
            setStoredValue("adaptive_sleep_idle_seconds", adaptiveSleepIdleSeconds);
            postContainerSleepActivity(true);
            scheduleAdaptiveSleepIdleWarning();
            setActivityTask("adaptive-sleep-idle-setting", {
              title: "\u5df2\u66f4\u65b0\u81ea\u9002\u5e94\u4f11\u7720\u5f85\u673a\u65f6\u95f4",
              detail: "\u65e0\u952e\u9f20\u4ea4\u4e92 " + (nextValue === 60 ? "1" : String(nextValue / 60)) + " \u5206\u949f\u540e\u8fdb\u5165 60 \u79d2\u4f11\u7720\u786e\u8ba4\u3002",
              kind: "success",
              progress: 100,
              indeterminate: false,
              priority: 72,
              expiresAt: Date.now() + 3200
            });
            renderDebugToolsSection();
          })
          .catch(function () {
            if (target) target.value = String(adaptiveSleepIdleSeconds);
            setActivityTask("adaptive-sleep-idle-setting", {
              title: "\u5f85\u673a\u65f6\u95f4\u8bbe\u7f6e\u5931\u8d25",
              detail: "\u672a\u80fd\u66f4\u65b0\u540e\u7aef\u7684\u4f11\u7720\u5012\u8ba1\u65f6\u914d\u7f6e\u3002",
              kind: "error",
              progress: null,
              indeterminate: true,
              priority: 82,
              expiresAt: Date.now() + 3600
            });
          });
      });
      section.querySelector('[data-debug-toggle="lan-discovery"]').addEventListener("change", function (event) {
        var target = event && event.target;
        var nextValue = !!(target && target.checked);
        updateNotificationBridgeState({ lan_discovery_enabled: nextValue })
          .then(function () {
            setActivityTask("lan-discovery-setting", {
              title: nextValue ? "\u5df2\u5f00\u542f\u5c40\u57df\u7f51\u5e7f\u64ad" : "\u5df2\u5173\u95ed\u5c40\u57df\u7f51\u5e7f\u64ad",
              detail: nextValue
                ? "\u5df2\u4f7f\u7528\u5e7f\u64ad\u540d " + lanBroadcastName + " \u53d1\u5e03 mDNS \u670d\u52a1\uff0c\u5ba2\u6237\u7aef\u53ef\u5728\u5c40\u57df\u7f51\u5185\u53d1\u73b0\u3002"
                : "\u5c40\u57df\u7f51 mDNS \u670d\u52a1\u5c06\u88ab\u64a4\u9500\uff0c\u516c\u7f51\u8bbf\u95ee\u4e0d\u53d7\u5f71\u54cd\u3002",
              kind: "success",
              progress: 100,
              indeterminate: false,
              priority: 72,
              expiresAt: Date.now() + 3600
            });
            renderDebugToolsSection();
          })
          .catch(function () {
            lanDiscoveryEnabled = !nextValue;
            setStoredValue("lan_discovery_enabled", lanDiscoveryEnabled);
            if (target) target.checked = lanDiscoveryEnabled;
            setActivityTask("lan-discovery-setting", {
              title: "\u5c40\u57df\u7f51\u5e7f\u64ad\u8bbe\u7f6e\u5931\u8d25",
              detail: "\u672a\u80fd\u66f4\u65b0\u540e\u7aef\u5e7f\u64ad\u72b6\u6001\uff0c\u8bbe\u7f6e\u5df2\u56de\u9000\u3002",
              kind: "error",
              progress: null,
              indeterminate: true,
              priority: 82,
              expiresAt: Date.now() + 3600
            });
            renderDebugToolsSection();
          });
      });
      section.querySelector('[data-debug-input="lan-broadcast-name"]').addEventListener("change", function (event) {
        var target = event && event.target;
        var rawValue = String((target && target.value) || "").trim().toUpperCase();
        if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(rawValue)) {
          if (target) target.value = lanBroadcastName;
          setActivityTask("lan-broadcast-name-setting", {
            title: "\u5e7f\u64ad\u540d\u683c\u5f0f\u4e0d\u6b63\u786e",
            detail: "\u8bf7\u4f7f\u7528 1-32 \u4f4d\u5927\u5199\u82f1\u6587\u3001\u6570\u5b57\u3001\u4e0b\u5212\u7ebf\u6216\u8fde\u5b57\u53f7\u3002",
            kind: "warning",
            progress: null,
            indeterminate: true,
            priority: 78,
            expiresAt: Date.now() + 3600
          });
          return;
        }
        if (rawValue === lanBroadcastName) {
          if (target) target.value = lanBroadcastName;
          return;
        }
        updateNotificationBridgeState({ lan_broadcast_name: rawValue })
          .then(function () {
            if (target) target.value = lanBroadcastName;
            setActivityTask("lan-broadcast-name-setting", {
              title: "\u5df2\u66f4\u65b0\u5c40\u57df\u7f51\u5e7f\u64ad\u540d",
              detail: "\u65b0\u5e7f\u64ad\u540d\u4e3a " + lanBroadcastName + "\uff0cmDNS \u670d\u52a1\u5c06\u81ea\u52a8\u91cd\u65b0\u53d1\u5e03\u3002",
              kind: "success",
              progress: 100,
              indeterminate: false,
              priority: 72,
              expiresAt: Date.now() + 3200
            });
          })
          .catch(function () {
            if (target) target.value = lanBroadcastName;
            setActivityTask("lan-broadcast-name-setting", {
              title: "\u5e7f\u64ad\u540d\u66f4\u65b0\u5931\u8d25",
              detail: "\u540e\u7aef\u672a\u63a5\u53d7\u65b0\u7684\u5e7f\u64ad\u540d\u3002",
              kind: "error",
              progress: null,
              indeterminate: true,
              priority: 82,
              expiresAt: Date.now() + 3600
            });
          });
      });
      section.querySelector('[data-debug-input="lan-broadcast-name"]').addEventListener("keydown", function (event) {
        if (event && event.key === "Enter") {
          event.preventDefault();
          event.target.blur();
        }
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
      "#selkies-bottom-action-dock-shell{position:fixed;left:50%;bottom:0px;transform:translateX(-50%);z-index:10025;" +
      "display:flex;flex-direction:column;align-items:center;opacity:0;pointer-events:none;" +
      "transition:opacity .22s ease,transform .22s ease}" +
      "#selkies-bottom-action-dock-shell[data-position='top']{top:0;bottom:auto;flex-direction:column-reverse}" +
      "#selkies-bottom-action-dock-shell[data-visible='1']{opacity:1;pointer-events:auto}" +
      "#selkies-bottom-action-dock-shell[data-collapsed='1']{width:30px;pointer-events:none}" +
      "#selkies-bottom-split-popover{position:absolute;left:50%;bottom:calc(100% + 2px);transform:translateX(-50%) translateY(8px) scale(.96);" +
      "display:flex;flex-direction:column;gap:6px;min-width:164px;padding:8px;" +
      "border:1px solid rgba(51,65,85,.92);border-radius:14px;background:rgba(8,15,28,.92);backdrop-filter:blur(16px);" +
      "box-shadow:0 12px 24px rgba(2,6,23,.28);opacity:0;pointer-events:none;visibility:hidden;" +
      "transition:opacity .18s ease,transform .18s ease,visibility .18s ease}" +
      "#selkies-bottom-action-dock-shell[data-position='top'] #selkies-bottom-split-popover{top:calc(100% + 2px);bottom:auto;transform:translateX(-50%) translateY(-8px) scale(.96)}" +
      "#selkies-bottom-action-dock-shell[data-split-open='1'] #selkies-bottom-split-popover{opacity:1;pointer-events:auto;visibility:visible;transform:translateX(-50%) translateY(0) scale(1)}" +
      "#selkies-bottom-action-dock{display:grid;grid-template-columns:repeat(5,minmax(48px,1fr)) 22px;gap:0;padding:0;height:24px;box-sizing:border-box;overflow:hidden;" +
      "border:1px solid rgba(51,65,85,.92);border-bottom:none;border-radius:10px 10px 0 0;background:rgba(8,15,28,.96);backdrop-filter:blur(16px);" +
      "box-shadow:0 -6px 12px rgba(2,6,23,.12);transform-origin:center bottom;transition:opacity .24s ease,transform .24s ease,filter .24s ease}" +
      "#selkies-bottom-action-dock-shell[data-position='top'] #selkies-bottom-action-dock{border-top:none;border-bottom:1px solid rgba(51,65,85,.92);border-radius:0 0 10px 10px;box-shadow:0 6px 12px rgba(2,6,23,.12);transform-origin:center top}" +
      "#selkies-bottom-action-dock-shell[data-clipboard-buttons='0'] #selkies-bottom-action-dock{grid-template-columns:repeat(3,minmax(48px,1fr)) 22px}" +
      "#selkies-bottom-action-dock-shell[data-collapsed='1'] #selkies-bottom-action-dock{opacity:0;transform:translateY(10px) scale(.94);filter:blur(1px);pointer-events:none}" +
      "#selkies-bottom-action-dock-shell[data-collapsed='1'] #selkies-bottom-split-popover{opacity:0;pointer-events:none;visibility:hidden}" +
      "#selkies-bottom-dock-collapsed-toggle{position:absolute;left:50%;bottom:0;appearance:none;border:1px solid rgba(71,85,105,.92);border-bottom:none;background:#101826;color:#e2e8f0;border-radius:10px 10px 0 0;min-width:30px;height:24px;box-sizing:border-box;padding:0 8px;font-size:12px;font-weight:800;cursor:pointer;box-shadow:0 -6px 12px rgba(2,6,23,.12);opacity:0;transform:translateX(-50%) translateY(8px) scale(.92);pointer-events:none;transition:opacity .24s ease,transform .24s ease,filter .24s ease}" +
      "#selkies-bottom-action-dock-shell[data-position='top'] #selkies-bottom-dock-collapsed-toggle{top:0;bottom:auto;border-top:none;border-bottom:1px solid rgba(71,85,105,.92);border-radius:0 0 10px 10px;box-shadow:0 6px 12px rgba(2,6,23,.12);transform:translateX(-50%) translateY(-8px) scale(.92)}" +
      "#selkies-bottom-action-dock-shell[data-collapsed='1'] #selkies-bottom-dock-collapsed-toggle{opacity:1;transform:translateX(-50%) translateY(0) scale(1);pointer-events:auto}" +
      ".selkies-bottom-dock-btn{appearance:none;border:1px solid rgba(71,85,105,.92);background:#101826;color:#e2e8f0;" +
      "border-radius:0;min-width:48px;height:100%;box-sizing:border-box;padding:0 6px;font-size:10px;font-weight:700;letter-spacing:.01em;" +
      "cursor:pointer;transition:transform .12s ease,filter .12s ease,border-color .12s ease,background .12s ease}" +
      ".selkies-bottom-dock-btn:hover{filter:brightness(1.06)}" +
      ".selkies-bottom-dock-btn:active{transform:translateY(1px)}" +
      ".selkies-bottom-dock-btn[data-tone='send']{background:#0f2f6b;border-color:#2563eb;color:#dbeafe}" +
      ".selkies-bottom-dock-btn[data-tone='receive']{background:#4a183f;border-color:#ec4899;color:#fce7f3}" +
      ".selkies-bottom-dock-btn[data-tone='wechat']{background:#123321;border-color:#16a34a;color:#dcfce7}" +
      ".selkies-bottom-dock-btn[data-tone='qq']{background:#10273d;border-color:#38bdf8;color:#e0f2fe}" +
      ".selkies-bottom-dock-btn[data-tone='split']{background:#151d2b;border-color:#475569;color:#f8fafc;min-width:72px}" +
      ".selkies-bottom-dock-btn[data-tone='collapse']{background:#101826;border-color:#64748b;color:#cbd5e1;min-width:22px;width:22px;padding:0 1px;font-size:10px}" +
      "#selkies-bottom-action-dock .selkies-bottom-dock-btn:first-child{border-top-left-radius:9px}" +
      "#selkies-bottom-action-dock .selkies-bottom-dock-btn:last-child{border-top-right-radius:9px}" +
      "#selkies-bottom-action-dock-shell[data-position='top'] #selkies-bottom-action-dock .selkies-bottom-dock-btn:first-child{border-top-left-radius:0;border-bottom-left-radius:9px}" +
      "#selkies-bottom-action-dock-shell[data-position='top'] #selkies-bottom-action-dock .selkies-bottom-dock-btn:last-child{border-top-right-radius:0;border-bottom-right-radius:9px}" +
      "#selkies-bottom-action-dock-shell[data-clipboard-buttons='0'] [data-dock-action='client-to-remote'],#selkies-bottom-action-dock-shell[data-clipboard-buttons='0'] [data-dock-action='remote-to-client']{display:none}" +
      "#selkies-bottom-action-dock-shell[data-clipboard-buttons='0'] [data-dock-action='wechat-focus']{border-top-left-radius:9px}" +
      ".selkies-bottom-dock-btn[data-active='1']{border-color:#93c5fd;color:#f8fafc}" +
      ".selkies-bottom-dock-btn[data-unread='1']{animation:selkies-unread-pulse .95s ease-in-out infinite}" +
      ".selkies-bottom-split-btn{appearance:none;border:1px solid rgba(71,85,105,.9);background:#101826;color:#e2e8f0;" +
      "border-radius:10px;height:30px;padding:0 8px;font-size:10px;font-weight:700;cursor:pointer;text-align:center;" +
      "transition:transform .12s ease,filter .12s ease,border-color .12s ease,background .12s ease}" +
      ".selkies-bottom-split-btn:hover{filter:brightness(1.08);border-color:#60a5fa}" +
      ".selkies-bottom-split-btn:active{transform:translateY(1px)}" +
      "@keyframes selkies-unread-pulse{0%{box-shadow:0 0 0 0 rgba(248,250,252,.0)}50%{box-shadow:0 0 0 2px rgba(248,250,252,.24),0 0 18px rgba(59,130,246,.24)}100%{box-shadow:0 0 0 0 rgba(248,250,252,.0)}}" +
      "@media (max-width:900px){#selkies-bottom-action-dock{gap:0;padding:0;height:24px}.selkies-bottom-dock-btn{min-width:44px;height:100%;padding:0 5px;font-size:9px}.selkies-bottom-dock-btn[data-tone='split']{min-width:66px}.selkies-bottom-dock-btn[data-tone='collapse']{min-width:20px;width:20px;padding:0 1px}}" +
      "@media (max-width:640px){#selkies-bottom-action-dock-shell{width:min(96vw,392px)}#selkies-bottom-action-dock{width:100%;grid-template-columns:repeat(5,minmax(0,1fr)) 20px}#selkies-bottom-action-dock-shell[data-clipboard-buttons='0'] #selkies-bottom-action-dock{grid-template-columns:repeat(3,minmax(0,1fr)) 20px}.selkies-bottom-dock-btn{min-width:0;padding:0 2px}.selkies-bottom-dock-btn[data-tone='collapse']{padding:0;width:20px}}";
    document.head.appendChild(style);
  }

  function syncBottomActionSplitState() {
    var shell = document.getElementById("selkies-bottom-action-dock-shell");
    if (!shell) return;
    shell.setAttribute("data-split-open", bottomActionSplitOpen ? "1" : "0");
    shell.setAttribute("data-collapsed", bottomActionDockCollapsed ? "1" : "0");
    shell.setAttribute("data-clipboard-buttons", bottomActionClipboardButtonsEnabled ? "1" : "0");
    shell.setAttribute("data-position", bottomActionDockPosition);
    var splitButton = shell.querySelector('[data-dock-action="split-toggle"]');
    if (splitButton) {
      splitButton.setAttribute("data-active", bottomActionSplitOpen ? "1" : "0");
    }
    var collapseButton = shell.querySelector('[data-dock-action="dock-collapse"]');
    if (collapseButton) {
      collapseButton.textContent = bottomActionDockPosition === "top" ? "\u25b3" : "\u25bd";
    }
    var collapsedToggle = shell.querySelector("#selkies-bottom-dock-collapsed-toggle");
    if (collapsedToggle) {
      collapsedToggle.textContent = bottomActionDockPosition === "top" ? "\u25bd" : "\u25b3";
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
      handleRemotePasteShortcut();
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
      if (autoSplitEnabled) {
        var pageSize = getCurrentPageSize();
        var layout = selectAutoSplitLayout(pageSize.width, pageSize.height);
        setBottomActionSplitOpen(false);
        runBottomDockRemoteCommand(
          "python3 /scripts/window_tiler.py split --mode " + layout.mode + " --active-side " + layout.activeSide,
          layout.title,
          "\u5df2\u6839\u636e\u5f53\u524d\u9875\u9762 " +
            Math.round(pageSize.width) +
            "\u00d7" +
            Math.round(pageSize.height) +
            " \u7684\u5bbd\u9ad8\u6bd4\u76f4\u63a5\u5e94\u7528\u7a97\u53e3\u5e03\u5c40\u3002"
        );
        return;
      }
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
      '<button type="button" class="selkies-bottom-dock-btn" data-tone="send" data-dock-action="client-to-remote">\u7c98\u8d34</button>' +
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
    startLocalLinkHistoryMount();
    renderDebugToolsSection();
    dynamicLatencyMountTimer = window.setInterval(renderDynamicLatencySection, 6000);
    window.setInterval(renderDebugToolsSection, 6000);
  }

  function bindDynamicLatencyMode() {
    startDynamicLatencyMount();
    syncSidebarToggleLowLatencyState();
    dynamicLatencyUntil = Date.now() + getDynamicLatencyConfig().holdMs;
    if (!sidebarToggleIndicatorTimer) {
      sidebarToggleIndicatorTimer = window.setInterval(syncSidebarToggleLowLatencyState, 1000);
    }
    if (!dynamicLatencyTimer) {
      dynamicLatencyTimer = window.setInterval(function () {
        var config = getDynamicLatencyConfig();
        if (!config.enabled) {
          restoreDynamicLatency();
          return;
        }
        if (Date.now() < dynamicLatencySuppressedUntil) {
          restoreDynamicLatency();
          return;
        }
        if (Date.now() < dynamicLatencyUntil) return;
        if (isRemoteAudioPlaying()) {
          dynamicLatencyUntil = Date.now() + config.holdMs;
          if (dynamicLatencyApplied) {
            restoreDynamicLatency();
          }
          return;
        }
        if (dynamicLatencyApplied) return;
        activateDynamicLatency("inactive");
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
      markDynamicLatencyInteractive(phase);
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
    return withClientClipboardReadPermission(async function () {
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
    });
  }

  function forceClipboardRemoteToClient() {
    noteUiInteraction();
    resetClientClipboardRuntime();
    startRemoteClipboardPull(
      "force-remote",
      "\u6b63\u5728\u6536\u53d6\u8fdc\u7aef\u526a\u8d34\u677f",
      "\u5c06\u4ee5 Selkies \u4f1a\u8bdd\u4e2d\u7684\u526a\u8d34\u677f\u5185\u5bb9\u8986\u76d6\u5f53\u524d\u5ba2\u6237\u7aef\u526a\u8d34\u677f\u3002"
    );
  }

  function getModifierGestureBucket(event) {
    var key = String((event && event.key) || "");
    var code = String((event && event.code) || "");
    if (key === "Control" || key === "Meta" || code === "ControlLeft" || code === "ControlRight" || code === "MetaLeft" || code === "MetaRight") return null;
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
    if (bucket === modifierGestureState.remoteToClient) {
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
      if (!candidate || (candidate.closest && candidate.closest("#selkies-notification-center,#selkies-local-link-prompt,#selkies-bottom-action-dock-shell"))) continue;
      if (candidate.id && /^selkies-/.test(String(candidate.id))) continue;
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
    var root = document.getElementById("selkies-notification-center") || ensureNotificationCenter();
    var host = root && root.querySelector(".selkies-notification-center-links");
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
      recordNotificationCenterEvent(
        {
          key: "link|" + eventId + "|" + safeUrl,
          ts: normalizedEvent.ts,
          app: "link",
          title: "\u94fe\u63a5\u8df3\u8f6c\u8bf7\u6c42",
          body: safeUrl,
          source: normalizedEvent.source,
          url: safeUrl
        },
        NOTIFICATION_MERGE_WINDOW_MS
      );
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
      reportClientAwakeState();
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
      if (data.type === "serverSettings" && data.payload) {
        data.payload = sanitizeServerSettingDefinitions(data.payload);
        primeNativeSelkiesForcedDefaults();
      }
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
          if (lastVideoPipelineActive) {
            lastRenderProgressAt = Date.now();
          }
          if (pipelineResetNoticeTimer) {
            window.clearTimeout(pipelineResetNoticeTimer);
            pipelineResetNoticeTimer = null;
          }
          if (lastVideoPipelineActive) {
            suppressDynamicLatency(4000);
            waitingSinceMs = 0;
            noteFrameProgress();
            clearStreamRecoveryNoticeTimer();
            scheduleKeyboardAssistFocus(120);
            if (activityTasks["stream-reconfig"]) {
              completeActivityTask("stream-reconfig", "\u89c6\u9891\u7ba1\u7ebf\u5df2\u6062\u590d\u3002", "success", 1800);
            }
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
        if (Object.prototype.hasOwnProperty.call(data, "audio")) {
          lastAudioPipelineActive = sanitizeBool(data.audio, lastAudioPipelineActive);
          if (!lastAudioPipelineActive) {
            requestServerAudio("pipeline-status-inactive");
          }
          if (isRemoteAudioPlaying()) {
            dynamicLatencyUntil = Date.now() + getDynamicLatencyConfig().holdMs;
            restoreDynamicLatency();
          }
        }
        scheduleBadgeRefresh(0);
        syncStreamActivity();
      }
    });
  }

  function boot() {
    injectBadgeStyle();
    installForcedSelkiesDefaultsGuard();
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
    startPageStallWatchdog();
    startAudioPlaybackWatchdog();
    startRenderStallWatchdog();
    bindActivityWatchers();
    startUploadDiagnostics();
    installManagedClipboardSender();
    if (LEGACY_UPLOAD_ENABLED) installFileUploadReadBackpressure();
    bindFileTransferActivity();
    if (LEGACY_UPLOAD_ENABLED) installFileTransferTransportInterceptor();
    bindClipboardActivity();
    bindClipboardSyncTriggers();
    bindDynamicLatencyMode();
    bindImeFocusRecovery();
    startSessionMonitor();
    startClientAwakeHeartbeat();
    startAdaptiveSleepStatusWatcher();
    startIdleCleanupWatcher();
    startBottomActionDock();
    startNotificationHistoryCenter();
    startBandwidthNoticeTimer();
    startNotificationEventPoller();
    bindSidebarAutoCollapse();
    bindSidebarKeyboardShortcut();
    startLocalLinkEventPoller();
    startRemovedSidebarSectionGuard();
    startNativeSelkiesControlGuard();
    syncStreamActivity();
  }

  function installSecureContextAudioGuard() {
    if (window.__selkiesSecureContextAudioGuardInstalled) return;
    window.__selkiesSecureContextAudioGuardInstalled = true;

    var guardRuntime = window.__SELKIES_RUNTIME__ || {};
    var httpPort = sanitizeInt(guardRuntime.httpPort, 3000, 1, 65535);
    var httpsPort = sanitizeInt(guardRuntime.httpsPort, 3001, 1, 65535);
    var secureBanner = null;

    function audioContextAvailable() {
      return !!window.isSecureContext && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }

    function httpsUrlForCurrent() {
      try {
        var url = new URL(window.location.href);
        if (url.protocol !== "http:") return "";
        url.protocol = "https:";
        if (String(url.port) === String(httpPort)) {
          url.port = String(httpsPort);
        } else if (!url.port) {
          url.port = String(httpsPort);
        }
        return url.href;
      } catch (_err) {
        return "";
      }
    }

    function removeSecureBanner() {
      if (secureBanner && secureBanner.parentNode) {
        secureBanner.parentNode.removeChild(secureBanner);
      }
      secureBanner = null;
    }

    function showSecureBanner(message, targetHref) {
      if (secureBanner) {
        var msgEl = secureBanner.querySelector("[data-selkies-secure-msg]");
        if (msgEl) msgEl.textContent = message;
        return;
      }
      var banner = document.createElement("div");
      banner.setAttribute("data-selkies-secure-banner", "1");
      banner.style.cssText = [
        "position:fixed",
        "top:14px",
        "left:50%",
        "transform:translateX(-50%)",
        "z-index:2147483000",
        "max-width:min(92vw,640px)",
        "padding:12px 16px",
        "border-radius:12px",
        "border:1px solid rgba(251,191,36,.55)",
        "background:rgba(30,24,8,.94)",
        "color:#fde68a",
        "font:13px/1.5 \"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif",
        "box-shadow:0 12px 40px rgba(0,0,0,.45)",
        "display:flex",
        "align-items:center",
        "gap:10px",
        "flex-wrap:wrap",
        "cursor:default"
      ].join(";");
      var text = document.createElement("span");
      text.setAttribute("data-selkies-secure-msg", "1");
      text.textContent = message;
      text.style.flex = "1 1 auto";
      banner.appendChild(text);
      if (targetHref) {
        var link = document.createElement("a");
        link.href = targetHref;
        link.textContent = "改用 HTTPS";
        link.style.cssText = "color:#38bdf8;font-weight:700;text-decoration:underline;white-space:nowrap";
        banner.appendChild(link);
      }
      var close = document.createElement("button");
      close.textContent = "×";
      close.setAttribute("aria-label", "关闭");
      close.style.cssText = "background:none;border:none;color:#f59e0b;font-size:18px;line-height:1;cursor:pointer;padding:0 2px";
      close.addEventListener("click", removeSecureBanner);
      banner.appendChild(close);
      document.body.appendChild(banner);
      secureBanner = banner;
    }

    function showSecureToast(message) {
      var toast = document.createElement("div");
      toast.textContent = message;
      toast.style.cssText = [
        "position:fixed",
        "bottom:26px",
        "left:50%",
        "transform:translateX(-50%)",
        "z-index:2147483001",
        "padding:10px 16px",
        "border-radius:10px",
        "background:rgba(15,23,42,.94)",
        "color:#e2e8f0",
        "border:1px solid rgba(148,163,184,.28)",
        "font:13px/1.5 \"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif",
        "box-shadow:0 10px 32px rgba(0,0,0,.4)"
      ].join(";");
      document.body.appendChild(toast);
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 3500);
    }

    function handleInsecureMicRequest() {
      var target = httpsUrlForCurrent();
      if (target && target !== window.location.href) {
        showSecureToast("麦克风/扬声器需要 HTTPS 安全上下文，正在切换到 HTTPS…");
        setTimeout(function () {
          window.location.replace(target);
        }, 700);
      } else {
        showSecureBanner("当前页面不是安全上下文（HTTPS/localhost），浏览器会阻止麦克风与扬声器。请改用 HTTPS 访问。");
      }
    }

    function maybeShowInsecureBanner() {
      if (audioContextAvailable() || !document.body) return;
      var reason = window.isSecureContext
        ? "当前浏览器未暴露 navigator.mediaDevices，麦克风/扬声器不可用。"
        : "当前通过 HTTP 访问（非安全上下文），浏览器禁止使用麦克风/扬声器。";
      var httpsTarget = httpsUrlForCurrent();
      showSecureBanner("⚠ " + reason, httpsTarget || "");
    }

    window.addEventListener(
      "message",
      function (event) {
        var data = event && event.data;
        if (!data || data.type !== "pipelineControl") return;
        if (data.pipeline !== "microphone" || !data.enabled) return;
        if (audioContextAvailable()) return;
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        handleInsecureMicRequest();
      },
      true
    );

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", maybeShowInsecureBanner, { once: true });
    } else {
      maybeShowInsecureBanner();
    }
  }

  installSecureContextAudioGuard();
  installForcedSelkiesDefaultsGuard();
  primeRuntimeStorageDefaults();
  if (enforcePinOnBrowserReload()) {
    return;
  }
  bindClipboardSyncTriggers();
  bindSidebarKeyboardShortcut();
  if (document.readyState === "loading") {
    installVideoDecoderHealthGuard();
    installSingleSessionWebSocketGuard();
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    installVideoDecoderHealthGuard();
    installSingleSessionWebSocketGuard();
    boot();
  }
})();
