# Chinese candidate first-character investigation — 2026-10-25

The reported environment is Windows, Edge, and Doubao IME, confirming a long Chinese candidate with Space or a digit. The missing character is the first Chinese character of the committed candidate.

## Change and evidence

The guard previously ignored every input event while its composition flag was active. A replay that explicitly confirms `你` with a non-composing `insertText` or `insertFromComposition`, followed by `compositionend.data = 好…`, consequently sent only `好…`. A third replay lost an explicitly confirmed prefix when the remaining composition was cancelled.

The guard now remembers only explicit, non-empty, non-composing insertions during that composition. It includes that prefix at composition end **only if the final field value equals the confirmed prefix plus the end data**. If the end data already contains the prefix, it is sent once. A mismatching or stale DOM cannot justify appending preedit. The prefix state is cleared at a new composition, remount, blur, or explicit repair. Committed text continues through the existing queue and `co,end` protocol. The runtime script cache key is `1.74-ime-2`.

This repairs demonstrated event replays. The split sequence has not been captured from the user's actual Windows Edge + Doubao session, so it is not established as the cause of that live symptom.

## Focused verification

- Luna Max's [partial-commit replay](ime-partial-commit.md) initially had 3 failures; all 14 targeted cases pass after the fix, including cancellation, repeated text, authoritative end data, and partial commits under backpressure.
- `node tests/test_ime_delivery.js` and `node tests/test_ime_extreme.js`: existing delivery checks and 43 adversarial checks pass.
- `node tests/test_ime_diagnostics.js`: opt-in diagnostics retain only bounded event metadata, expose a copied snapshot, and stop/clear correctly.
- `node tests/test_ime_native_browser.js`: headless installed Edge, native CDP editing events, and the **shipped Selkies input class** preserve repeated long Chinese candidates and supplementary Unicode for both Space and Digit1. CDP supplies editing operations, not the Windows Doubao IME. The ordinary Chromium event order did not reproduce the loss before the patch either.
- The [backend first-character check](ime-first-character-backend.md) used real subprocesses and fresh Xvfb/X11: first Unicode commit, existing ASCII prefix, held Space, and held digit all passed. This checks xterm, not WeChat/QQ or a Qt text control. No additional CPU matrix was necessary for this frontend change; previous high-load results remain documented separately.
- JavaScript syntax and `git diff --check` pass.

No image build, deployment, publication, or real logged-in WeChat/QQ acceptance was performed for this change.

## Capture the remaining live uncertainty

On a page running this version, opt in from the Edge developer console:

```js
selkiesImeTrace(true)
// Reproduce with an expendable test sentence, then inspect:
selkiesImeTrace()
// Clear and stop:
selkiesImeTrace(false)
```

The last 128 rows contain timestamps, event ordering, element ID, composition flags, and UTF-16 lengths for event data, field value, confirmed prefix, queued text, and accepted sends. They contain no text or typed keys, are disabled by default, remain in page memory, and are not uploaded. A `send-accepted` row confirms only WebSocket acceptance, not insertion in the remote application. This distinguishes a short browser commit from a complete commit that fails later, without relying on packet-loss assumptions.

## External compatibility reference

The firsthand [xterm.js Doubao report](https://github.com/xtermjs/xterm.js/issues/5887) describes input-before-keydown and keyCode 229 in **macOS English mode**. It supports checking unusual event order, but is not evidence for this Windows Chinese candidate sequence. The [Input Events draft](https://w3c.github.io/input-events/) describes composing updates as `insertCompositionText`; ordinary composing updates still remain local in this implementation.
