import ast
import asyncio
import logging
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock


SOURCE = Path(__file__).resolve().parents[1] / "root/lsiopy/lib/python3.12/site-packages/selkies/input_handler.py"


class TextInjectionTests(unittest.IsolatedAsyncioTestCase):
    def handler(self, process, wait_for=None, create_subprocess_exec=None, loop=None, sleep=None):
        tree = ast.parse(SOURCE.read_text(encoding="utf-8-sig"))
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and
                   any(getattr(m, "name", "") == "on_message" for m in n.body))
        method = next(m for m in cls.body if getattr(m, "name", "") == "on_message")
        spawn = create_subprocess_exec or AsyncMock(return_value=process)
        async def no_sleep(_delay):
            return None

        namespace = {"subprocess": SimpleNamespace(create_subprocess_exec=spawn, PIPE=-1),
                     "asyncio": SimpleNamespace(wait_for=wait_for or asyncio.wait_for,
                                                CancelledError=asyncio.CancelledError,
                                                get_running_loop=lambda: loop or asyncio.get_running_loop(),
                                                sleep=sleep or no_sleep),
                     "logger_webrtc_input": logging.getLogger("text-test")}
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(SOURCE), "exec"), namespace)
        return namespace["on_message"], spawn

    async def test_unicode_and_option_like_text_are_one_commit(self):
        for wayland in (False, True):
            process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"", b"")))
            handler, spawn = self.handler(process)
            text = "--中文,😀𠮷" * 20
            paste = AsyncMock()
            await handler(SimpleNamespace(is_wayland=wayland, _paste_committed_text=paste), "co,end," + text)
            if wayland:
                spawn.assert_awaited_once()
                self.assertEqual(spawn.call_args.args[-2:], ("--", text))
                paste.assert_not_awaited()
            else:
                paste.assert_awaited_once_with(text)
                spawn.assert_not_awaited()  # No temporary Unicode key mapping.

    async def test_pure_ascii_keeps_single_low_delay_run(self):
        process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"", b"")))
        handler, spawn = self.handler(process)

        await handler(SimpleNamespace(is_wayland=False), "co,end,--literal,ascii text")

        spawn.assert_awaited_once()
        self.assertEqual(spawn.call_args.args[-1], "--literal,ascii text")
        self.assertEqual(spawn.call_args.args[2:4], ("--delay", "12"))

    async def test_failed_paste_is_visible_and_never_replayed_as_keys(self):
        process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"", b"")))
        handler, spawn = self.handler(process)
        statuses = []
        client = SimpleNamespace(is_wayland=False, _paste_committed_text=AsyncMock(side_effect=TimeoutError()),
                                 send_clipboard_status=statuses.append)
        await handler(client, "co,end,ab中𠮷cd")
        self.assertEqual(statuses, ["text_commit_failed"])
        spawn.assert_not_awaited()

    async def test_timeout_scales_with_commit_length(self):
        deadlines = []

        async def wait(coro, timeout):
            deadlines.append(timeout)
            return await coro

        process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"", b"")))
        handler, _ = self.handler(process, wait)
        await handler(SimpleNamespace(is_wayland=False), "co,end," + "a" * 128)
        self.assertEqual(len(deadlines), 2)  # spawn and communicate are both deadline-bound
        self.assertGreater(deadlines[0], 6)
        self.assertTrue(all(0 < value <= deadlines[0] for value in deadlines))

    async def test_timeout_and_cancellation_reap_child_before_returning(self):
        for failure in (TimeoutError(), asyncio.CancelledError()):
            calls = []
            process = SimpleNamespace(returncode=None, communicate=AsyncMock(return_value=(b"", b"")))

            def kill():
                calls.append("kill")
                process.returncode = -9

            process.kill = kill

            wait_count = 0

            async def wait(coro, timeout):
                nonlocal wait_count
                wait_count += 1
                if wait_count == 1:
                    return await coro
                coro.close()
                raise failure

            handler, _ = self.handler(process, wait)
            if isinstance(failure, asyncio.CancelledError):
                with self.assertRaises(asyncio.CancelledError):
                    await handler(SimpleNamespace(is_wayland=False, send_clipboard_status=lambda _: None), "co,end,ascii")
            else:
                await handler(SimpleNamespace(is_wayland=False, send_clipboard_status=lambda _: None), "co,end,ascii")
            self.assertEqual(calls, ["kill"])
            process.communicate.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
