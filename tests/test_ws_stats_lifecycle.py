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


def stats_server(gpus=True, probe_error=False):
    # Exercise the actual connection handler without X11/PulseAudio/native dependencies.
    tree = ast.parse(SOURCE.read_text(encoding="utf-8-sig"))
    original = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "DataStreamingServer")
    original.body = [node for node in original.body if getattr(node, "name", "") == "ws_handler"]
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
        "os": SimpleNamespace(environ={}), "data_logger": logging.getLogger("stats-test"),
        "logger": logging.getLogger("stats-test"), "client_permissions": {},
        "TARGET_FRAMERATE": 30, "GPU_ID_DEFAULT": 0, "SETTING_DEFINITIONS": [],
        "PULSEAUDIO_AVAILABLE": False, "upload_dir_path": None,
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
    server.input_handler = object()
    server.last_start_video_request_times = {}
    server.display_clients = {}
    server._frame_backpressure_task = None
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
