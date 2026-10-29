"""Mapped XTEST keys avoid children without changing the keyboard mapping."""

import ast
import asyncio
import logging
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

SOURCE = Path(__file__).resolve().parents[1] / "root/lsiopy/lib/python3.12/site-packages/selkies/input_handler.py"
KEY_PRESS, KEY_RELEASE = 2, 3


class FakeDisplay:
    def __init__(self, keycodes=None):
        self.keycodes = keycodes or {}
        self.syncs = 0

    def keysym_to_keycode(self, keysym):
        return self.keycodes.get(keysym, 0)

    def sync(self):
        self.syncs += 1


class XTestInjectionTests(unittest.IsolatedAsyncioTestCase):
    def build(self, display, enabled=True):
        tree = ast.parse(SOURCE.read_text(encoding="utf-8-sig"))
        klass = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                     and node.name == "WebRTCInput")
        klass.name = "Injected"
        klass.body = [node for node in klass.body if getattr(node, "name", "") in
                      {"_xtest_input_enabled", "send_x11_keypress"}]
        module = ast.Module(body=[klass], type_ignores=[])
        process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"", b"")))
        spawn = AsyncMock(return_value=process)
        events = []
        namespace = {
            "X11_LIBS_AVAILABLE": True,
            "xtest": SimpleNamespace(fake_input=lambda _, kind, code: events.append((kind, code))),
            "X": SimpleNamespace(KeyPress=KEY_PRESS, KeyRelease=KEY_RELEASE),
            "logger_webrtc_input": logging.getLogger("xtest-test"),
            "asyncio": asyncio,
            "env_truthy": lambda *_: enabled,
            "subprocess": SimpleNamespace(create_subprocess_exec=spawn, PIPE=-1),
            "X11_KEYSYM_MAP": {0xFF0D: {"xkey_name": "Return"}, 0xFF08: {"xkey_name": "BackSpace"}},
            "UNICODE_KEYSYM_BASE": 0x01000000,
        }
        exec(compile(module, str(SOURCE), "exec"), namespace)
        instance = namespace["Injected"]()
        instance.is_wayland = False
        instance.xdisplay = display
        instance.active_shortcut_modifiers = set()
        instance.SHORTCUT_MODIFIER_XKEY_NAMES = {"Control_L", "Shift_L", "Alt_L", "Super_L"}
        return instance, events, spawn

    async def test_mapped_keys_use_xtest_instead_of_xdotool(self):
        client, events, spawn = self.build(FakeDisplay({0xFF0D: 36, 0xFF08: 22, 0x20: 65}))
        await client.send_x11_keypress(0xFF0D, True)
        await client.send_x11_keypress(0xFF0D, False)
        await client.send_x11_keypress(0xFF08, True)
        await client.send_x11_keypress(0x20, True)
        spawn.assert_not_awaited()
        self.assertEqual(events, [(KEY_PRESS, 36), (KEY_RELEASE, 36),
                                  (KEY_PRESS, 22), (KEY_PRESS, 65)])

    async def test_unmapped_key_and_disabled_flag_keep_xdotool(self):
        for display, enabled in ((FakeDisplay(), True), (FakeDisplay({0xFF0D: 36}), False)):
            client, events, spawn = self.build(display, enabled)
            await client.send_x11_keypress(0xFF0D, True)
            self.assertEqual(events, [])
            spawn.assert_awaited_once()
            self.assertEqual(spawn.call_args.args[:3], ("xdotool", "keydown", "Return"))

    async def test_busy_x_server_yields_and_cancellation_reaps_the_injection(self):
        entered, release = threading.Event(), threading.Event()
        display = FakeDisplay({0xFF0D: 36})
        def sync():
            entered.set()
            release.wait(timeout=2)
        display.sync = sync
        client, events, spawn = self.build(display)
        task = asyncio.create_task(client.send_x11_keypress(0xFF0D, True))
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, .5))
            await asyncio.sleep(.01)
            self.assertFalse(task.done(), "blocking Xlib sync occupied the event loop")
            task.cancel()
            await asyncio.sleep(.01)
            self.assertFalse(task.done(), "disconnect did not reap the pending injection")
        finally:
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(events, [(KEY_PRESS, 36)])
        spawn.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
