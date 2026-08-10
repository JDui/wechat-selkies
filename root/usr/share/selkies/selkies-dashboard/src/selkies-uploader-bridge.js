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

  function isFileDrag(event) {
    var types = event && event.dataTransfer && event.dataTransfer.types;
    if (!types) return false;
    for (var i = 0; i < types.length; i += 1) {
      if (String(types[i]).toLowerCase() === "files") return true;
    }
    return false;
  }

  // Drag-and-drop must go through the standalone uploader, never the legacy
  // data-channel path. The Selkies bundle registers its own drop handlers on
  // the video overlay; those upload the file over the WebRTC data channel and
  // block the asyncio loop with synchronous writes, which the page-stall
  // watchdog later resolves by reloading the page back to the PIN screen.
  // Capture at the document in the capture phase so the legacy handler never
  // sees the event, and preventDefault so the browser cannot navigate to the
  // file (an unload that also lands on the PIN screen).
  ["dragenter", "dragover"].forEach(function (name) {
    document.addEventListener(name, function (event) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      try { event.dataTransfer.dropEffect = "copy"; } catch (_err) {}
    }, true);
  });
  document.addEventListener("drop", function (event) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    var files = event.dataTransfer && event.dataTransfer.files;
    if (files && files.length) relayFiles(files);
  }, true);

  document.addEventListener("change", function (event) {
    var input = event.target;
    if (!input || input.tagName !== "INPUT" || input.type !== "file" || !input.files || !input.files.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    relayFiles(input.files);
    try { input.value = ""; } catch (_err) {}
  }, true);
}());
