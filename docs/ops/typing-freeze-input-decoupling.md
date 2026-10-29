# Typing Freeze: Ordered Input Without Blocking Frame ACKs

Updated: 2026-10-29

Update 2026-10-30: The FIFO / ACK behavior below remains in effect. The Unicode
200-ms key-hold path and its 140-ms validation are superseded by
[input-clipboard-environment-hardening.md](input-clipboard-environment-hardening.md).
Unicode commits now transfer whole text through X11 selection, wait for the
target client to request it, and restore the previous clipboard formats.

## Symptom and cause

The streamed picture paused while the user kept typing and caught up when
input stopped. Chinese commits, digits and punctuation were most affected;
plain letters were much less affected.

A CJK `co,end,<text>` commit runs one awaited `xdotool key --clearmodifiers
--delay 200 U<codepoint>` child per code point. The old data-WebSocket receive
loop awaited the entire injection before reading another message. That also
held up `CLIENT_FRAME_ACK` on the same socket. After 4 seconds without an ACK,
the backpressure task declared the client stalled and paused video queue
consumption. Continued typing extended the pause and could overflow the
encoded frame queue.

The correction is to keep receiving frame ACKs while input is injected. The
video stall threshold and encoded frame ordering remain unchanged.

## Ordered worker and nonblocking receipt

Every data connection owns one FIFO and one async input worker. Keyboard,
mouse, composition, clipboard and `RESET_IO_MODULES` messages all use that FIFO.
This preserves both directions of clipboard ordering: Ctrl+C precedes `cr`,
and an earlier paste executes before a later clipboard write replaces it.
Clipboard high-load state brackets execution inside the worker.

The receive loop only calls `put_nowait`; it never waits for queue space.
`SELKIES_INPUT_QUEUE_MAX` (default 256, range 16–4096) is now a warning watermark.
Crossing it preserves ordered input and continues reading ACKs. Adjacent
absolute pointer moves without held buttons or scroll collapse to the latest
position; adjacent relative moves accumulate their deltas. Key events, drag
paths, button transitions and wheel events remain in order.

A hard limit of `max(4096, watermark * 4)` bounds a genuinely stalled input
connection. Reaching it cancels that connection's worker and asynchronously
closes its WebSocket with code 1013, rather than blocking ACK processing or
silently dropping an individual key release. Disconnect cancels queued work,
reaps the in-flight injection and releases keys actually pressed by that
connection. The worker yields between messages; the receive loop yields every
32 messages so a buffered burst cannot monopolize video scheduling.

`SELKIES_INPUT_QUEUE=false` restores serial processing for diagnosis.
`SELKIES_INPUT_QUEUE_PUT_TIMEOUT_S` was removed: a receive-loop wait recreates
the original problem.

## Preserve text while the target is busy

The initial optimization mapped spare X11 keycodes to Unicode characters and
cleared the mapping after 80 ms. An X client looks up the keysym when it handles
the event. Review reproduced complete loss of `中文` when xterm was paused for
140 ms; the existing xdotool path delivered the same text correctly.

That temporary Unicode mapping, its recycle timer and its cancellation cleanup
state were removed. Chinese commits keep the existing 200-ms key-hold path;
ASCII runs keep the existing 12-ms `xdotool type` batching. This preserves the
established injection behavior while the FIFO fixes the video stall. It does
not claim to improve long CJK commit latency.

`SELKIES_XTEST_INPUT` (default true) only accelerates keys the X server already
maps, including Enter, BackSpace and space. Its blocking Xlib sync runs in a
thread, and cancellation waits for that operation before disconnect cleanup,
so an in-flight key cannot be pressed again after it was released. Setting the
flag to false restores the original mapped-key path.

## Targeted verification

```powershell
python -m py_compile root/lsiopy/lib/python3.12/site-packages/selkies/selkies.py `
  root/lsiopy/lib/python3.12/site-packages/selkies/input_handler.py
python -m unittest tests.test_input_queue_decoupling tests.test_xtest_text_injection `
  tests.test_text_injection tests.test_ws_stats_lifecycle
python -X utf8 tests/ime_xtest_container_probe.py --image wechat-selkies:1.75
```

The host tests cover FIFO ordering across clipboard operations, input beyond
the queue watermark with continuous real `CLIENT_FRAME_ACK` handling, pointer
coalescing without losing button/wheel edges, hard overload with a blocked
WebSocket close, disconnect key release, mapped-key fallback, cancellation of
a busy Xlib operation and connection sampling-task cleanup.

The resource-limited container probe copies the current input and WebSocket
sources into an isolated local image and runs the production methods against
real Xvfb/xterm. The WebSocket fixture configures a registered display without
starting capture; it replaces sampling and capture setup, not the receive loop
or input worker. Its 300 composition-preedit messages and 259 pointer messages
exceed the old queue capacity while the committed text is still being injected.

Observed on 2026-10-29 with `wechat-selkies:1.75`, one CPU, 1 GiB, no network:

| Case | Result |
| --- | --- |
| 11-character Chinese commit | Exact text, 2.27 s |
| Mixed ASCII/Chinese and individual digits/punctuation | Exact text |
| Target paused for 140 ms | Both Chinese characters preserved |
| 24-character real commit with an input backlog | 4.99 s injection, 48 ACKs, longest ACK delay 5.9 ms |
| Keyboard mapping after all cases | Unchanged |

## Deployment boundary

These checks validate the current source, native text delivery and continued
frame ACK handling. They do not substitute for a rebuilt image or a logged-in
WeChat/QQ session with the user's real IME. The running NAS image is unchanged;
the vendored Python files require an image rebuild and deployment to take
effect there.
