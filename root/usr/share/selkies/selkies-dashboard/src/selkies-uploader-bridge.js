(function () {
  "use strict";

  var runtime = window.__SELKIES_RUNTIME__ || {};
  if (runtime.standaloneUploadEnabled === false || typeof BroadcastChannel !== "function") return;
  var channel = new BroadcastChannel("selkies-upload-v1");
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
    var summary = message.task;
    var status = summary.status;
    var mapped = status === "complete" ? "done" : status === "error" ? "error" : "progress";
    window.postMessage({
      type: "fileUploadStatus",
      payload: {
        status: mapped,
        fileName: summary.fileName,
        fileSize: summary.size,
        receivedBytes: summary.uploadedBytes,
        message: summary.error || ""
      }
    }, window.location.origin);
  };

  document.addEventListener("change", function (event) {
    var input = event.target;
    if (!input || input.tagName !== "INPUT" || input.type !== "file" || !input.files || !input.files.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    relayFiles(input.files);
    try { input.value = ""; } catch (_err) {}
  }, true);
}());
