/*
 * AXIVER remote compatibility: IME only, no UI or local actions.
 * Modern Selkies pages own composition and transport queuing. Older pages
 * use this fallback, following the server guard's synchronous commit model.
 */
(() => {
  if (window.top !== window.self) return;
  if (location.protocol !== "http:" && location.protocol !== "https:") return;
  if (window.__AXIVER_IME_GUARD__) return;
  window.__AXIVER_IME_GUARD__ = true;

  let composing = false;
  let compositionTarget = null;
  let confirmedText = "";
  let commit = null;
  let cleanupTimer = 0;
  const compositionKeys = new Set();
  const pending = [];

  // Registered by the shipped server guard before it starts handling input.
  // Check at event time because this initialization script runs before it.
  const serverOwnsInput = () => typeof window.selkiesRecoverPendingInput === "function";
  const isAssist = event => event.target && event.target.id === "keyboard-input-assist";
  const ownsEvent = event => isAssist(event) && !serverOwnsInput();

  const clearCommit = clearValue => {
    window.clearTimeout(cleanupTimer);
    cleanupTimer = 0;
    if (clearValue && commit) commit.target.value = "";
    commit = null;
  };

  const flush = () => {
    const input = window.webrtcInput;
    while (pending.length) {
      if (!input) return false;
      const value = pending[0];
      try {
        // Use the existing ordered input transport for whole Unicode strings.
        // The bundle's legacy _typeString is absent on some Selkies versions.
        if (typeof input.send === "function") input.send("co,end," + value);
        else if (typeof input._typeString === "function") input._typeString(value);
        else return false;
      } catch (_) { return false; }
      pending.shift();
    }
    return true;
  };

  const queueText = text => {
    const points = Array.from(text || "");
    for (let i = 0; i < points.length; i += 128) {
      pending.push(points.slice(i, i + 128).join(""));
    }
    flush();
  };

  // Window capture must precede the page's keyboard handlers: element capture
  // runs too late to protect candidate Enter from their preventDefault().
  for (const type of ["keydown", "keyup"]) {
    window.addEventListener(type, event => {
      if (!ownsEvent(event)) return;
      const key = event.code || event.key;
      if (composing || event.isComposing || event.keyCode === 229 ||
          (type === "keyup" && compositionKeys.has(key))) {
        if (type === "keydown") compositionKeys.add(key);
        else compositionKeys.delete(key);
        event.stopImmediatePropagation();
        return; // Keep the native candidate-selection default.
      }
      if (type === "keydown") {
        // A new press is distinct even if the previous keyup was lost.
        compositionKeys.delete(key);
        clearCommit(true);
      }
      if (!flush()) {
        event.stopImmediatePropagation();
        if (!event.key || Array.from(event.key).length !== 1 ||
            event.ctrlKey || event.metaKey || event.altKey) event.preventDefault();
      }
    }, true);
  }

  window.addEventListener("compositionstart", event => {
    if (!ownsEvent(event)) return;
    clearCommit(true);
    composing = true;
    compositionTarget = event.target;
    confirmedText = "";
    event.stopImmediatePropagation();
  }, true);

  window.addEventListener("compositionupdate", event => {
    if (ownsEvent(event)) event.stopImmediatePropagation();
  }, true);

  window.addEventListener("compositionend", event => {
    if (!ownsEvent(event)) return;
    const confirmed = compositionTarget === event.target ? confirmedText : "";
    composing = false;
    compositionTarget = null;
    confirmedText = "";
    event.stopImmediatePropagation();
    clearCommit(false);
    // Never defer reading shared state: the next word or Enter may arrive
    // before a zero-delay callback. Empty data means cancellation, not preedit.
    let text = typeof event.data === "string" ? event.data : String(event.target.value || "");
    if (confirmed && event.target.value === confirmed + text) text = confirmed + text;
    const current = { target: event.target, text, cleared: false };
    commit = current;
    queueText(text);
    // Only DOM cleanup is deferred to accommodate the final native input.
    cleanupTimer = window.setTimeout(() => {
      cleanupTimer = 0;
      if (commit === current && !composing) {
        current.target.value = "";
        current.cleared = true;
      }
    }, 0);
  }, true);

  window.addEventListener("input", event => {
    if (!ownsEvent(event)) return;
    event.stopImmediatePropagation();
    if (composing && compositionTarget === event.target) {
      // Reuse the server's partial-commit rule, backed by explicit input data
      // and the final DOM, instead of treating preedit as committed text.
      if (event.isComposing === false &&
          /^(?:insertText|insertFromComposition)$/.test(event.inputType || "") &&
          typeof event.data === "string" && event.data) confirmedText += event.data;
      return;
    }
    if (composing) {
      composing = false;
      compositionTarget = null;
      confirmedText = "";
    }
    let value = String(event.target.value || "");
    const compositionInput = event.isComposing || /Composition/.test(event.inputType || "");
    const legacyEcho = commit && !event.inputType &&
      (event.data === commit.text || value === commit.text || !value);
    if (commit && commit.target === event.target && (compositionInput || legacyEcho ||
        (!commit.cleared && event.inputType === "insertText" && event.data === commit.text))) {
      clearCommit(true);
      flush();
      return;
    }
    if (event.isComposing) return;
    if (commit && commit.target === event.target && !commit.cleared && commit.text &&
        value.startsWith(commit.text)) value = value.slice(commit.text.length);
    clearCommit(false);
    event.target.value = "";
    queueText(value);
  }, true);

  window.addEventListener("blur", event => {
    if (serverOwnsInput() || (event.target !== window && !isAssist(event))) return;
    compositionKeys.clear();
    if (composing && compositionTarget) compositionTarget.value = "";
    composing = false;
    compositionTarget = null;
    confirmedText = "";
    // A later compositionend still commits its data; unfinished preedit does not.
  }, true);
})();
