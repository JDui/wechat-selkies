(function () {
  "use strict";

  // Load before the input guard: its window capture listeners consume IME events.
  // This module only positions the existing assist. It never edits text, moves
  // focus, reparents the input, consumes events, or sends remote input packets.
  var ASSIST_ID = "keyboard-input-assist";
  var SURFACE_SELECTOR = "#overlayInput,#stream,#videoCanvas";
  var anchor = null;
  var composingTarget = null;
  var explicitComposition = false;
  var endedTarget = null;
  var settlingTarget = null;
  var framePending = false;
  var resizeObserver = null;
  var observedSurface = null;
  var observedMedia = null;
  var replacementObserver = null;
  var lastTouchAt = -Infinity;
  var touchGesture = null;

  function isAssist(target) {
    return !!target && target.id === ASSIST_ID;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(Math.max(min, max), value));
  }

  function validRect(element) {
    if (!element || element.isConnected === false) return null;
    var rect = element.getBoundingClientRect();
    if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) ||
        rect.width <= 0 || rect.height <= 0) return null;
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }

  function surfaceGeometry(surface) {
    var rect = validRect(surface);
    if (!rect) return null;
    var media = surface;
    var container = surface.closest(".video-container");
    if (surface.id === "overlayInput" && container) {
      var candidates = container.querySelectorAll("#videoCanvas,#stream");
      for (var i = 0; i < candidates.length; i += 1) {
        var mediaRect = validRect(candidates[i]);
        if (mediaRect) {
          media = candidates[i];
          rect = mediaRect;
          break;
        }
      }
    }
    // The video path can have object-fit letterboxing inside a full-size overlay.
    if (media.id === "stream" && media.videoWidth > 0 && media.videoHeight > 0 &&
        window.getComputedStyle(media).objectFit === "contain") {
      var scale = Math.min(rect.width / media.videoWidth, rect.height / media.videoHeight);
      var width = media.videoWidth * scale;
      var height = media.videoHeight * scale;
      rect.left += (rect.width - width) / 2;
      rect.top += (rect.height - height) / 2;
      rect.width = width;
      rect.height = height;
    }
    return { surface: surface, media: media, rect: rect };
  }

  function resolveGeometry() {
    if (anchor) {
      var surface = anchor.surface;
      if (surface.isConnected === false) surface = document.getElementById(anchor.id);
      if (!surface) {
        waitForSurface();
        return null;
      }
      anchor.surface = surface;
      if (replacementObserver) {
        replacementObserver.disconnect();
        replacementObserver = null;
      }
      var geometry = surfaceGeometry(surface);
      if (geometry) return geometry;
      observeGeometry({ surface: surface, media: surface });
      return null;
    }
    var surfaces = document.querySelectorAll(SURFACE_SELECTOR);
    for (var i = 0; i < surfaces.length; i += 1) {
      var fallback = surfaceGeometry(surfaces[i]);
      if (fallback) return fallback;
    }
    return null;
  }

  function waitForSurface() {
    if (!window.MutationObserver || replacementObserver || !document.body) return;
    // Only watch while the selected surface is absent, then disconnect. Video
    // frames and normal sidebar mutations never need a global DOM observer.
    replacementObserver = new window.MutationObserver(function () {
      if (anchor && document.getElementById(anchor.id)) schedulePosition();
    });
    replacementObserver.observe(document.body, { childList: true, subtree: true });
  }

  function observeGeometry(geometry) {
    if (!window.ResizeObserver || !geometry ||
        (observedSurface === geometry.surface && observedMedia === geometry.media)) return;
    if (!resizeObserver) resizeObserver = new window.ResizeObserver(schedulePosition);
    resizeObserver.disconnect();
    observedSurface = geometry.surface;
    observedMedia = geometry.media;
    resizeObserver.observe(observedSurface);
    if (observedMedia !== observedSurface) resizeObserver.observe(observedMedia);
  }

  function updatePosition() {
    var assist = document.getElementById(ASSIST_ID);
    if (!assist || document.hidden) return;
    if (composingTarget && composingTarget !== assist) {
      composingTarget = null;
      explicitComposition = false;
      endedTarget = null;
      settlingTarget = null;
    }
    if (settlingTarget) {
      if (settlingTarget === assist && composingTarget === assist) {
        // After the existing guard runs, an echoed final insertion is empty;
        // fresh preedit without start/keydown remains in the native input.
        // Inspect only emptiness; never retain or change its text.
        if (assist.value.length) endedTarget = null;
        else composingTarget = null;
      }
      settlingTarget = null;
    }
    if (composingTarget) return;
    var geometry = resolveGeometry();
    if (!geometry) return;
    observeGeometry(geometry);
    var rect = geometry.rect;
    var x = rect.left + rect.width * (anchor ? anchor.x : 0.5);
    var y = rect.top + rect.height * (anchor ? anchor.y : 0.5);
    var viewport = window.visualViewport;
    var left = viewport && Number.isFinite(viewport.offsetLeft) ? viewport.offsetLeft : 0;
    var top = viewport && Number.isFinite(viewport.offsetTop) ? viewport.offsetTop : 0;
    var width = viewport && viewport.width > 0 ? viewport.width : window.innerWidth;
    var height = viewport && viewport.height > 0 ? viewport.height : window.innerHeight;
    if (!(width > 0 && height > 0)) return;
    x = clamp(x, left + 2, left + width - 3);
    y = clamp(y, top + 2, top + height - 3);
    // client coordinates and DOM rects are CSS pixels; do not apply stream DPR.
    // Inline important also overrides the legacy fixed (8px, 8px) rule.
    var values = { position: "fixed", left: Math.round(x * 100) / 100 + "px", top: Math.round(y * 100) / 100 + "px" };
    Object.keys(values).forEach(function (property) {
      if (assist.style.getPropertyValue(property) !== values[property] ||
          assist.style.getPropertyPriority(property) !== "important") {
        assist.style.setProperty(property, values[property], "important");
      }
    });
  }

  function schedulePosition() {
    if (framePending) return;
    framePending = true;
    window.requestAnimationFrame(function () {
      framePending = false;
      updatePosition();
    });
  }

  function rememberPosition(event) {
    var touch = event.type === "touchstart" || event.pointerType === "touch";
    if (touch) lastTouchAt = Date.now();
    if (event.pointerType === "touch" && event.isPrimary !== false) touchGesture = null;
    if (touch && (event.isPrimary === false || (event.touches && event.touches.length !== 1))) {
      cancelTouchPosition();
      return;
    }
    // Pointer Events already cover real mouse presses. Do not reinterpret a
    // compatibility mouse event after a relative touch/trackpad gesture.
    if (event.type === "mousedown" && (window.PointerEvent ||
        (event.sourceCapabilities && event.sourceCapabilities.firesTouchEvents) ||
        Date.now() - lastTouchAt < 800)) return;
    var surface = event.target && event.target.closest && event.target.closest(SURFACE_SELECTOR);
    if (!surface || event.isPrimary === false || (typeof event.button === "number" && event.button !== 0)) return;
    var input = window.webrtcInput;
    // Relative input has no trustworthy absolute remote caret coordinates.
    if (document.pointerLockElement || (input && (input.mouseRelative || (touch && input._trackpadMode)))) return;
    var point = event;
    if (event.type === "touchstart") {
      if (!event.touches || event.touches.length !== 1) return;
      point = event.touches[0];
    }
    if (!Number.isFinite(point.clientX) || !Number.isFinite(point.clientY)) return;
    var geometry = surfaceGeometry(surface);
    if (!geometry) return;
    var rect = geometry.rect;
    if (point.clientX < rect.left || point.clientX > rect.left + rect.width ||
        point.clientY < rect.top || point.clientY > rect.top + rect.height) return;
    if (touch && !touchGesture) {
      touchGesture = { previous: anchor, x: point.clientX, y: point.clientY, cancelled: false };
    }
    if (touch && touchGesture.cancelled) return;
    anchor = {
      surface: surface, id: surface.id,
      x: clamp((point.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((point.clientY - rect.top) / rect.height, 0, 1)
    };
    // Run before the existing document listener focuses the assist. While an
    // IME is open, retain this new location and apply it only after it finishes.
    updatePosition();
  }

  function cancelTouchPosition() {
    if (!touchGesture || touchGesture.cancelled) return;
    anchor = touchGesture.previous;
    touchGesture.cancelled = true;
    updatePosition();
  }

  function observeTouchMove(event) {
    if (!touchGesture || touchGesture.cancelled) return;
    var point = event;
    if (event.type === "touchmove") {
      if (!event.touches || event.touches.length !== 1) {
        cancelTouchPosition();
        return;
      }
      point = event.touches[0];
    } else if (event.pointerType !== "touch") return;
    var dx = point.clientX - touchGesture.x;
    var dy = point.clientY - touchGesture.y;
    if (dx * dx + dy * dy > 100) cancelTouchPosition();
  }

  function startComposition(event) {
    if (!isAssist(event.target)) return;
    composingTarget = event.target;
    explicitComposition = true;
    endedTarget = null;
    settlingTarget = null;
  }

  function endComposition(event) {
    if (!isAssist(event.target) || (composingTarget && composingTarget !== event.target)) return;
    composingTarget = null;
    explicitComposition = false;
    endedTarget = event.target;
    settlingTarget = null;
    // Let the input guard finish the commit before applying deferred geometry.
    schedulePosition();
  }

  function observePreedit(event) {
    if (!isAssist(event.target)) return;
    var preedit = event.inputType !== "insertFromComposition" &&
      (event.isComposing || event.inputType === "insertCompositionText");
    // Some IMEs emit a composing beforeinput/input pair after compositionend.
    // Defer ambiguous input until the existing guard has processed it.
    if (preedit && endedTarget !== event.target) {
      if (composingTarget !== event.target) explicitComposition = false;
      composingTarget = event.target;
      endedTarget = null;
    } else if (preedit && event.type === "input" && endedTarget === event.target) {
      // A following soft-keyboard composition can omit both start and keydown.
      // Resolve that ambiguity after the unchanged text guard handles input.
      composingTarget = event.target;
      explicitComposition = false;
      settlingTarget = event.target;
      schedulePosition();
    } else if (event.type === "input" && !preedit && !explicitComposition && composingTarget) {
      composingTarget = null;
      settlingTarget = null;
      schedulePosition();
    }
  }

  ["pointerdown", "mousedown", "touchstart"].forEach(function (type) {
    window.addEventListener(type, rememberPosition, { capture: true, passive: true });
  });
  ["pointermove", "touchmove"].forEach(function (type) {
    window.addEventListener(type, observeTouchMove, { capture: true, passive: true });
  });
  window.addEventListener("pointercancel", function (event) {
    if (event.pointerType === "touch") cancelTouchPosition();
  }, true);
  window.addEventListener("touchcancel", function () {
    cancelTouchPosition();
    touchGesture = null;
  }, { capture: true, passive: true });
  window.addEventListener("touchend", function (event) {
    if (!event.touches || !event.touches.length) touchGesture = null;
  }, { capture: true, passive: true });
  ["compositionstart", "compositionupdate"].forEach(function (type) {
    window.addEventListener(type, startComposition, true);
  });
  window.addEventListener("compositionend", endComposition, true);
  window.addEventListener("beforeinput", observePreedit, true);
  window.addEventListener("input", observePreedit, true);
  window.addEventListener("keydown", function (event) {
    if (isAssist(event.target)) endedTarget = null;
  }, true);
  window.addEventListener("focusout", function (event) {
    if (isAssist(event.target)) endComposition(event);
  }, true);
  window.addEventListener("blur", function () {
    composingTarget = null;
    explicitComposition = false;
    endedTarget = null;
    settlingTarget = null;
    touchGesture = null;
  });
  window.addEventListener("focusin", function (event) {
    if (isAssist(event.target)) updatePosition();
  }, true);
  window.addEventListener("resize", schedulePosition);
  window.addEventListener("scroll", schedulePosition, { capture: true, passive: true });
  document.addEventListener("fullscreenchange", schedulePosition);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", schedulePosition);
    window.visualViewport.addEventListener("scroll", schedulePosition);
  }
})();
