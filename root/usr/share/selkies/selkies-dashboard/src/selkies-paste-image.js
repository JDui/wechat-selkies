(function () {
  if (window.__SELKIES_PASTE_IMAGE_INSTALLED__) {
    return;
  }
  window.__SELKIES_PASTE_IMAGE_INSTALLED__ = true;

  const config = window.__SELKIES_PASTE_IMAGE__ || {};
  const enabled = String(config.enabled).toLowerCase() === "true";
  if (!enabled) {
    return;
  }

  const staleToastContainer = document.getElementById("selkies-paste-toast-container");
  if (staleToastContainer) {
    staleToastContainer.remove();
  }

  const maxBytes = Number(config.maxBytes) > 0 ? Number(config.maxBytes) : 20971520;
  const autoPaste = config.autoPaste !== false;
  let binaryClipboardEnabled = null;
  let lastPasteFingerprint = "";
  let lastPasteAt = 0;
  let lastRemotePasteAt = 0;

  function isEditableTarget(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = (target.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return !!target.closest && !!target.closest("[contenteditable='true']");
  }

  function showToast(message, level) {
    const safeLevel = String(level || "info");
    const safeMessage = String(message || "");
    if (safeLevel === "error") {
      console.error("[selkies-paste-image] " + safeMessage);
    } else if (safeLevel === "warn") {
      console.warn("[selkies-paste-image] " + safeMessage);
    } else {
      console.info("[selkies-paste-image] " + safeMessage);
    }
    if (safeLevel === "success" || !safeMessage) return;
    window.postMessage(
      {
        type: "clipboardTransferState",
        status: "error",
        detail: safeMessage
      },
      window.location.origin
    );
  }

  function emitClipboardTransferState(status, detail) {
    window.postMessage(
      {
        type: "clipboardTransferState",
        status: String(status || ""),
        detail: String(detail || "")
      },
      window.location.origin
    );
  }

  function sendRemoteCtrlV() {
    const now = Date.now();
    if (now - lastRemotePasteAt < 450) {
      return true;
    }
    lastRemotePasteAt = now;
    const input = window.webrtcInput;
    if (!input || typeof input._sendKeyEvent !== "function") {
      return false;
    }
    input._sendKeyEvent(65507, "ControlLeft", true);
    input._sendKeyEvent(118, "KeyV", true);
    input._sendKeyEvent(118, "KeyV", false);
    input._sendKeyEvent(65507, "ControlLeft", false);
    return true;
  }

  function rememberPasteFingerprint(fingerprint) {
    lastPasteFingerprint = String(fingerprint || "");
    lastPasteAt = Date.now();
  }

  function isDuplicatePasteFingerprint(fingerprint) {
    if (!fingerprint) return false;
    const now = Date.now();
    return lastPasteFingerprint === fingerprint && now - lastPasteAt < 1500;
  }

  async function readClipboardPayload() {
    if (!window.isSecureContext || !navigator.clipboard) {
      showToast("Clipboard access requires HTTPS and permissions.", "warn");
      return null;
    }

    if (navigator.clipboard.read) {
      try {
        const items = await navigator.clipboard.read();
        if (!items || items.length === 0) return null;
        for (const item of items) {
          const imageType = item.types.find((t) => t.startsWith("image/"));
          if (imageType) {
            const blob = await item.getType(imageType);
            return {
              type: "image",
              mime: imageType,
              size: blob.size,
              buffer: await blob.arrayBuffer()
            };
          }
        }
        if (items[0] && items[0].types.includes("text/plain")) {
          const text = await (await items[0].getType("text/plain")).text();
          if (!text) return null;
          return { type: "text", text };
        }
      } catch (err) {
        showToast("Clipboard read failed. Check browser permissions.", "warn");
        return null;
      }
    }

    if (navigator.clipboard.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) return null;
        return { type: "text", text };
      } catch (err) {
        showToast("Clipboard readText failed. Check browser permissions.", "warn");
        return null;
      }
    }

    showToast("Clipboard API not available in this browser.", "warn");
    return null;
  }

  async function sendClipboardPayload(payload, options) {
    if (!payload) return false;
    const skipDuplicateCheck = !!(options && options.skipDuplicateCheck);
    if (!window.selkiesSendClipboard || typeof window.selkiesSendClipboard !== "function") {
      showToast("Clipboard bridge not ready.", "error");
      return false;
    }

    if (payload.type === "image") {
      const fingerprint = [payload.mime, payload.size, String(payload.buffer.byteLength || payload.size || 0)].join(":");
      if (!skipDuplicateCheck && isDuplicatePasteFingerprint(fingerprint)) {
        return false;
      }
      rememberPasteFingerprint(fingerprint);
      if (binaryClipboardEnabled === false) {
        showToast("Binary clipboard disabled on server.", "error");
        emitClipboardTransferState("error", "Server clipboard bridge disabled.");
        return false;
      }
      if (payload.size > maxBytes) {
        showToast("Image exceeds max size limit.", "warn");
        emitClipboardTransferState("error", "Image exceeds max size limit.");
        return false;
      }
      emitClipboardTransferState("start", "Reading image clipboard and sending to remote session.");
      await window.selkiesSendClipboard(payload.buffer, payload.mime);
      emitClipboardTransferState("end", "Image clipboard sent.");
      showToast("Image sent to remote clipboard.", "success");
      return true;
    }

    if (payload.type === "text") {
      const fingerprint = ["text/plain", String((payload.text || "").length), String(payload.text || "").slice(0, 48)].join(":");
      if (!skipDuplicateCheck && isDuplicatePasteFingerprint(fingerprint)) {
        return false;
      }
      rememberPasteFingerprint(fingerprint);
      await window.selkiesSendClipboard(payload.text, "text/plain");
      return true;
    }

    return false;
  }

  function extractImageFromClipboardData(clipboardData) {
    if (!clipboardData || !clipboardData.items) return null;
    for (const item of clipboardData.items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (!blob) return null;
        return { blob, mime: item.type, size: blob.size };
      }
    }
    return null;
  }

  document.addEventListener(
    "paste",
    (event) => {
      if (isEditableTarget(event.target)) return;
      const imageInfo = extractImageFromClipboardData(event.clipboardData);
      if (!imageInfo) return;
      const fingerprint = [imageInfo.mime, imageInfo.size].join(":");
      if (isDuplicatePasteFingerprint(fingerprint)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      rememberPasteFingerprint(fingerprint);
      event.preventDefault();
      event.stopImmediatePropagation();
      if (imageInfo.size > maxBytes) {
        showToast("Image exceeds max size limit.", "warn");
        emitClipboardTransferState("error", "Image exceeds max size limit.");
        return;
      }
      if (binaryClipboardEnabled === false) {
        showToast("Binary clipboard disabled on server.", "error");
        emitClipboardTransferState("error", "Server clipboard bridge disabled.");
        return;
      }
      if (!window.selkiesSendClipboard || typeof window.selkiesSendClipboard !== "function") {
        showToast("Clipboard bridge not ready.", "error");
        emitClipboardTransferState("error", "Clipboard bridge not ready.");
        return;
      }
      emitClipboardTransferState("start", "Reading image clipboard and sending to remote session.");
      imageInfo.blob.arrayBuffer().then((buffer) => {
        return window.selkiesSendClipboard(buffer, imageInfo.mime);
      }).then(() => {
        emitClipboardTransferState("end", "Image clipboard sent.");
        showToast("Image sent to remote clipboard.", "success");
        if (autoPaste) {
          setTimeout(() => {
            const ok = sendRemoteCtrlV();
            if (!ok) {
              showToast("Remote paste not available. Use Ctrl+V in session.", "warn");
            }
          }, 60);
        }
      }).catch(() => {
        emitClipboardTransferState("error", "Failed to send image clipboard.");
        showToast("Failed to send image clipboard.", "error");
      });
    },
    true
  );


  window.__SELKIES_PASTE_IMAGE_RESET__ = function () {
    lastPasteFingerprint = "";
    lastPasteAt = 0;
    lastRemotePasteAt = 0;
  };

  window.__selkiesReadClientClipboardPayload = readClipboardPayload;
  window.__selkiesSendClipboardPayload = sendClipboardPayload;

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data || {};
    if (data.type === "serverSettings" && data.payload && data.payload.enable_binary_clipboard) {
      const value = data.payload.enable_binary_clipboard.value;
      if (typeof value === "boolean") {
        binaryClipboardEnabled = value;
      }
    }
  });
})();
