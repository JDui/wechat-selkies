/*
 * AXIVER remote-compatibility script — IME composition guard ONLY.
 *
 * This is the sole script injected into the remote (untrusted) Selkies page.
 * It contains no visible UI, no settings and no local actions: the entire
 * Shadow DOM "glass island" was removed by design (spec sections 3.8 / 4.4 /
 * P1). It preserves the Chinese/Japanese IME protection the old client
 * provided verbatim, because the Selkies global key handler calls
 * preventDefault() during composition and would otherwise drop candidate
 * text (regression covered by tests/contract_ime_compat.rs).
 *
 * Guards (spec section 7):
 * - top frame only;
 * - http/https pages only (never the local waiting page or error pages);
 * - idempotent: installs at most one capture listener set per window, and
 *   reuses the page's own `__selkiesCompositionGuardInstalled` flag.
 */
(() => {
  if (window.top !== window.self) return;
  if (location.protocol !== "http:" && location.protocol !== "https:") return;
  if (window.__AXIVER_IME_GUARD__) return;
  window.__AXIVER_IME_GUARD__ = true;

  let imeCompositionActive = false;
  let imeCompositionCommittedText = "";
  let imeFinalInputSeen = false;
  let imeCompositionFlushTimer = 0;
  let imeGuardObserver = null;

  // Verbatim port of the legacy client's installImeCompositionGuard
  // (injected.js @ 1c4bfa6, lines 641–698). Do not "improve" the sequencing:
  // the capture-phase stopImmediatePropagation and the deferred
  // finalInputSeen flush are what Microsoft Pinyin needs on WebView2.
  const installImeCompositionGuard = () => {
    const assist = document.getElementById("keyboard-input-assist");
    if (!assist) return false;
    if (assist.__selkiesCompositionGuardInstalled) return true;
    assist.__selkiesCompositionGuardInstalled = true;

    assist.addEventListener(
      "compositionstart",
      () => {
        imeCompositionActive = true;
        imeCompositionCommittedText = "";
        imeFinalInputSeen = false;
      },
      true
    );
    assist.addEventListener(
      "input",
      (event) => {
        if (event.isComposing || imeCompositionActive) {
          event.stopImmediatePropagation();
          return;
        }
        if (imeCompositionCommittedText) {
          // Only suppress the fallback when Selkies can actually read the
          // committed value. Some WebView2 IMEs emit a final input event while
          // leaving the hidden assist value empty.
          imeFinalInputSeen = Boolean(assist.value);
        }
      },
      true
    );
    assist.addEventListener(
      "compositionend",
      (event) => {
        imeCompositionActive = false;
        imeCompositionCommittedText = String(event.data || "");
        imeFinalInputSeen = false;
        clearTimeout(imeCompositionFlushTimer);
        imeCompositionFlushTimer = window.setTimeout(() => {
          imeCompositionFlushTimer = 0;
          const committedText = imeCompositionCommittedText;
          const finalInputSeen = imeFinalInputSeen;
          imeCompositionCommittedText = "";
          imeFinalInputSeen = false;
          if (finalInputSeen) return;
          // Microsoft Pinyin can expose the selected candidate only through
          // compositionend.data while the hidden input value is already empty.
          const value = String(assist.value || committedText || "");
          const input = window.webrtcInput;
          if (!value || !input || typeof input._typeString !== "function") return;
          input._typeString(value);
          assist.value = "";
        }, 0);
      },
      true
    );
    // Additive (kept from the rebuild attempt): if the page steals focus in
    // the middle of a composition, commit what we already have instead of
    // silently dropping it. Harmless when compositionend fires normally.
    assist.addEventListener(
      "blur",
      () => {
        if (!imeCompositionActive) return;
        imeCompositionActive = false;
        const committedText = imeCompositionCommittedText;
        imeCompositionCommittedText = "";
        if (imeCompositionFlushTimer) {
          clearTimeout(imeCompositionFlushTimer);
          imeCompositionFlushTimer = 0;
        }
        const value = String(assist.value || committedText || "");
        const input = window.webrtcInput;
        if (!value || !input || typeof input._typeString !== "function") return;
        input._typeString(value);
        assist.value = "";
      },
      true
    );
    return true;
  };

  const watchForImeAssist = () => {
    if (installImeCompositionGuard() || imeGuardObserver) return;
    imeGuardObserver = new MutationObserver(() => {
      if (!installImeCompositionGuard()) return;
      imeGuardObserver.disconnect();
      imeGuardObserver = null;
    });
    imeGuardObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watchForImeAssist, { once: true });
  } else {
    watchForImeAssist();
  }
})();
