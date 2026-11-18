import asyncio
from collections import OrderedDict
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock

from tests.test_av1_capture import server_methods, settings_server
from tests.test_ws_stats_lifecycle import stats_server, WebSocket


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "root/lsiopy/lib/python3.12/site-packages/selkies/video_diagnostics.py"
spec = importlib.util.spec_from_file_location("video_metrics_test", SOURCE)
metrics_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metrics_module)


def wire(kind=6, key=True, payload=20):
    return bytes([kind, int(key)]) + bytes(8 + payload)


class VideoMetricsTests(unittest.TestCase):
    def test_transport_rates_do_not_count_stripes_or_viewers_as_frames(self):
        clock = [0.0]
        metrics = metrics_module.VideoSessionMetrics("x264enc", 1920, 1080, 30, False, lambda: clock[0])
        clock[0] = 0.25
        metrics.record(wire(4), 65535)
        metrics.record(wire(4), 65535)
        clock[0] = 0.5
        metrics.record(wire(4, False), 0)
        clock[0] = 1.0
        snapshot = metrics.snapshot()
        self.assertEqual(snapshot["frames"], 2)
        self.assertEqual(snapshot["bytes"], 90)
        self.assertEqual(snapshot["fps"], 2)
        self.assertEqual(snapshot["bitrate_bps"], 720)
        self.assertEqual(snapshot["first_sent_ms"], 250)
        self.assertEqual(snapshot["keyframes"], 1)
        self.assertEqual(snapshot["codec"], "h264")
        self.assertIsNone(snapshot["hardware"], "A GPU request is not actual hardware proof")
        clock[0] = 2.0
        idle = metrics.snapshot()
        self.assertEqual(idle["fps"], 0)
        self.assertEqual(idle["bitrate_bps"], 0)
        self.assertEqual(idle["peak_bitrate_bps"], 720)

    def test_key_intervals_stop_and_runtime_evidence_are_distinct(self):
        clock = [0.0]
        metrics = metrics_module.VideoSessionMetrics("av1enc", 2560, 1440, 60, False, lambda: clock[0])
        metrics.record(wire(), 1)
        clock[0] = 1.25
        metrics.record(wire(), 2)
        metrics.update_runtime({"codec": "av1", "hardware": True, "encoder_reason": "private native path"})
        snapshot = metrics.snapshot()
        self.assertTrue(snapshot["hardware"])
        self.assertEqual(snapshot["last_keyframe_interval_seconds"], 1.25)
        self.assertEqual(snapshot["peak_bitrate_window_seconds"], 1.25)
        self.assertNotIn("encoder_reason", snapshot["runtime"])
        metrics.update_runtime(None)
        self.assertIsNone(metrics.snapshot()["hardware"])
        metrics.stop()
        clock[0] = 100
        stopped = metrics.snapshot()
        self.assertFalse(stopped["active"])
        self.assertEqual(stopped["elapsed_seconds"], 1.25)
        metrics.record(wire(), 3)
        self.assertEqual(metrics.snapshot()["frames"], 2)

    def test_snapshot_replace_is_atomic_owner_only_and_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "diagnostics.json"
            for frames in (1, 2):
                metrics_module.write_snapshot({"primary": {"frames": frames}}, path)
            result = json.loads(path.read_text())
            self.assertEqual(result["schema_version"], 1)
            self.assertEqual(result["displays"]["primary"]["frames"], 2)
            self.assertGreater(result["updated_at"], time.time() - 5)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_default_encoder_allowlists_match_actual_compose_and_readme(self):
        expected = "x264enc,h265enc,av1enc,x264enc-striped,jpeg"
        dockerfile = (ROOT / "Dockerfile").read_text()
        compose = (ROOT / "docker-compose.yml").read_text()
        readme = (ROOT / "README.md").read_text()
        startup = (ROOT / "root/etc/cont-init.d/90-selkies-paste-config").read_text()
        self.assertEqual(re.findall(r'^ENV SELKIES_ENCODER="([^"]+)"', dockerfile, re.M), [expected, expected])
        self.assertEqual(re.findall(r'^\s*- SELKIES_ENCODER=(.+)$', compose, re.M), [expected])
        self.assertEqual(re.findall(r'^\s*- SELKIES_ENCODER=(.+)$', readme, re.M), [expected])
        self.assertIn('| `SELKIES_ENCODER` | `' + expected + '` |', readme)
        startup_allowed = re.search(r'case "\$default_encoder" in\s+([^\)]+)\)', startup).group(1)
        self.assertEqual(set(startup_allowed.split('|')), set(expected.split(',')))
        self.assertIn('ENV SELKIES_DEFAULT_ENCODER="x264enc"', dockerfile)
        self.assertIn('- SELKIES_DEFAULT_ENCODER=x264enc', compose)
        self.assertIn('DEFAULT_ENCODER_RAW="${SELKIES_DEFAULT_ENCODER:-x264enc}"', startup)
        self.assertIn('install -d -m 0750 -o abc -g abc /run/selkies-video', startup)


class ServerDiagnosticsTests(unittest.IsolatedAsyncioTestCase):
    async def test_startup_probe_uses_selected_node_and_configured_allowlist(self):
        probe = Mock(side_effect=lambda *args, **kwargs: {
            "available": True, "reason_code": "available", "hardware_encoders": {"av1": "vaapi"},
            "hardware_formats": {"av1": ["420-8"]}})
        for configured in (True, False):
            environment = {"SELKIES_ENCODER": "x264enc,av1enc" if configured else "x264enc"}
            server, namespace = server_methods({"_prepare_av1_capability"},
                os=SimpleNamespace(environ=environment), parse_dri_node_to_index=lambda _: 1,
                av1_probe_capability=probe)
            server.cli_args = SimpleNamespace(dri_node="/dev/dri/renderD129", use_cpu=(False, False))
            await server._prepare_av1_capability()
            probe.assert_called_with(1, use_cpu=False, wayland=False)
            self.assertEqual(server._av1_capability["available"], configured)
            self.assertEqual(server._av1_capability["reason_code"], "available" if configured else "encoder_not_allowed")
            namespace["data_logger"].info.assert_called_once()

    async def test_server_menu_removes_av1_until_probe_passes(self):
        for available in (False, True):
            server, _ = stats_server(gpus=False)
            namespace = server.ws_handler.__func__.__globals__
            allowed = ["x264enc", "h265enc", "av1enc"]
            namespace["SETTING_DEFINITIONS"] = [{"name": "encoder", "type": "enum", "meta": {"allowed": allowed}}]
            namespace["settings"] = SimpleNamespace(encoder="x264enc")
            server._av1_capability = {"available": available,
                                      "reason_code": "available" if available else "device_permission_denied"}
            websocket = WebSocket(1234)
            task = asyncio.create_task(server.ws_handler(websocket))
            try:
                await asyncio.wait_for(websocket.receiving.wait(), 1)
                payload = next(json.loads(call.args[0]) for call in websocket.send.call_args_list
                               if call.args[0].startswith('{"type": "server_settings"'))
                self.assertEqual("av1enc" in payload["settings"]["encoder"]["allowed"], available)
                self.assertEqual(payload["av1_capability"]["available"], available)
                self.assertEqual(allowed, ["x264enc", "h265enc", "av1enc"])
            finally:
                websocket.disconnect.set()
                await task

    async def test_refusal_has_machine_readable_reason_even_if_client_sends_av1(self):
        server, _ = settings_server()
        server._av1_capability = {"available": False, "reason_code": "device_permission_denied"}
        websocket = SimpleNamespace(send=AsyncMock())
        await server._apply_client_settings(websocket, {"encoder": "av1enc", "av1_supported": True, "use_cpu": False}, False)
        message = websocket.send.call_args.args[0]
        self.assertEqual(json.loads(message.split(',', 1)[1])["code"], "device_permission_denied")
        self.assertEqual(server.display_clients["primary"]["encoder"], "x264enc")

    async def test_implicit_server_av1_default_still_requires_probe(self):
        server, _ = settings_server()
        server.cli_args.encoder = "av1enc"
        server._av1_capability = {"available": False, "reason_code": "device_missing"}
        websocket = SimpleNamespace(send=AsyncMock())
        await server._apply_client_settings(websocket, {"encoder": None, "av1_supported": True, "use_cpu": False}, False)
        self.assertEqual(server.display_clients["primary"]["encoder"], "x264enc")
        self.assertEqual(json.loads(websocket.send.call_args.args[0].split(',', 1)[1])["code"], "device_missing")

    async def test_metrics_failure_does_not_stop_sender_or_capture_cleanup(self):
        server, _ = server_methods({"_video_chunk_sender", "_stop_capture_for_display"},
                                   time=time, SENT_FRAME_TIMESTAMP_HISTORY_SIZE=10)
        websocket = SimpleNamespace(send=AsyncMock())
        server.display_clients = {"display2": {"ws": websocket, "sent_timestamps": OrderedDict()}}
        queue = asyncio.Queue()
        queue.put_nowait({"data": wire(), "frame_id": 1})
        queue.put_nowait({"data": wire(key=False), "frame_id": 2})
        server.video_chunk_queues = {"display2": queue}
        broken = SimpleNamespace(record=Mock(side_effect=ValueError("counter failed")),
                                 stopped=None, stop=Mock(), encoder="av1enc",
                                 snapshot=Mock(side_effect=ValueError("summary failed")))
        server._video_metrics = {"display2": broken}
        server._should_preserve_encoded_frame_order = lambda _: True
        server._prune_video_queue_for_display = lambda _: None
        server._is_low_latency_mode_active = lambda _: False
        server._get_effective_send_interval_seconds = lambda _: 0
        server._bytes_sent_in_interval = 0
        task = asyncio.create_task(server._video_chunk_sender("display2"))
        await asyncio.wait_for(queue.join(), 1)
        self.assertEqual(websocket.send.await_count, 2)
        self.assertFalse(task.done())
        capture = SimpleNamespace(stop_capture=Mock())
        server.capture_instances = {"display2": {"module": capture, "sender_task": task}}
        server.capture_loop = asyncio.get_running_loop()
        server._ensure_backpressure_task_is_stopped = AsyncMock(return_value=True)
        await server._stop_capture_for_display("display2")
        capture.stop_capture.assert_called_once()
        self.assertNotIn("display2", server.video_chunk_queues)
        self.assertTrue(task.done())

    async def test_inactive_snapshot_write_failure_is_retried(self):
        clock = [1.0]
        metrics = metrics_module.VideoSessionMetrics("av1enc", 1920, 1080, 30, False, lambda: clock[0])
        metrics.stop()
        writes = []

        def write(data):
            writes.append(data)
            if len(writes) == 1:
                raise OSError("temporary write failure")

        count = [0]

        async def tick(_):
            count[0] += 1
            if count[0] > 3:
                raise asyncio.CancelledError()

        server, namespace = server_methods({"_monitor_video_diagnostics"},
            time=time, write_video_snapshot=write)
        namespace["asyncio"] = SimpleNamespace(sleep=tick, to_thread=asyncio.to_thread,
                                              CancelledError=asyncio.CancelledError)
        server._video_metrics = {"primary": metrics}
        server.capture_instances = {}
        server.display_clients = {}
        with self.assertRaises(asyncio.CancelledError):
            await server._monitor_video_diagnostics()
        self.assertEqual(len(writes), 2, "failed stopped snapshot must retry; successful one may idle")
        self.assertFalse(writes[-1]["primary"]["active"])

    async def test_stop_during_capability_probe_cannot_restart_background_tasks(self):
        server, _ = server_methods({"run_server"})

        async def probe():
            server.stop_server.set_result(True)

        server._prepare_av1_capability = probe
        server._video_diagnostics_task = None
        server._adaptive_sleep_task = None
        await server.run_server()
        self.assertIsNone(server._video_diagnostics_task)
        self.assertIsNone(server._adaptive_sleep_task)

    async def test_blocked_fallback_notification_cannot_block_capture_recovery(self):
        server, _ = server_methods({"_fallback_av1_capture"})
        waiting = asyncio.Event()
        cancelled = asyncio.Event()

        async def blocked_send(_):
            try:
                await waiting.wait()
            finally:
                cancelled.set()

        websocket = SimpleNamespace(send=blocked_send)
        capture = object()
        server.display_clients = {"primary": {"encoder": "av1enc", "ws": websocket}}
        server.capture_instances = {"primary": {"module": capture}}
        server._reconfigure_lock = asyncio.Lock()
        server._restart_capture_for_display_settings_locked = AsyncMock(return_value=None)
        await asyncio.wait_for(server._fallback_av1_capture("primary", capture, "lost device"), 2.5)
        server._restart_capture_for_display_settings_locked.assert_awaited_once_with("primary")
        self.assertTrue(cancelled.is_set())

    async def test_client_failure_accepts_only_registered_controller_enum_and_rate(self):
        controller, viewer, stranger = object(), object(), object()
        clock = [0.0]
        server, namespace = server_methods({"_record_av1_client_error"},
            CLIENT_AV1_ERROR_CODES=metrics_module.CLIENT_AV1_ERROR_CODES,
            time=SimpleNamespace(monotonic=lambda: clock[0]),
            client_permissions={controller: {"role": "controller"}, viewer: {"role": "viewer"},
                                stranger: {"role": "controller"}})
        state = {"ws": controller, "encoder": "av1enc"}
        server.display_clients = {"primary": state}
        code = "CLIENT_DECODE_FAILED"
        server._record_av1_client_error(viewer, code)
        server._record_av1_client_error(stranger, code)
        server._record_av1_client_error(controller, "CLIENT_DECODE_FAILED\nextra")
        namespace["data_logger"].warning.assert_not_called()
        server._record_av1_client_error(controller, code)
        server._record_av1_client_error(controller, code)
        namespace["data_logger"].warning.assert_called_once()
        clock[0] = 5
        server._record_av1_client_error(controller, "CLIENT_FIRST_FRAME_TIMEOUT")
        self.assertEqual(namespace["data_logger"].warning.call_count, 2)
        self.assertEqual(state["last_av1_client_error_code"], "CLIENT_FIRST_FRAME_TIMEOUT")


if __name__ == "__main__":
    unittest.main()
