import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import unittest

from tests import test_text_injection as base_fixture


class TextInjectionExtremeTests(unittest.IsolatedAsyncioTestCase):
    """Focused boundary cases using the existing AST-extracted handler fixture."""

    def handler(self, process, wait_for=None, create_subprocess_exec=None, loop=None, sleep=None):
        fixture = base_fixture.TextInjectionTests("runTest")
        return fixture.handler(process, wait_for, create_subprocess_exec, loop, sleep)

    @staticmethod
    def client(wayland=False):
        return SimpleNamespace(is_wayland=wayland)

    async def test_non_commit_co_messages_are_ignored(self):
        process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"", b"")))
        handler, spawn = self.handler(process)

        for message in ("", "co", "co,start,ni", "co,update,你好"):
            with self.subTest(message=message):
                await handler(self.client(), message)

        spawn.assert_not_awaited()

    async def test_empty_and_truncated_commit_do_not_start_injector(self):
        # The browser's flush path does not send empty commits. A missing
        # delimiter is malformed and must not be interpreted as an empty body.
        for message in ("co,end,", "co,end"):
            with self.subTest(message=message):
                process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"", b"")))
                handler, spawn = self.handler(process)
                await handler(self.client(), message)
                spawn.assert_not_awaited()

    async def test_long_unicode_commit_stays_one_exact_process_argument(self):
        text = ("选词🙂𠮷e\u0301👩🏽‍💻\n\t--literal,comma;" * 1024)
        process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"", b"")))
        handler, spawn = self.handler(process)

        await handler(self.client(wayland=True), "co,end," + text)

        args = spawn.call_args.args
        self.assertEqual(args[0], "wtype")
        self.assertEqual(args[-2:], ("--", text))
        process.communicate.assert_awaited_once()

    async def test_subprocess_creation_failure_is_swallowed_without_logging_body(self):
        marker = "private-ime-body-should-not-appear"
        process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"", b"")))
        handler, spawn = self.handler(process)
        spawn.side_effect = OSError("missing injector while handling " + marker)

        with self.assertLogs("text-test", level="WARNING") as captured:
            await handler(self.client(), "co,end," + marker)

        output = "\n".join(captured.output)
        self.assertIn("OSError", output)
        self.assertNotIn(marker, output)
        spawn.assert_awaited_once()
        process.communicate.assert_not_awaited()

    async def test_nonzero_exit_reports_status_without_logging_body(self):
        marker = "private-ime-body-should-not-appear"
        process = SimpleNamespace(returncode=23, communicate=AsyncMock(return_value=(b"", b"")))
        handler, spawn = self.handler(process)

        with self.assertLogs("text-test", level="WARNING") as captured:
            await handler(self.client(), "co,end," + marker)

        output = "\n".join(captured.output)
        self.assertIn("23", output)
        self.assertNotIn(marker, output)
        spawn.assert_awaited_once()
        process.communicate.assert_awaited_once()

    async def test_communication_error_kills_and_reaps_without_logging_body(self):
        marker = "private-ime-body-should-not-appear"
        process = SimpleNamespace(returncode=None)
        process.communicate = AsyncMock(side_effect=[BrokenPipeError(marker), (b"", b"")])
        kill = Mock(side_effect=lambda: setattr(process, "returncode", -9))
        process.kill = kill
        handler, spawn = self.handler(process)

        with self.assertLogs("text-test", level="WARNING") as captured:
            await handler(self.client(), "co,end," + marker)

        output = "\n".join(captured.output)
        self.assertIn("BrokenPipeError", output)
        self.assertNotIn(marker, output)
        spawn.assert_awaited_once()
        kill.assert_called_once()
        self.assertEqual(process.communicate.await_count, 2)

    async def test_timeout_deadline_is_capped_and_child_is_reaped(self):
        deadlines = []
        process = SimpleNamespace(returncode=None, communicate=AsyncMock(return_value=(b"", b"")))
        kill = Mock(side_effect=lambda: setattr(process, "returncode", -9))
        process.kill = kill
        wait_count = 0

        async def timeout_wait(coro, timeout):
            nonlocal wait_count
            wait_count += 1
            deadlines.append(timeout)
            if wait_count == 1:
                return await coro
            coro.close()
            raise TimeoutError()

        handler, spawn = self.handler(process, timeout_wait, loop=SimpleNamespace(time=Mock(return_value=0.0)))
        text = "长" * 10_000

        await handler(self.client(), "co,end," + text)

        self.assertEqual(deadlines, [60.0, 60.0])
        spawn.assert_awaited_once()
        kill.assert_called_once()
        process.communicate.assert_awaited_once()

    async def test_subprocess_start_time_consumes_shared_deadline(self):
        wait_timeouts = []
        fake_loop = SimpleNamespace(time=Mock(side_effect=[0.0, 1.0, 3.0]))
        process = SimpleNamespace(returncode=None, communicate=AsyncMock(return_value=(b"", b"")))
        kill = Mock(side_effect=lambda: setattr(process, "returncode", -9))
        process.kill = kill

        async def observed_wait_for(coro, timeout):
            wait_timeouts.append(timeout)
            return await coro

        handler, spawn = self.handler(process, wait_for=observed_wait_for, loop=fake_loop)
        await handler(self.client(), "co,end,中")

        self.assertEqual(len(wait_timeouts), 1)
        self.assertAlmostEqual(wait_timeouts[0], 1.35)
        spawn.assert_awaited_once()
        kill.assert_called_once()
        process.communicate.assert_awaited_once()

    async def test_spawn_timeout_waits_for_spawn_cancellation_before_next_message(self):
        spawn_started = asyncio.Event()
        spawn_cancelled = asyncio.Event()
        process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"", b"")))
        loop = SimpleNamespace(time=Mock(side_effect=[0.0, 2.13, 5.0, 5.0, 5.0]))
        spawn_count = 0

        async def controlled_spawn(*_args, **_kwargs):
            nonlocal spawn_count
            spawn_count += 1
            if spawn_count > 1:
                self.assertTrue(spawn_cancelled.is_set())
                return process
            spawn_started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                spawn_cancelled.set()
                raise

        handler, _ = self.handler(process, create_subprocess_exec=controlled_spawn, loop=loop)
        with self.assertLogs("text-test", level="WARNING"):
            await handler(self.client(), "co,end,中")
        self.assertTrue(spawn_started.is_set())
        self.assertTrue(spawn_cancelled.is_set())

        await handler(self.client(), "co,end,NEXT")
        self.assertEqual(spawn_count, 2)
        process.communicate.assert_awaited_once()

    async def test_nonzero_run_stops_before_later_text_runs(self):
        first = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"", b"")))
        failed = SimpleNamespace(returncode=17, communicate=AsyncMock(return_value=(b"", b"")))
        unused = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"", b"")))
        spawn = AsyncMock(side_effect=[first, failed, unused])
        handler, _ = self.handler(first, create_subprocess_exec=spawn)

        with self.assertLogs("text-test", level="WARNING") as captured:
            await handler(self.client(), "co,end,a中b")

        self.assertIn("17", "\n".join(captured.output))
        self.assertEqual(spawn.await_count, 2)
        first.communicate.assert_awaited_once()
        failed.communicate.assert_awaited_once()
        unused.communicate.assert_not_awaited()

    async def test_mixed_x11_deadline_reserves_unicode_key_hold(self):
        process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"", b"")))
        deadlines = []
        loop = SimpleNamespace(time=Mock(return_value=0.0))

        async def record_wait_for(coro, timeout):
            deadlines.append(timeout)
            return await coro

        handler, spawn = self.handler(process, wait_for=record_wait_for, loop=loop)

        await handler(self.client(), "co,end,a中b")

        self.assertEqual(spawn.await_count, 3)
        self.assertTrue(all(abs(value - 3.05) < 1e-9 for value in deadlines))

    async def test_cancellation_racing_with_child_exit_still_reaps(self):
        process = SimpleNamespace(returncode=None, communicate=AsyncMock(return_value=(b"", b"")))
        kill_calls = []

        def kill_racing_with_exit():
            kill_calls.append("kill")
            process.returncode = 0
            raise ProcessLookupError("child exited just before kill")

        process.kill = kill_racing_with_exit

        wait_count = 0

        async def cancel_wait(coro, timeout):
            nonlocal wait_count
            wait_count += 1
            if wait_count == 1:
                return await coro
            coro.close()
            raise asyncio.CancelledError()

        handler, spawn = self.handler(process, cancel_wait)

        with self.assertRaises(asyncio.CancelledError):
            await handler(self.client(), "co,end,committed text")

        spawn.assert_awaited_once()
        self.assertEqual(kill_calls, ["kill"])
        process.communicate.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
