import ast
import asyncio
import json
import logging
import time
import unittest
import urllib.parse
from collections import OrderedDict
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock


SOURCE = Path(__file__).resolve().parents[1] / "root/lsiopy/lib/python3.12/site-packages/selkies/selkies.py"


class ConnectionClosed(Exception):
    pass


class WebSocket:
    def __init__(self, port):
        self.remote_address = ("127.0.0.1", port)
        self.request = SimpleNamespace(path="/", headers={})
        self.receiving = asyncio.Event()
        self.disconnect = asyncio.Event()
        self.send = AsyncMock()
        self.close = AsyncMock()

    async def __aiter__(self):
        self.receiving.set()
        await self.disconnect.wait()
        if False:
            yield None


def stats_server(gpus=True, probe_error=False, input_handler=None, input_queue_enabled=True,
                 display_id=None, environment=None):
    # Exercise the actual connection handler without X11/PulseAudio/native dependencies.
    tree = ast.parse(SOURCE.read_text(encoding="utf-8-sig"))
    original = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "DataStreamingServer")
    original.body = [node for node in original.body if getattr(node, "name", "") == "ws_handler"]
    # ACK tests start with an already registered display; the SETTINGS/capture
    # handshake is outside this connection-lifecycle fixture.
    if display_id is not None:
        for node in ast.walk(original):
            if (isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant)
                    and node.value.value is None
                    and any(isinstance(t, ast.Name) and t.id == "client_display_id"
                            for t in node.targets)):
                node.value.value = display_id
    recorded_tasks = []

    async def monitor(kind, shared_data):
        record = {"kind": kind, "data": shared_data, "task": asyncio.current_task(), "stopped": False}
        recorded_tasks.append(record)
        try:
            await asyncio.Event().wait()
        finally:
            record["stopped"] = True

    def get_gpus():
        if probe_error:
            raise RuntimeError("GPU probe failed")
        return [object()] if gpus else []

    namespace = {
        "asyncio": asyncio, "json": json, "time": time, "urllib": urllib,
        "os": SimpleNamespace(environ=environment or {}), "data_logger": logging.getLogger("stats-test"),
        "logger": logging.getLogger("stats-test"), "client_permissions": {},
        "TARGET_FRAMERATE": 30, "GPU_ID_DEFAULT": 0, "SETTING_DEFINITIONS": [], "IS_WAYLAND": False,
        "PULSEAUDIO_AVAILABLE": False, "upload_dir_path": None,
        "INPUT_QUEUE_ENABLED": input_queue_enabled, "INPUT_QUEUE_MAX": 256,
        "INPUT_QUEUE_HARD_MAX": 4096,
        "GPUtil": SimpleNamespace(getGPUs=get_gpus),
        "websockets": SimpleNamespace(exceptions=SimpleNamespace(
            ConnectionClosed=ConnectionClosed, ConnectionClosedOK=ConnectionClosed,
            ConnectionClosedError=ConnectionClosed)),
        "_collect_system_stats_ws": lambda data: monitor("system", data),
        "_collect_gpu_stats_ws": lambda data, gpu_id: monitor("gpu", data),
        "_collect_network_stats_ws": lambda data, server: monitor("network", data),
        "_send_stats_periodically_ws": lambda websocket, data: monitor("sender", data),
    }
    exec(compile(ast.Module(body=[original], type_ignores=[]), str(SOURCE), "exec"), namespace)
    server = namespace["DataStreamingServer"]()
    server.is_secure_mode = False
    server.last_connection_times = OrderedDict()
    server.RECONNECT_DEBOUNCE_MS = 0
    server.MAX_RECENT_CLIENTS = 10
    server._set_client_awake_state = lambda *_: None
    server._persist_awake_clients_state = lambda: None
    server.awake_client_states = {}
    server.clients = set()
    server.data_ws = None
    server.capture_loop = None
    server.app = SimpleNamespace(last_cursor_sent=None, gpu_id=0)
    server.mode = "test"
    server._sent_frame_timestamps = {}
    server._rtt_samples = []
    server.input_handler = object() if input_handler is None else input_handler
    server.last_start_video_request_times = {}
    server.display_clients = {}
    server._frame_backpressure_task = None
    server._register_input_priority = lambda *_: None
    server._set_display_high_load_state = lambda *_: None
    # Native capture and sleep state are outside this connection fixture.
    # Keep their lifecycle hooks present while exercising the real ws_handler.
    server._adaptive_sleeping = False
    server._stream_sleep_requested = lambda: False
    server._release_idle_capture_memory = lambda: None
    server._reconfigure_lock = asyncio.Lock()
    server.reconfigure_displays = AsyncMock()
    server.shutdown_pipelines = AsyncMock()
    return server, recorded_tasks


class StatsLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def assert_stopped(self, records, count):
        self.assertEqual(len(records), count)
        self.assertTrue(all(record["stopped"] and record["task"].done() for record in records))

    async def test_disconnect_awaits_all_stats_tasks_with_and_without_gpu(self):
        for gpus in (False, True):
            with self.subTest(gpus=gpus):
                server, records = stats_server(gpus=gpus)
                websocket = WebSocket(1234)
                handler = asyncio.create_task(server.ws_handler(websocket))
                await asyncio.wait_for(websocket.receiving.wait(), timeout=1)
                await asyncio.sleep(0)
                websocket.disconnect.set()
                await handler
                await self.assert_stopped(records, 4 if gpus else 3)

    async def test_takeover_old_disconnect_keeps_new_connection_stats_alive(self):
        server, records = stats_server()
        old_ws, new_ws = WebSocket(1234), WebSocket(1235)
        old_handler = asyncio.create_task(server.ws_handler(old_ws))
        await asyncio.wait_for(old_ws.receiving.wait(), timeout=1)
        new_handler = asyncio.create_task(server.ws_handler(new_ws))
        try:
            await asyncio.wait_for(new_ws.receiving.wait(), timeout=1)
            await asyncio.sleep(0)
            self.assertEqual(len(records), 8)
            old_data = records[0]["data"]
            new_data = records[4]["data"]
            self.assertIsNot(old_data, new_data)
            old_ws.disconnect.set()
            await old_handler
            await self.assert_stopped(records[:4], 4)
            self.assertTrue(all(not record["stopped"] for record in records[4:]))
            self.assertIs(server.data_ws, new_ws)
        finally:
            old_ws.disconnect.set()
            new_ws.disconnect.set()
            await asyncio.gather(old_handler, new_handler)
        await self.assert_stopped(records, 8)

    async def test_viewer_connection_and_disconnect_preserve_controller_and_rtt(self):
        server, records = stats_server(gpus=False)
        controller, viewer = WebSocket(1234), WebSocket(1235)
        viewer.request.path = "/#shared"
        controller_handler = asyncio.create_task(server.ws_handler(controller))
        await asyncio.wait_for(controller.receiving.wait(), timeout=1)
        server._sent_frame_timestamps[7] = 123.4
        server._rtt_samples.extend([0.01, 0.02])
        server._smoothed_rtt_ms = 12.5
        server._client_acknowledged_frame_id = 6
        server._backpressure_send_frames_enabled = False
        viewer_handler = asyncio.create_task(server.ws_handler(viewer))
        try:
            await asyncio.wait_for(viewer.receiving.wait(), timeout=1)
            self.assertEqual(server.clients, {controller, viewer})
            self.assertIs(server.data_ws, controller)
            controller.close.assert_not_awaited()
            self.assertNotIn("FORCE_PIN_LOGIN", [call.args[0] for call in controller.send.call_args_list])
            self.assertEqual(server._sent_frame_timestamps, {7: 123.4})
            self.assertEqual(server._rtt_samples, [0.01, 0.02])
            self.assertEqual(server._smoothed_rtt_ms, 12.5)
            self.assertEqual(server._client_acknowledged_frame_id, 6)
            self.assertFalse(server._backpressure_send_frames_enabled)
            viewer.disconnect.set()
            await viewer_handler
            self.assertEqual(server.clients, {controller})
            self.assertIs(server.data_ws, controller)
            server.reconfigure_displays.assert_not_awaited()
            self.assertTrue(all(not record["stopped"] for record in records[:3]))
            await self.assert_stopped(records[3:], 3)
        finally:
            viewer.disconnect.set()
            controller.disconnect.set()
            await asyncio.gather(controller_handler, viewer_handler)
        await self.assert_stopped(records, 6)

    async def test_stale_pin_viewer_is_still_rejected_before_admission(self):
        server, records = stats_server(environment={"PASSWORD": "test-password"})
        controller, viewer = WebSocket(1234), WebSocket(1235)
        viewer.request.path = "/#shared"
        server.clients.add(controller)
        server.data_ws = controller
        server._sent_frame_timestamps[7] = 123.4
        await server.ws_handler(viewer)
        viewer.send.assert_awaited_once_with("FORCE_PIN_LOGIN")
        viewer.close.assert_awaited_once_with(code=4003, reason="Stale session epoch")
        controller.close.assert_not_awaited()
        controller.send.assert_not_awaited()
        self.assertEqual(server.clients, {controller})
        self.assertIs(server.data_ws, controller)
        self.assertEqual(server._sent_frame_timestamps, {7: 123.4})
        self.assertEqual(records, [])

    async def test_gpu_probe_failure_cleans_already_started_system_task(self):
        server, records = stats_server(probe_error=True)
        await server.ws_handler(WebSocket(1234))
        await self.assert_stopped(records, 1)

    async def test_display_cleanup_failure_cannot_leak_stats_tasks(self):
        server, records = stats_server()
        websocket = WebSocket(1234)
        server.display_clients["primary"] = {"ws": websocket}
        server.reconfigure_displays.side_effect = RuntimeError("display cleanup failed")
        handler = asyncio.create_task(server.ws_handler(websocket))
        await asyncio.wait_for(websocket.receiving.wait(), timeout=1)
        websocket.disconnect.set()
        with self.assertRaisesRegex(RuntimeError, "display cleanup failed"):
            await handler
        await self.assert_stopped(records, 4)

    async def test_handler_cancellation_awaits_stats_tasks(self):
        server, records = stats_server()
        websocket = WebSocket(1234)
        handler = asyncio.create_task(server.ws_handler(websocket))
        await asyncio.wait_for(websocket.receiving.wait(), timeout=1)
        handler.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await handler
        await self.assert_stopped(records, 4)


if __name__ == "__main__":
    unittest.main()
