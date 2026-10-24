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

    async def test_unicode_and_option_like_text_are_one_argument(self):
        for wayland in (False, True):
            process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"", b"")))
            handler, spawn = self.handler(process)
            text = "--中文,😀𠮷" * 20
            await handler(SimpleNamespace(is_wayland=wayland), "co,end," + text)
            args_list = [call.args for call in spawn.call_args_list]
            self.assertTrue(args_list)
            if wayland:
                self.assertEqual(len(args_list), 1)
                self.assertEqual(args_list[0][0], "wtype")
                self.assertEqual(args_list[0][-2:], ("--", text))
            else:
                decoded_runs = []
                for args in args_list:
                    self.assertEqual(args[0], "xdotool")
                    if args[1] == "key":
                        self.assertEqual(args[2:5], ("--clearmodifiers", "--delay", "200"))
                        self.assertTrue(args[-1].startswith("U"))
                        decoded_runs.append(chr(int(args[-1][1:], 16)))
                    else:
                        self.assertEqual(args[1], "type")
                        self.assertEqual(args[2:4], ("--delay", "12"))
                        self.assertEqual(args[-2], "--")
                        decoded_runs.append(args[-1])
                self.assertEqual("".join(decoded_runs), text)

    async def test_pure_ascii_keeps_single_low_delay_run(self):
        process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"", b"")))
        handler, spawn = self.handler(process)

        await handler(SimpleNamespace(is_wayland=False), "co,end,--literal,ascii text")

        spawn.assert_awaited_once()
        self.assertEqual(spawn.call_args.args[-1], "--literal,ascii text")
        self.assertEqual(spawn.call_args.args[2:4], ("--delay", "12"))

    async def test_x11_batches_ascii_runs_and_splits_unicode_in_order(self):
        process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"", b"")))
        handler, spawn = self.handler(process)

        await handler(SimpleNamespace(is_wayland=False), "co,end,ab中𠮷cd")

        calls = [call.args for call in spawn.call_args_list]
        self.assertEqual([args[-1] for args in calls], ["ab", "U4E2D", "U20BB7", "cd"])
        self.assertEqual([args[1] for args in calls], ["type", "key", "key", "type"])
        self.assertEqual([args[3] if args[1] == "type" else args[4] for args in calls],
                         ["12", "200", "200", "12"])
        self.assertEqual([args[0] for args in calls], ["xdotool"] * 4)
        self.assertEqual(process.communicate.await_count, 4)

    async def test_timeout_scales_with_commit_length(self):
        deadlines = []

        async def wait(coro, timeout):
            deadlines.append(timeout)
            return await coro

        process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"", b"")))
        handler, _ = self.handler(process, wait)
        await handler(SimpleNamespace(is_wayland=False), "co,end," + "长" * 128)
        self.assertEqual(len(deadlines), 256)  # spawn and communicate are both deadline-bound
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
                    await handler(SimpleNamespace(is_wayland=False), "co,end,文字")
            else:
                await handler(SimpleNamespace(is_wayland=False), "co,end,文字")
            self.assertEqual(calls, ["kill"])
            process.communicate.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
