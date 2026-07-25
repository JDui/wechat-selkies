(function () {
  "use strict";

  var runtime = window.__SELKIES_RUNTIME__ || {};
  if (runtime.standaloneUploadEnabled === false || typeof BroadcastChannel !== "function") return;
  var channel = new BroadcastChannel("selkies-upload-v1");
  var lastSummary = null;
  var pendingTransfer = null;

  function uploaderUrl() {
    return new URL("uploader/", document.baseURI).toString();
  }

  function openUploader() {
    return window.open(uploaderUrl(), "selkies-uploader", "width=760,height=720,resizable=yes,scrollbars=yes");
  }

  function relayFiles(files) {
    var copied = Array.from(files || []);
    if (!copied.length) return;
    var popup = openUploader();
    var transfer = {
      type: "enqueue-files",
      transferId: "transfer-" + Date.now() + "-" + Math.random().toString(16).slice(2),
      files: copied
    };
    pendingTransfer = transfer;
    [250, 700, 1500].forEach(function (delay) {
      window.setTimeout(function () {
        channel.postMessage(transfer);
        try { if (popup) popup.focus(); } catch (_err) {}
      }, delay);
    });
  }

  function ensureLauncher() {
    if (document.getElementById("selkies-uploader-launcher")) return;
    var button = document.createElement("button");
    button.id = "selkies-uploader-launcher";
    button.type = "button";
    button.textContent = "上传";
    button.title = "打开独立文件上传窗口";
    button.style.cssText = [
      "position:fixed",
      "left:14px",
      "bottom:14px",
      "z-index:2147483000",
      "border:1px solid rgba(125,211,252,.35)",
      "border-radius:999px",
      "padding:8px 13px",
      "color:#e0f2fe",
      "background:rgba(8,22,40,.88)",
      "box-shadow:0 8px 26px rgba(0,0,0,.28)",
      "font:600 12px/1.2 sans-serif",
      "cursor:pointer"
    ].join(";");
    button.addEventListener("click", openUploader);
    document.body.appendChild(button);
  }

  channel.onmessage = function (event) {
    var message = event.data || {};
    if (message.type === "uploader-ready" && pendingTransfer) {
      channel.postMessage(pendingTransfer);
      pendingTransfer = null;
      return;
    }
    if (message.type === "worker-diagnostics") {
      if (typeof window.__selkiesRecordUploadDiagnostic === "function") {
        window.__selkiesRecordUploadDiagnostic("upload-worker-sample", message.metrics || {});
      }
      return;
    }
    if (message.type !== "upload-summary" || !message.task) return;
    lastSummary = message.task;
    var status = lastSummary.status;
    var mapped = status === "complete" ? "done" : status === "error" ? "error" : "progress";
    window.postMessage({
      type: "fileUploadStatus",
      payload: {
        status: mapped,
        fileName: lastSummary.fileName,
        fileSize: lastSummary.size,
        receivedBytes: lastSummary.uploadedBytes,
        message: lastSummary.error || ""
      }
    }, window.location.origin);
    var launcher = document.getElementById("selkies-uploader-launcher");
    if (launcher) {
      var percent = lastSummary.size
        ? Math.floor(lastSummary.uploadedBytes / lastSummary.size * 100)
        : 0;
      launcher.textContent = status === "complete" ? "上传完成" : status === "error" ? "上传失败" : "上传 " + percent + "%";
    }
  };

  document.addEventListener("change", function (event) {
    var input = event.target;
    if (!input || input.tagName !== "INPUT" || input.type !== "file" || !input.files || !input.files.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    relayFiles(input.files);
    try { input.value = ""; } catch (_err) {}
  }, true);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureLauncher, { once: true });
  } else {
    ensureLauncher();
  }
}());
