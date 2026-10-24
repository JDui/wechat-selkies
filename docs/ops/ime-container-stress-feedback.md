# IME Container Stress Test Feedback

Date: 2026-10-25

## Result

The final focused container matrix passed with Unicode sent through the production `on_message` handler as one `co,end,<text>` message per commit. Under X11, the handler now sends each non-ASCII code point with `xdotool key --clearmodifiers --delay 200 UXXXX`; adjacent ASCII runs still use `xdotool type --delay 12`. Wayland remains on its existing single `wtype` invocation. The wire format and acknowledgement protocol did not change.

| Case | Captured result | Elapsed | CPU evidence |
| --- | --- | ---: | --- |
| No-hog mixed Unicode, 128 code points | 128/128; all 128 child processes exited 0; drain sentinel empty | 18.17 s | No hogs; about 10% of one core during capture |
| Loaded mixed Unicode, 128 code points | 128/128; all 128 child processes exited 0; drain sentinel empty | 22.67 s | Both hogs alive; cgroup limit `50000 100000`; 49.9% of one core |
| Loaded 128-code-point commit followed immediately by `中文` | 130/130 in order; all 130 child processes exited 0; drain sentinel empty | 23.51 s | Both hogs alive; 50.1% of one core |
| Loaded ASCII, 128 code points | 128/128; one child exited 0; drain sentinel empty | 4.41 s | Both hogs alive; 50.4% of one core |

The scenario sent Return to capture the completed line and then a second Return as an empty drain sentinel. The second line remained empty, so no delayed key events appeared after the text. The script reported `SUMMARY status=PASS` and removed its temporary container (`CLEANUP_OK`). The isolated container used local image `wechat-selkies:1.73`, no network, a 0.5-CPU limit, 1 GiB memory, and a 64-process limit. Inside it, Python was 3.12.3 and `cpu.max` was `50000 100000`.

## Why the X11 path changed

The earlier `xdotool type` Unicode path returned exit code 0 while dropping or reordering input. Repeated loaded captures included 94/128, 108/128, and 112/128. Splitting Unicode into one `type` child per code point and passing `--delay 75` did not make the production handler reliable; increasing that option did not establish a reliable consumption window. Captures from the internal handler loop included 105/128 and 127/128. A later 25 ms post-run pause also produced both passing and failing runs, including a deadline cutoff before the final code points. Those strategies are not the final implementation.

The local Xvfb probe ran with both CPU hogs alive. The image's `xdotool help key` output included `--delay DELAY - Use DELAY milliseconds between keystrokes`. Two actual window captures passed: `xdotool key --clearmodifiers --delay 200 U4F60`, and `keydown U4F60`, a 100 ms hold, then `keyup U4F60`. Both captured the expected Chinese code point and left an empty drain line. The final handler uses the first form. The help subcommand printed usage and returned 1, while the actual key commands returned 0.

An upstream implementation reference offers a mechanism consistent with the test results: [`xdo.c` in xdotool upstream](https://github.com/jordansissel/xdotool/blob/master/xdo.c#L911-L918) caps the `type` down delay at 50 ms; the `key` command applies half the requested delay to key-down and half to key-up ([`xdo.c`](https://github.com/jordansissel/xdotool/blob/master/xdo.c#L1045-L1050)). The upstream send path synchronizes X requests and sleeps before restoring its temporary key mapping ([`xdo.c`](https://github.com/jordansissel/xdotool/blob/master/xdo.c#L959-L1028), [`xdo.c`](https://github.com/jordansissel/xdotool/blob/master/xdo.c#L1545-L1588)). This is an explanation inferred from upstream source, not proof that the local image contains the same source revision. The local Xvfb captures independently verify the tested behavior. The exact `xdotool version` was not recorded.

## Deadline and cleanup

Each commit has one shared deadline that covers subprocess creation and communication. Unicode X11 commits use `min(60s, 2s + 0.35s × codepoint_count)` to allow for the explicit key hold and process startup; all-ASCII and Wayland commits retain the 30-second cap and 0.15-second-per-codepoint estimate. A 128-code-point Unicode commit therefore receives 46.8 seconds, while longer malformed or compatibility payloads still hit the 60-second global ceiling. This increases the possible input latency for Unicode commits; the measured 128-code-point captures took 18.17–23.51 seconds in this Xvfb setup.

The handler wraps subprocess creation in `asyncio.wait_for` using the remaining shared budget. Timeout or cancellation of communication kills and reaps an acquired process before the handler returns. The Python 3.12 Unix asyncio subprocess implementation closes and waits on its subprocess transport when creation is cancelled; the focused mock suite checks the handler does not proceed to a later message before the spawn cancellation completes.

## Verification commands

```powershell
python -m unittest tests.test_text_injection tests.test_text_injection_extreme
python -m py_compile tests/ime_container_stress.py
python tests/ime_container_stress.py --image wechat-selkies:1.73 --probe-key
python tests/ime_container_stress.py --image wechat-selkies:1.73 --quick
```

The Python unit command ran 17 methods with 0 failures. The final `--quick` container matrix completed in about 70 seconds. It skips the 3000-ASCII compatibility payload, which exceeds the frontend's current 128-code-point chunk size. An earlier pre-change diagnostic showed that such a 3000-character ASCII payload reached the old 30-second cap with partial input; that compatibility case was not rerun after the final Unicode X11 change.

## Scope limits

This verifies the real Linux handler, real subprocesses, Xvfb key injection, and text capture in one xterm. It does not verify a logged-in WeChat/QQ chat box, a deployed container, real browser IME composition, or other X11 applications. The final matrix passed once at each loaded sequence; it is evidence for this bounded image and load, not a guarantee under every host scheduler or application.
