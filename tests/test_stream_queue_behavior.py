import ast
import asyncio
import logging
import time
import unittest
from collections import OrderedDict
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock


SOURCE = Path(__file__).resolve().parents[1] / "root/lsiopy/lib/python3.12/site-packages/selkies/selkies.py"


def queue_server():
    # Execute the real queue methods without requiring X11/native capture in unit tests.
    tree = ast.parse(SOURCE.read_text(encoding="utf-8-sig"))
    original = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "DataStreamingServer")
    names = {"_is_h264_display_state", "_should_preserve_encoded_frame_order", "_is_low_latency_mode_active",
             "_prune_video_queue_for_display", "_get_effective_send_interval_seconds",
             "_recover_video_queue_overflow", "_video_chunk_sender"}
    original.body = [node for node in original.body if getattr(node, "name", "") in names]
    namespace = {"asyncio": asyncio, "time": time, "data_logger": logging.getLogger("queue-test"),
                 "LOW_LATENCY_QUEUE_KEEP_LATEST": 1, "TARGET_FRAMERATE": 30,
                 "SENT_FRAME_TIMESTAMP_HISTORY_SIZE": 1000, "DEFAULT_STREAM_LOAD_SEND_FPS": 18,
                 "websockets": SimpleNamespace(broadcast=lambda *_: None, ConnectionClosed=ConnectionError)}
    exec(compile(ast.Module(body=[original], type_ignores=[]), str(SOURCE), "exec"), namespace)
    server = namespace["DataStreamingServer"]()
    server.app = SimpleNamespace(encoder="x264enc", framerate=30)
    server.video_chunk_queues = {"primary": asyncio.Queue(maxsize=120)}
    server.display_clients = {"primary": {"encoder": "x264enc", "sent_timestamps": OrderedDict()}}
    server.clients = {object()}
    server._bytes_sent_in_interval = 0
    server._reconfigure_lock = asyncio.Lock()
    return server


class StreamQueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_h264_order_preserved_in_active_idle_and_high_load_modes(self):
        server = queue_server()
        queue = server.video_chunk_queues["primary"]
        for key in ("active", "dynamic_low_latency_active", "high_load_active"):
            server.display_clients["primary"] = {"encoder": "x264enc", key: True}
            for frame in (1, 2, 3):
                queue.put_nowait(frame)
            server._prune_video_queue_for_display("primary")
            self.assertEqual([queue.get_nowait() for _ in range(queue.qsize())], [1, 2, 3])

    async def test_jpeg_still_discards_stale_independent_frames(self):
        server = queue_server()
        server.display_clients["primary"]["encoder"] = "jpeg"
        queue = server.video_chunk_queues["primary"]
        for frame in (1, 2, 3):
            queue.put_nowait(frame)
        server._prune_video_queue_for_display("primary", keep_latest=2)
        self.assertEqual(queue.get_nowait(), 3)

    async def test_stale_overflow_cannot_restart_a_replacement_capture(self):
        server = queue_server()
        server._restart_capture_for_display_settings = AsyncMock()
        await server._recover_video_queue_overflow("primary", asyncio.Queue())
        server._restart_capture_for_display_settings.assert_not_awaited()
        await server._recover_video_queue_overflow("primary", server.video_chunk_queues["primary"])
        server._restart_capture_for_display_settings.assert_awaited_once_with("primary")

    async def test_buffered_video_sender_yields_to_input_tasks(self):
        server = queue_server()
        queue = server.video_chunk_queues["primary"]
        for frame in range(100):
            queue.put_nowait({"data": b"frame", "frame_id": frame})
        sender = asyncio.create_task(server._video_chunk_sender("primary"))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertGreater(queue.qsize(), 0, "Video drained its entire backlog before other tasks could run")
        sender.cancel()
        await sender


if __name__ == "__main__":
    unittest.main()
