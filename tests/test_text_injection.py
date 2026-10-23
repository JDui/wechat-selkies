import ast
import asyncio
import logging
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock


SOURCE = Path(__file__).resolve().parents[1] / "root/lsiopy/lib/python3.12/site-packages/selkies/input_handler.py"


class TextInjectionTests(unittest.IsolatedAsyncioTestCase):
    def handler(self, process, wait_for=None):
        tree = ast.parse(SOURCE.read_text(encoding="utf-8-sig"))
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and
                   any(getattr(m, "name", "") == "on_message" for m in n.body))
        method = next(m for m in cls.body if getattr(m, "name", "") == "on_message")
        spawn = AsyncMock(return_value=process)
        namespace = {"subprocess": SimpleNamespace(create_subprocess_exec=spawn, PIPE=-1),
                     "asyncio": SimpleNamespace(wait_for=wait_for or asyncio.wait_for,
                                                CancelledError=asyncio.CancelledError),
                     "logger_webrtc_input": logging.getLogger("text-test")}
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(SOURCE), "exec"), namespace)
        return namespace["on_message"], spawn

    async def test_unicode_and_option_like_text_are_one_argument(self):
        for wayland in (False, True):
            process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"", b"")))
            handler, spawn = self.handler(process)
            text = "--中文,😀𠮷" * 20
            await handler(SimpleNamespace(is_wayland=wayland), "co,end," + text)
            args = spawn.call_args.args
            self.assertEqual(args[-2:], ("--", text))
            self.assertEqual(args[0], "wtype" if wayland else "xdotool")

    async def test_timeout_scales_with_commit_length(self):
        deadlines = []

        async def wait(coro, timeout):
            deadlines.append(timeout)
            return await coro

        process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"", b"")))
        handler, _ = self.handler(process, wait)
        await handler(SimpleNamespace(is_wayland=False), "co,end," + "长" * 128)
        self.assertGreater(deadlines[0], 6)

    async def test_timeout_and_cancellation_reap_child_before_returning(self):
        for failure in (TimeoutError(), asyncio.CancelledError()):
            calls = []
            process = SimpleNamespace(returncode=None, communicate=AsyncMock(return_value=(b"", b"")))

            def kill():
                calls.append("kill")
                process.returncode = -9

            process.kill = kill

            async def wait(coro, timeout):
                coro.close()
                raise failure

            handler, _ = self.handler(process, wait)
            if isinstance(failure, asyncio.CancelledError):
                with self.assertRaises(asyncio.CancelledError):
                    await handler(SimpleNamespace(is_wayland=False), "co,end,文字")
            else:
                await handler(SimpleNamespace(is_wayland=False), "co,end,文字")
            self.assertEqual(calls, ["kill"])
            process.communicate.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
