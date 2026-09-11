(function () {
  "use strict";

  var runtime = window.__SELKIES_RUNTIME__ || {};
  var FALLBACK_STORAGE_NAME = "legacy_upload_fallback_enabled";
  var standaloneUploadAvailable = runtime.standaloneUploadEnabled !== false && typeof BroadcastChannel === "function";
  var pendingTransfers = new Map();
  var pendingExpiryTimers = new Map();
  var MAX_PENDING_TRANSFERS = 32;
  var panelRoot = null;
  var panelFrame = null;
  var panelStyleInstalled = false;
  var uploadTaskDiagnosticKeys = new Map();
  var MAX_UPLOAD_TASK_DIAGNOSTICS = 160;

  // Keep this key algorithm in lockstep with selkies-runtime-overrides.js.  A
  // page can have several PIN/session origins in local development, so the
  // origin/path prefix deliberately scopes the persisted switch.
  function fallbackStorageKey() {
    var prefix = window.location.href.split("#")[0].replace(/[^a-zA-Z0-9._-]/g, "_");
    return prefix + "_" + FALLBACK_STORAGE_NAME;
  }

  function legacyFallbackEnabled() {
    try {
      return String(window.localStorage.getItem(fallbackStorageKey()) || "").toLowerCase() === "true";
    } catch (_) {
      return false;
    }
  }

  function setLegacyFallbackEnabled(enabled) {
    var value = !!enabled;
    try { window.localStorage.setItem(fallbackStorageKey(), String(value)); } catch (_) {}
    window.__selkiesLegacyUploadFallbackEnabled = value;
    return value;
  }

  function enqueuePendingTransfer(transfer) {
    // Keep a bounded queue for the short interval before the iframe announces
    // readiness.  Delayed broadcasts below still cover scheduling races after
    // this entry is removed on ready.
    if (pendingTransfers.size >= MAX_PENDING_TRANSFERS) {
      var oldestId = pendingTransfers.keys().next().value;
      pendingTransfers.delete(oldestId);
      var oldestTimer = pendingExpiryTimers.get(oldestId);
      if (oldestTimer) window.clearTimeout(oldestTimer);
      pendingExpiryTimers.delete(oldestId);
    }
    pendingTransfers.set(transfer.transferId, transfer);
    var expiryTimer = window.setTimeout(function () {
      pendingTransfers.delete(transfer.transferId);
      pendingExpiryTimers.delete(transfer.transferId);
    }, 30000);
    pendingExpiryTimers.set(transfer.transferId, expiryTimer);
  }

  function flushPendingTransfers() {
    var queued = Array.from(pendingTransfers.values());
    pendingTransfers.clear();
    queued.forEach(function (transfer) {
      var expiryTimer = pendingExpiryTimers.get(transfer.transferId);
      if (expiryTimer) window.clearTimeout(expiryTimer);
      pendingExpiryTimers.delete(transfer.transferId);
      channel.postMessage(transfer);
    });
  }

  function shouldUseStandaloneUpload() {
    // Read storage for every event rather than caching the value.  The
    // toolbox toggle can change while the page remains open.
    return standaloneUploadAvailable && !legacyFallbackEnabled();
  }

  function uploaderUrl() {
    return new URL("uploader/", document.baseURI).toString();
  }

  function installPanelStyle() {
    if (panelStyleInstalled || !document.head) return;
    var style = document.createElement("style");
    style.id = "selkies-uploader-panel-style";
    style.textContent =
      ".selkies-uploader-panel{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box;background:rgba(2,6,23,.42)}" +
      ".selkies-uploader-panel[hidden]{display:none!important}" +
      ".selkies-uploader-panel-card{display:flex;flex-direction:column;width:min(760px,calc(100vw - 24px));height:min(720px,calc(100vh - 24px));min-height:360px;overflow:hidden;background:#0f172a;border:1px solid rgba(148,163,184,.42);border-radius:16px;box-shadow:0 24px 80px rgba(2,6,23,.58)}" +
      ".selkies-uploader-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:48px;padding:0 14px;background:linear-gradient(180deg,#172554,#0f172a);color:#e2e8f0;font:700 14px/1.2 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}" +
      ".selkies-uploader-panel-close{appearance:none;border:1px solid rgba(148,163,184,.4);border-radius:8px;background:rgba(15,23,42,.7);color:#cbd5e1;width:32px;height:30px;font-size:18px;line-height:1;cursor:pointer}" +
      ".selkies-uploader-panel-close:hover{background:#334155;color:#fff}" +
      ".selkies-uploader-panel-frame{display:block;flex:1;width:100%;min-height:0;border:0;background:#0f172a}" +
      "@media (max-width:600px){.selkies-uploader-panel{padding:0}.selkies-uploader-panel-card{width:100vw;height:100vh;min-height:0;border-radius:0;border-left:0;border-right:0}.selkies-uploader-panel-head{min-height:50px}}";
    document.head.appendChild(style);
    panelStyleInstalled = true;
  }

  function hideUploaderPanel() {
    if (!panelRoot) return;
    panelRoot.hidden = true;
    panelRoot.setAttribute("aria-hidden", "true");
  }

  function ensureUploaderPanel() {
    if (panelRoot && panelFrame && document.documentElement.contains(panelRoot)) return panelRoot;
    if (!document.body) return null;
    installPanelStyle();
    panelRoot = document.createElement("section");
    panelRoot.className = "selkies-uploader-panel";
    panelRoot.id = "selkies-uploader-panel";
    panelRoot.hidden = true;
    panelRoot.setAttribute("aria-hidden", "true");
    panelRoot.setAttribute("role", "dialog");
    panelRoot.setAttribute("aria-label", "文件上传");

    var card = document.createElement("div");
    card.className = "selkies-uploader-panel-card";
    var head = document.createElement("div");
    head.className = "selkies-uploader-panel-head";
    var title = document.createElement("span");
    title.textContent = "文件上传";
    var close = document.createElement("button");
    close.className = "selkies-uploader-panel-close";
    close.type = "button";
    close.setAttribute("aria-label", "关闭上传工具");
    close.textContent = "×";
    close.addEventListener("click", hideUploaderPanel);
    head.appendChild(title);
    head.appendChild(close);
    panelFrame = document.createElement("iframe");
    panelFrame.className = "selkies-uploader-panel-frame";
    panelFrame.title = "文件上传工具";
    panelFrame.src = uploaderUrl();
    panelFrame.setAttribute("allow", "clipboard-read; clipboard-write");
    card.appendChild(head);
    card.appendChild(panelFrame);
    panelRoot.appendChild(card);
    document.body.appendChild(panelRoot);
    return panelRoot;
  }

  function showUploaderPanel() {
    var panel = ensureUploaderPanel();
    if (!panel) {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", showUploaderPanel, { once: true });
      }
      return null;
    }
    panel.hidden = false;
    panel.setAttribute("aria-hidden", "false");
    try { panelFrame.focus(); } catch (_) {}
    return panel;
  }

  // The runtime toolbox uses this entry point.  Hiding the panel never removes
  // its iframe, so its worker and queue continue in the background.
  window.__selkiesOpenUploaderPanel = showUploaderPanel;
  window.__selkiesShowUploaderPanel = showUploaderPanel;
  window.__selkiesHideUploaderPanel = hideUploaderPanel;
  window.__selkiesStandaloneUploadAvailable = standaloneUploadAvailable;
  window.__selkiesIsLegacyUploadFallbackEnabled = legacyFallbackEnabled;
  window.__selkiesLegacyUploadFallbackEnabled = legacyFallbackEnabled();
  window.__selkiesSetLegacyUploadFallback = setLegacyFallbackEnabled;

  // The native sidebar dispatches this event before opening its hidden file
  // input.  Capture it at the window boundary so standalone mode opens the
  // in-page uploader directly; fallback/unavailable mode deliberately leaves
  // the event untouched for Selkies' original handler.
  window.addEventListener("requestFileUpload", function (event) {
    if (!shouldUseStandaloneUpload()) return;
    if (typeof window.__selkiesOpenUploaderPanel !== "function") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.__selkiesOpenUploaderPanel();
  }, true);

  if (!standaloneUploadAvailable) return;
  var channel = new BroadcastChannel("selkies-upload-v1");

  function relayFiles(files) {
    if (!shouldUseStandaloneUpload()) return;
    var copied = Array.from(files || []);
    if (!copied.length) return;
    var transfer = {
      type: "enqueue-files",
      transferId: "transfer-" + Date.now() + "-" + Math.random().toString(16).slice(2),
      files: copied
    };
    enqueuePendingTransfer(transfer);
    showUploaderPanel();
    // The iframe announces uploader-ready as soon as its worker is alive.  A
    // few delayed broadcasts also cover browser scheduling races while the
    // iframe is first constructed; its receiver de-duplicates transferId.
    [0, 250, 700, 1500].forEach(function (delay) {
      window.setTimeout(function () {
        // The file was captured before a fallback toggle.  Let that already
        // accepted transfer finish; only subsequent DOM events are bypassed.
        channel.postMessage(transfer);
      }, delay);
    });
  }

  channel.onmessage = function (event) {
    var message = event.data || {};
    if (message.type === "uploader-ready" && pendingTransfers.size) {
      flushPendingTransfers();
      showUploaderPanel();
      return;
    }
    if (message.type === "upload-diagnostic" && message.diagnostic) {
      if (typeof window.__selkiesRecordUploadDiagnostic === "function") {
        var workerDiagnostic = Object.assign({}, message.diagnostic);
        var workerEvent = String(workerDiagnostic.event || "event").slice(0, 48);
        delete workerDiagnostic.event;
        workerDiagnostic.workerEvent = workerEvent;
        window.__selkiesRecordUploadDiagnostic("upload-worker-" + workerEvent, workerDiagnostic);
      }
      return;
    }
    if (message.type !== "upload-summary" || !message.task) return;
    var summary = message.task;
    var status = summary.status;
    var taskDiagnosticKey = String(summary.localId || "") + "|" + String(status || "") + "|" + String(summary.error || "");
    if (uploadTaskDiagnosticKeys.get(summary.localId) !== taskDiagnosticKey) {
      uploadTaskDiagnosticKeys.set(summary.localId, taskDiagnosticKey);
      if (uploadTaskDiagnosticKeys.size > MAX_UPLOAD_TASK_DIAGNOSTICS) {
        uploadTaskDiagnosticKeys.delete(uploadTaskDiagnosticKeys.keys().next().value);
      }
      if (typeof window.__selkiesRecordUploadDiagnostic === "function") {
        window.__selkiesRecordUploadDiagnostic("upload-task-status", {
          localId: String(summary.localId || "").slice(0, 120),
          fileName: String(summary.fileName || "").slice(0, 180),
          status: String(status || "").slice(0, 48),
          error: String(summary.error || "").slice(0, 240),
          uploadedBytes: Number(summary.uploadedBytes) || 0,
          size: Number(summary.size) || 0
        });
      }
    }
    var mapped = status === "complete" ? "done" : status === "error" ? "error" : "progress";
    window.postMessage({
      type: "fileUploadStatus",
      payload: {
        status: mapped,
        fileName: summary.fileName,
        fileSize: summary.size,
        receivedBytes: summary.uploadedBytes,
        message: summary.error || "",
        transport: "http-sidecar"
      }
    }, window.location.origin);
  };

  function isFileDrag(event) {
    var types = event && event.dataTransfer && event.dataTransfer.types;
    if (!types) return false;
    for (var i = 0; i < types.length; i += 1) {
      if (String(types[i]).toLowerCase() === "files") return true;
    }
    return false;
  }

  // Capture before the Selkies bundle's legacy data-channel handlers.  When
  // fallback is enabled, returning before preventDefault/stopImmediatePropagation
  // deliberately leaves the event untouched for that native path.
  ["dragenter", "dragover"].forEach(function (name) {
    document.addEventListener(name, function (event) {
      if (!shouldUseStandaloneUpload()) return;
      if (!isFileDrag(event)) return;
      event.preventDefault();
      try { event.dataTransfer.dropEffect = "copy"; } catch (_err) {}
    }, true);
  });
  document.addEventListener("drop", function (event) {
    if (!shouldUseStandaloneUpload()) return;
    if (!isFileDrag(event)) return;
    var files = event.dataTransfer && event.dataTransfer.files;
    if (!files || !files.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    relayFiles(files);
  }, true);

  document.addEventListener("change", function (event) {
    if (!shouldUseStandaloneUpload()) return;
    var input = event.target;
    if (!input || input.tagName !== "INPUT" || input.type !== "file" || !input.files || !input.files.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    relayFiles(input.files);
    try { input.value = ""; } catch (_err) {}
  }, true);
}());
