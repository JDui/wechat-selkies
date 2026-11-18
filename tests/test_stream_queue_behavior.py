import ast
import asyncio
import json
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
             "_recover_video_queue_overflow", "_video_chunk_sender", "_notify_stream_health",
             "_record_frame_ack", "_run_frame_backpressure_logic", "_recover_stalled_video",
             "_force_recover_display", "_stop_capture_for_display", "_restart_capture_for_display_settings",
             "_restart_capture_for_display_settings_locked", "reconfigure_displays",
             "_fallback_av1_capture", "_sync_shared_viewer"}
    original.body = [node for node in original.body if getattr(node, "name", "") in names]
    broadcasts = []
    namespace = {"asyncio": asyncio, "time": time, "json": json, "data_logger": logging.getLogger("queue-test"),
                 "LOW_LATENCY_QUEUE_KEEP_LATEST": 1, "TARGET_FRAMERATE": 30,
                 "MAX_UINT16_FRAME_ID": 65535, "STALLED_CLIENT_TIMEOUT_SECONDS": 4,
                 "STALLED_CLIENT_RECOVERY_SECONDS": 8, "STALLED_CLIENT_RECOVERY_COOLDOWN_SECONDS": 30,
                 "SENT_FRAME_TIMESTAMP_HISTORY_SIZE": 1000, "DEFAULT_STREAM_LOAD_SEND_FPS": 18,
                 "websockets": SimpleNamespace(broadcast=lambda clients, data: broadcasts.append(data), ConnectionClosed=ConnectionError)}
    exec(compile(ast.Module(body=[original], type_ignores=[]), str(SOURCE), "exec"), namespace)
    server = namespace["DataStreamingServer"]()
    server.app = SimpleNamespace(encoder="x264enc", framerate=30)
    server.video_chunk_queues = {"primary": asyncio.Queue(maxsize=120)}
    websocket = object()
    server.display_clients = {"primary": {"encoder": "x264enc", "ws": websocket, "sent_timestamps": OrderedDict()}}
    server.clients = {websocket}
    server.broadcasts = broadcasts
    server.backpressure_check_interval_s = 0.001
    server._bytes_sent_in_interval = 0
    server._reconfigure_lock = asyncio.Lock()
    server.capture_instances = {"primary": {"module": object()}}
    server.client_settings_received = None
    server.allowed_desync_ms = 2000
    server.latency_threshold_for_adjustment_ms = 50
    server._adaptive_sleeping = False
    server._stream_sleep_requested = lambda: False
    return server


class StreamQueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_interframe_order_preserved_in_active_idle_and_high_load_modes(self):
        server = queue_server()
        queue = server.video_chunk_queues["primary"]
        for encoder in ("x264enc", "h265enc", "av1enc"):
            for key in ("active", "dynamic_low_latency_active", "high_load_active"):
                server.display_clients["primary"] = {"encoder": encoder, key: True}
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
        server._restart_capture_for_display_settings_locked = AsyncMock(return_value=None)
        await server._recover_video_queue_overflow("primary", asyncio.Queue())
        server._restart_capture_for_display_settings_locked.assert_not_awaited()
        await server._recover_video_queue_overflow("primary", server.video_chunk_queues["primary"])
        server._restart_capture_for_display_settings_locked.assert_awaited_once_with("primary")

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

    async def test_primary_backpressure_pauses_then_resumes_video_in_order(self):
        for encoder in ("x264enc", "h265enc", "av1enc"):
            with self.subTest(encoder=encoder):
                server = queue_server()
                state = server.display_clients["primary"]
                state.update(encoder=encoder, backpressure_enabled=False)
                queue = server.video_chunk_queues["primary"]
                frames = [b"key-frame", b"reference-frame", b"dependent-frame"]
                for frame_id, data in enumerate(frames, 1):
                    queue.put_nowait({"data": data, "frame_id": frame_id})
                sender = asyncio.create_task(server._video_chunk_sender("primary"))
                try:
                    await asyncio.sleep(0.01)
                    self.assertEqual(server.broadcasts, [])
                    self.assertEqual(queue.qsize(), 3)
                    self.assertEqual(state["sent_timestamps"], {})
                    state["backpressure_enabled"] = True
                    await asyncio.wait_for(queue.join(), timeout=1)
                    self.assertEqual(server.broadcasts, frames)
                    self.assertEqual(state["last_sent_frame_id"], 3)
                    self.assertEqual(server._bytes_sent_in_interval, sum(map(len, frames)))
                finally:
                    sender.cancel()
                    await sender


if __name__ == "__main__":
    unittest.main()
