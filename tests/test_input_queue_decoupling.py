"""Input injection must not occupy the data-WebSocket receive loop.

Injecting text used to be awaited inline in that loop, so a slow injection (an
xdotool spawn per committed CJK character) also delayed CLIENT_FRAME_ACK and
control traffic.  The backpressure task then declared the client stalled and
the video sender paused consumption: the picture froze while the user typed.
These tests drive the real ``ws_handler`` with a blocked input handler and
assert the loop keeps serving other messages.
"""

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from tests.test_ws_stats_lifecycle import stats_server


class ScriptedWebSocket:
    """A data WebSocket whose inbound messages are fed by the test."""

    def __init__(self, port=4500):
        self.remote_address = ("127.0.0.1", port)
        self.request = SimpleNamespace(path="/", headers={})
        self.queue = asyncio.Queue()
        self.send = AsyncMock()
        self.close = AsyncMock()

    def feed(self, *messages):
        for message in messages:
            self.queue.put_nowait(message)

    def hang_up(self):
        self.queue.put_nowait(None)

    async def __aiter__(self):
        while True:
            message = await self.queue.get()
            if message is None:
                return
            yield message


class BlockingInputHandler:
    """Records message order; the first text commit waits on `gate`."""

    def __init__(self):
        self.received = []
        self.entered = asyncio.Event()
        self.gate = asyncio.Event()

    def block_next_commit(self):
        self._block_next = True

    async def on_message(self, msg, display_id=None):
        self.received.append(msg)
        if getattr(self, "_block_next", False) and msg.startswith("co,end,"):
            self._block_next = False
            self.entered.set()
            await self.gate.wait()

    async def reset_io_modules(self):
        self.received.append("RESET_IO_MODULES")


async def _start(server, websocket, awake_calls):
    # ws_handler calls this with two arguments on connect and three on
    # CLIENT_AWAKE_STATE.
    server._set_client_awake_state = (
        lambda *args: awake_calls.append(args[1] if len(args) > 1 else None)
    )
    handler = asyncio.create_task(server.ws_handler(websocket))
    return handler


class InputQueueDecouplingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.websocket = ScriptedWebSocket()
        self.awake_calls = []

    async def _shutdown(self, handler, input_handler):
        input_handler.gate.set()
        self.websocket.hang_up()
        await asyncio.wait_for(handler, timeout=2)

    async def test_slow_injection_does_not_stall_the_receive_loop(self):
        input_handler = BlockingInputHandler()
        input_handler.block_next_commit()
        server, _ = stats_server(input_handler=input_handler)
        handler = await _start(server, self.websocket, self.awake_calls)

        self.websocket.feed("co,end,你好")
        await asyncio.wait_for(input_handler.entered.wait(), timeout=2)
        self.assertEqual(input_handler.received, ["co,end,你好"])

        # The client keeps painting and keeps acknowledging frames while the
        # injection is still running; that traffic must be processed.
        self.websocket.feed("CLIENT_AWAKE_STATE,1")
        await asyncio.wait_for(
            _wait_until(lambda: self.awake_calls == [False, True]), timeout=2
        )
        self.assertEqual(input_handler.received, ["co,end,你好"])
        await self._shutdown(handler, input_handler)

    async def test_input_messages_keep_their_order(self):
        input_handler = BlockingInputHandler()
        input_handler.block_next_commit()
        server, _ = stats_server(input_handler=input_handler)
        handler = await _start(server, self.websocket, self.awake_calls)

        self.websocket.feed("co,end,第一", "co,end,第二", "co,end,第三")
        await asyncio.wait_for(input_handler.entered.wait(), timeout=2)
        # The queue head is still injected; nothing overtook it.
        self.assertEqual(input_handler.received, ["co,end,第一"])

        input_handler.gate.set()
        await asyncio.wait_for(
            _wait_until(lambda: len(input_handler.received) == 3), timeout=2
        )
        self.assertEqual(
            input_handler.received, ["co,end,第一", "co,end,第二", "co,end,第三"]
        )
        await self._shutdown(handler, input_handler)

    async def test_clipboard_and_keys_share_the_same_order(self):
        input_handler = BlockingInputHandler()
        input_handler.block_next_commit()
        server, _ = stats_server(input_handler=input_handler)
        handler = await _start(server, self.websocket, self.awake_calls)

        self.websocket.feed("co,end,你好")
        await asyncio.wait_for(input_handler.entered.wait(), timeout=2)
        messages = [
            "kd,65507", "kd,99", "ku,99", "ku,65507", "cr",
            "cw,Zmlyc3Q=", "kd,65507", "kd,118", "ku,118", "ku,65507",
            "cw,c2Vjb25k", "kd,65507", "kd,118", "ku,118", "ku,65507",
            "RESET_IO_MODULES",
        ]
        self.websocket.feed(*messages, "CLIENT_AWAKE_STATE,1")
        await asyncio.wait_for(
            _wait_until(lambda: self.awake_calls == [False, True]),
            timeout=2,
        )
        self.assertEqual(input_handler.received, ["co,end,你好"])
        input_handler.gate.set()
        await asyncio.wait_for(
            _wait_until(lambda: len(input_handler.received) == len(messages) + 1), 2
        )
        self.assertEqual(input_handler.received, ["co,end,你好", *messages])
        await self._shutdown(handler, input_handler)

    async def test_input_backlog_and_mouse_burst_do_not_block_frame_acks(self):
        input_handler = BlockingInputHandler()
        input_handler.block_next_commit()
        server, _ = stats_server(input_handler=input_handler, display_id="primary")
        server.ws_handler.__func__.__globals__["INPUT_QUEUE_MAX"] = 16
        state = {"ws": self.websocket, "acknowledged_frame_id": -1}
        server.display_clients["primary"] = state
        handler = await _start(server, self.websocket, self.awake_calls)
        self.websocket.feed("co,end,你好")
        await asyncio.wait_for(input_handler.entered.wait(), 2)

        # Exceed the old queue capacity with ordered keys, then flood it with
        # pointer updates. ACKs must still arrive while the commit is blocked.
        keys = [part for _ in range(40) for part in ("kd,97", "ku,97")]
        self.websocket.feed(*keys)
        for frame_id in range(1, 4):
            self.websocket.feed(
                *(f"m,{x},{frame_id},0,0" for x in range(259)),
                f"CLIENT_FRAME_ACK {frame_id}",
            )
            await asyncio.wait_for(
                _wait_until(lambda: state["acknowledged_frame_id"] == frame_id), .5
            )
        self.websocket.close.assert_not_awaited()
        self.assertEqual(input_handler.received, ["co,end,你好"])

        input_handler.gate.set()
        await asyncio.wait_for(
            _wait_until(lambda: len(input_handler.received) == len(keys) + 2), 2
        )
        self.assertEqual(input_handler.received, ["co,end,你好", *keys, "m,258,3,0,0"])
        await self._shutdown(handler, input_handler)

    async def test_pointer_coalescing_preserves_key_button_and_wheel_edges(self):
        input_handler = BlockingInputHandler()
        input_handler.block_next_commit()
        server, _ = stats_server(input_handler=input_handler)
        handler = await _start(server, self.websocket, self.awake_calls)
        self.websocket.feed("co,end,你好")
        await asyncio.wait_for(input_handler.entered.wait(), 2)
        self.websocket.feed(
            "m,1,1,0,0", "m,2,2,0,0", "kd,97", "ku,97",
            "m,3,3,0,0", "m,4,4,1,0", "m,5,5,1,0", "m,5,5,0,1",
            "m2,1,2,0,0", "m2,3,4,0,0", "CLIENT_AWAKE_STATE,1",
        )
        await asyncio.wait_for(_wait_until(lambda: self.awake_calls == [False, True]), 2)
        expected = [
            "co,end,你好", "m,2,2,0,0", "kd,97", "ku,97", "m,3,3,0,0",
            "m,4,4,1,0", "m,5,5,1,0", "m,5,5,0,1", "m2,4,6,0,0",
        ]
        input_handler.gate.set()
        await asyncio.wait_for(_wait_until(lambda: len(input_handler.received) == len(expected)), 2)
        self.assertEqual(input_handler.received, expected)
        await self._shutdown(handler, input_handler)

    async def test_hard_overload_closes_without_waiting_in_the_ack_loop(self):
        input_handler = BlockingInputHandler()
        input_handler.block_next_commit()
        server, _ = stats_server(input_handler=input_handler)
        server.ws_handler.__func__.__globals__["INPUT_QUEUE_HARD_MAX"] = 16
        close_gate = asyncio.Event()
        async def close(**_):
            await close_gate.wait()
        self.websocket.close.side_effect = close
        handler = await _start(server, self.websocket, self.awake_calls)
        self.websocket.feed("co,end,你好")
        await asyncio.wait_for(input_handler.entered.wait(), 2)
        self.websocket.feed(*("co,end,积压" for _ in range(18)), "CLIENT_AWAKE_STATE,1")
        await asyncio.wait_for(_wait_until(lambda: self.awake_calls == [False, True]), .5)
        self.websocket.close.assert_awaited_once_with(
            code=1013, reason="Input queue overloaded; reconnect"
        )
        self.assertEqual(input_handler.received, ["co,end,你好"])
        close_gate.set()
        await self._shutdown(handler, input_handler)

    async def test_disconnect_releases_a_pressed_key_without_replaying_the_queue(self):
        input_handler = BlockingInputHandler()
        input_handler.block_next_commit()
        server, _ = stats_server(input_handler=input_handler)
        handler = await _start(server, self.websocket, self.awake_calls)
        self.websocket.feed("kd,65507", "co,end,你好", "ku,65507", "co,end,不应重放")
        await asyncio.wait_for(input_handler.entered.wait(), 2)
        self.websocket.hang_up()
        await asyncio.wait_for(handler, 2)
        self.assertEqual(input_handler.received, ["kd,65507", "co,end,你好", "ku,65507"])

    async def test_queued_input_is_dropped_when_the_connection_closes(self):
        input_handler = BlockingInputHandler()
        input_handler.block_next_commit()
        server, _ = stats_server(input_handler=input_handler)
        handler = await _start(server, self.websocket, self.awake_calls)

        self.websocket.feed("co,end,甲", "co,end,乙")
        await asyncio.wait_for(input_handler.entered.wait(), timeout=2)
        self.websocket.hang_up()
        await asyncio.wait_for(handler, timeout=2)

        # Replaying keys into the desktop after a disconnect is never wanted.
        input_handler.gate.set()
        await asyncio.sleep(0.05)
        self.assertEqual(input_handler.received, ["co,end,甲"])

    async def test_queue_can_be_disabled_for_rollback(self):
        input_handler = BlockingInputHandler()
        input_handler.block_next_commit()
        server, _ = stats_server(input_handler=input_handler, input_queue_enabled=False)
        handler = await _start(server, self.websocket, self.awake_calls)

        self.websocket.feed("co,end,你好")
        await asyncio.wait_for(input_handler.entered.wait(), timeout=2)
        self.websocket.feed("CLIENT_AWAKE_STATE,1")
        # The kill switch restores the serial behaviour: the connect-time call
        # is all the loop got to process while the injection held it.
        await asyncio.sleep(0.1)
        self.assertEqual(self.awake_calls, [False])
        input_handler.gate.set()
        # ...and the deferred traffic arrives once the injection finishes.
        await asyncio.wait_for(
            _wait_until(lambda: self.awake_calls == [False, True]), timeout=2
        )
        await self._shutdown(handler, input_handler)


async def _wait_until(predicate, interval=0.01):
    while not predicate():
        await asyncio.sleep(interval)


if __name__ == "__main__":
    unittest.main()
