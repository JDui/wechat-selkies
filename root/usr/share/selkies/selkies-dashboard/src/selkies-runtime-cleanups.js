(function () {
  "use strict";

  var LEGACY_WECHAT_AUDIO_TEST_SELECTOR = '[data-debug-action="wechat-audio-test"]';
  var CLEANUP_STYLE_ID = "selkies-runtime-cleanups-style";

  function ensureCleanupStyle() {
    if (document.getElementById(CLEANUP_STYLE_ID)) return;

    var style = document.createElement("style");
    style.id = CLEANUP_STYLE_ID;
    style.textContent =
      LEGACY_WECHAT_AUDIO_TEST_SELECTOR + "{display:none!important}" +
      "#selkies-bottom-action-dock-shell[data-collapsed='1']{width:max-content!important}" +
      "@media(max-width:640px){#selkies-bottom-action-dock-shell[data-collapsed='1']{width:calc(100vw - 16px)!important;max-width:460px!important}}";
    document.head.appendChild(style);
  }

  function updateLegacyAudioTestHint(container) {
    if (!container || !container.querySelectorAll) return;
    var notes = container.querySelectorAll(".selkies-repair-note");
    for (var i = 0; i < notes.length; i += 1) {
      var text = String(notes[i].textContent || "").trim();
      if (text.indexOf("两种检测按钮") !== -1) {
        notes[i].textContent = "穿透式消息推送检测会在 5 秒倒计时后触发。";
      }
    }
  }

  function removeLegacyWechatAudioTest(root) {
    if (!root) return;

    var buttons = [];
    if (root.nodeType === 1 && root.matches && root.matches(LEGACY_WECHAT_AUDIO_TEST_SELECTOR)) {
      buttons.push(root);
    }
    if (root.querySelectorAll) {
      var descendants = root.querySelectorAll(LEGACY_WECHAT_AUDIO_TEST_SELECTOR);
      for (var i = 0; i < descendants.length; i += 1) {
        buttons.push(descendants[i]);
      }
    }

    for (var index = 0; index < buttons.length; index += 1) {
      var button = buttons[index];
      if (!button || !button.parentElement) continue;
      var container = button.parentElement;
      button.remove();
      updateLegacyAudioTestHint(container);
    }
  }

  function installLegacyWechatAudioCleanup() {
    removeLegacyWechatAudioTest(document);
    if (typeof MutationObserver !== "function" || !document.documentElement) return;

    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i += 1) {
        var addedNodes = mutations[i].addedNodes || [];
        for (var j = 0; j < addedNodes.length; j += 1) {
          removeLegacyWechatAudioTest(addedNodes[j]);
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function start() {
    ensureCleanupStyle();
    installLegacyWechatAudioCleanup();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
