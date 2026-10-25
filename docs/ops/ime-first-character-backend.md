# IME First-Character Backend Check

Date: 2026-10-25

## Outcome

No first-character loss was reproduced in the focused X11 backend cases. The first Chinese character arrived after a fresh focus and on the first Unicode injection into a new X server; appending a Chinese commit after existing ASCII text also preserved the complete string. Server-side Space and numeric-key state injections around a commit preserved the complete Unicode text and the deliberately injected key.

| Case | Expected capture | Result | Drain |
| --- | --- | --- | --- |
| Fresh Xvfb, window just focused; first message is `co,end,你好` | `你好` | 2/2 code points | Empty sentinel |
| Existing text then `co,end,中文` | `A中文` | 3/3 code points | Empty sentinel |
| X11 Space key held across `co,end,中文` | ` 中文` | 3/3 code points | Empty sentinel |
| X11 `2` key held across `co,end,中文` | `2中文` | 3/3 code points | Empty sentinel |

Each text commit ran through the AST-extracted production `on_message`, real subprocess creation, and the current X11 `xdotool key --delay 200 UXXXX` Unicode path. A fresh Xvfb server and xterm were used, so the first case did not warm the Unicode mapping before the first commit. The xterm captured the line; Return plus a second empty Return checked for late events. All relevant child processes returned 0.

## Read-only code findings

- `on_message` handles `kd` and `ku` separately, then handles a complete `co,end` body in its own branch. There is no separate “first Chinese character” path within a committed body. X11 commits are expanded into one Unicode `key` child per code point.
- The Selkies data WebSocket receive loop awaits `input_handler.on_message` for each message (`selkies.py:3519-3522`), so a subsequent key message on that WebSocket is not processed concurrently while the current commit is being injected.
- The dashboard assist guard suppresses key events while it considers composition active, and the `compositionend` handler queues `event.data` as committed text. Thus the Space and `2` tests below are server-side X11 key-state injections, not proof that a real browser IME naturally sends those keydown/keyup packets during candidate confirmation.

These results rule out this specific backend/Xvfb reproduction. They do not rule out a browser-side issue where preedit or candidate text follows a different editable-element path before `co,end` is sent.

## Key-state test limits

For the Space and digit cases, the harness used real `xdotool keydown`, called the production `co,end` handler while that X11 key remained down, then used `xdotool keyup`. The captured leading space or digit is the expected result of sending those keys to a focused xterm. These cases check whether a held X11 key interferes with the first Unicode code point; they are controlled fault injections, not natural browser event-sequence claims.

Enter and Backspace were not included: Enter would submit a terminal line during the case, and Backspace changes the existing line content, making the first-character comparison ambiguous. A local read-only dependency probe found no PyQt5, PyQt6, PySide6, PySide2, `qtdemo`, `qtcreator`, `kate`, or `kwrite`, so there was no existing Qt text editor for a second native text-control comparison.

## Verification

```powershell
python -m py_compile tests/ime_container_stress.py tests/test_ime_first_character.py
python -m unittest tests.test_ime_first_character
```

The targeted test ran one unittest method; all four X11 cases passed. It completed in about six seconds. Its temporary container used the already-local `wechat-selkies:1.73` image, no network, a 0.5-CPU cgroup limit, 1 GiB memory, and a 64-process limit; no CPU hogs were started. The test removed its own container (`CLEANUP_OK`).

## Verification boundary

This checks the current server handler, real Linux subprocesses, and Xvfb/X11 events in an xterm. It does not emulate Chromium composition events, an operating-system IME, a Qt application, or a logged-in WeChat/QQ chat box. No production source was changed from this investigation because these cases did not demonstrate a backend defect.
