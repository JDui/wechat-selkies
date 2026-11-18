import ast
import asyncio
import importlib.util
import json
from pathlib import Path
import struct
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from tests.test_input_queue_decoupling import ScriptedWebSocket
from tests.test_ws_stats_lifecycle import stats_server


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "root/lsiopy/lib/python3.12/site-packages/selkies"
package = ModuleType("av1_capture_tests")
package.__path__ = [str(BACKEND)]
sys.modules[package.__name__] = package
spec = importlib.util.spec_from_file_location(package.__name__ + ".av1_capture", BACKEND / "av1_capture.py")
av1 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(av1)


def native_frame(frame_id=0, kind=1, width=1920, height=1080, payload=b"\x12\x00\x0a\x01\x00\x32\x01\x10"):
    return struct.pack("!BBHHHHH", 4, 0x40 | kind, frame_id, 0, width, height, frame_id) + payload


def legacy_settings(**changes):
    settings = SimpleNamespace(**{name: 0 for name in (
        "capture_x", "capture_y", "capture_cursor", "paint_over_trigger_frames",
        "damage_block_threshold", "damage_block_duration", "watermark_location_enum",
        "h264_paintover_burst_frames", "h264_streaming_mode")},
        capture_width=1920, capture_height=1080, target_fps=30, scale=1,
        auto_adjust_screen_capture_size=False, use_cpu=False, use_paint_over_quality=True,
        h264_crf=24, h264_paintover_crf=18, vaapi_render_node_index=0, watermark_path=b"")
    for name, value in changes.items():
        setattr(settings, name, value)
    return settings


class NativeCapture:
    def __init__(self, frames=None):
        self.frames = [native_frame()] if frames is None else frames
        self.info = {"codec": "av1", "hardware": True, "bit_depth": 8,
                     "fullcolor": False, "striped": False, "encoder": "VAAPI"}
        self.callback = None
        self.settings = None
        self.stops = 0
        self.idr_requests = 0

    def start_capture(self, callback, settings):
        self.callback, self.settings = callback, settings
        for frame in self.frames:
            callback(frame)

    def stop_capture(self):
        self.stops += 1

    def request_idr_frame(self):
        self.idr_requests += 1

    def stream_info(self):
        return self.info


def native_module(capture):
    return SimpleNamespace(ScreenCapture=lambda: capture, CaptureSettings=SimpleNamespace,
                           hardware_encoders=Mock(return_value={"av1": "VAAPI"}),
                           hardware_formats=Mock(return_value={"av1": ["420-8", "420-10"]}))


class Av1PacketTests(unittest.TestCase):
    def test_key_delta_intra_anchor_and_ack_header(self):
        for kind, key in ((1, 1), (0, 0), (2, 0), (8, 0), (9, 1)):
            data, frame_id = av1.packet(native_frame(65535, kind), 1920, 1080)
            self.assertEqual(struct.unpack("!BBHHHH", data[:10]), (6, key, 65535, 0, 1920, 1080))
            self.assertEqual(frame_id, 65535)
            self.assertEqual(data[10:], b"\x12\x00\x0a\x01\x00\x32\x01\x10")
        self.assertEqual(av1.packet(native_frame(0), 1920, 1080)[1], 0)

    def test_alignment_does_not_change_source_geometry(self):
        data, _ = av1.packet(native_frame(width=1408, height=1082), 1366, 1080)
        self.assertEqual(struct.unpack("!BBHHHH", data[:10])[-2:], (1366, 1080))

    def test_malformed_and_incompatible_native_frames_are_rejected(self):
        for native in (b"", native_frame()[:12], b"\x05" + native_frame()[1:],
                       native_frame(kind=3), native_frame(width=1000),
                       native_frame(height=1500), native_frame().replace(b"\x41", b"\x51", 1)):
            with self.subTest(native=native[:12]), self.assertRaises(RuntimeError):
                av1.packet(native, 1920, 1080)

    def test_packet_size_and_geometry_limits(self):
        native = native_frame()
        with patch.object(av1, "MAX_PACKET_BYTES", len(native)):
            av1.packet(native, 1920, 1080)
            with self.assertRaisesRegex(RuntimeError, "oversized"):
                av1.packet(native + b"\x00", 1920, 1080)
        for width, height in ((8193, 1080), (1920, 8193)):
            with self.subTest(width=width, height=height), self.assertRaisesRegex(RuntimeError, "geometry"):
                av1.packet(native_frame(width=width, height=height), width, height)


class Av1CaptureTests(unittest.TestCase):
    def setUp(self):
        device = patch.object(av1, "_probe_device", return_value=({"read_write": True}, None, None))
        device.start()
        self.addCleanup(device.stop)

    def test_hardware_session_waits_for_key_and_preserves_order(self):
        capture = NativeCapture([native_frame(65534, 0), native_frame(65535), native_frame(0, 0)])
        module = native_module(capture)
        delivered = []
        with patch.object(av1, "runtime", return_value=module):
            adapter = av1.Av1Capture()
            adapter.start_capture(legacy_settings(), lambda data, frame_id: delivered.append((data, frame_id)))
        self.assertEqual([frame_id for _, frame_id in delivered], [65535, 0])
        self.assertEqual(capture.settings.codec, "av1")
        self.assertFalse(capture.settings.use_cpu)
        self.assertFalse(capture.settings.omit_stripe_headers)
        self.assertFalse(capture.settings.video_fullcolor)
        self.assertEqual(capture.settings.video_bit_depth, 8)
        self.assertEqual(capture.settings.video_crf, 24)
        self.assertEqual(capture.settings.video_paintover_crf, 18)
        self.assertEqual(capture.idr_requests, 1)
        capture.callback(native_frame(1, 0))
        self.assertEqual([frame_id for _, frame_id in delivered], [65535, 0, 1])
        adapter.stop_capture()
        capture.callback(native_frame(2, 0))
        self.assertEqual(len(delivered), 3)

    def test_cpu_and_missing_gpu_or_format_fail_before_capture(self):
        for reason in ("cpu", "node", "codec", "format", "scale", "automatic", "width", "height"):
            capture = NativeCapture()
            module = native_module(capture)
            settings = legacy_settings()
            if reason == "cpu":
                settings.use_cpu = True
            elif reason == "node":
                settings.vaapi_render_node_index = -1
            elif reason == "codec":
                module.hardware_encoders.return_value = {"h264": "VAAPI"}
            elif reason == "format":
                module.hardware_formats.return_value = {"av1": ["420-10"]}
            elif reason == "scale":
                settings.scale = 2
            elif reason == "automatic":
                settings.auto_adjust_screen_capture_size = True
            elif reason == "width":
                settings.capture_width = 8193
            else:
                settings.capture_height = 8193
            with self.subTest(reason=reason), patch.object(av1, "runtime", return_value=module):
                with self.assertRaises(RuntimeError):
                    av1.Av1Capture().start_capture(settings, Mock())
            self.assertIsNone(capture.callback)

    def test_runtime_fallback_or_format_change_never_publishes_initial_frames(self):
        for update in ({"hardware": False}, {"codec": "h264"}, {"bit_depth": 10},
                       {"fullcolor": True}, {"striped": True}):
            capture = NativeCapture()
            capture.info.update(update)
            callback = Mock()
            with self.subTest(update=update), patch.object(av1, "runtime", return_value=native_module(capture)):
                with self.assertRaises(RuntimeError):
                    av1.Av1Capture().start_capture(legacy_settings(), callback)
            callback.assert_not_called()
            self.assertEqual(capture.stops, 1)

    def test_no_keyframe_times_out_and_cleans_up(self):
        capture = NativeCapture([native_frame(0, 0)])
        with patch.object(av1, "runtime", return_value=native_module(capture)), patch.object(av1, "FIRST_FRAME_TIMEOUT", 0):
            with self.assertRaisesRegex(RuntimeError, "no key frame"):
                av1.Av1Capture().start_capture(legacy_settings(), Mock())
        self.assertEqual(capture.stops, 1)

    def test_startup_queue_cannot_silently_drop_reference_frames(self):
        capture = NativeCapture([native_frame(i, 1 if i == 0 else 0) for i in range(4)])
        callback = Mock()
        with patch.object(av1, "runtime", return_value=native_module(capture)), patch.object(av1, "MAX_PENDING_FRAMES", 3):
            with self.assertRaisesRegex(RuntimeError, "queue overflow"):
                av1.Av1Capture().start_capture(legacy_settings(), callback)
        callback.assert_not_called()
        self.assertEqual(capture.stops, 1)

    def test_startup_queue_byte_budget_is_enforced_before_publication(self):
        capture = NativeCapture([native_frame(), native_frame(1, 0)])
        callback = Mock()
        wire_size = len(native_frame()) - 2
        with (patch.object(av1, "runtime", return_value=native_module(capture)),
              patch.object(av1, "MAX_PENDING_BYTES", wire_size * 2 - 1)):
            with self.assertRaisesRegex(RuntimeError, "queue overflow"):
                av1.Av1Capture().start_capture(legacy_settings(), callback)
        callback.assert_not_called()
        self.assertEqual(capture.stops, 1)

    def test_callback_error_is_retained_for_monitor_and_blocks_later_frames(self):
        capture = NativeCapture()
        callback = Mock()
        with patch.object(av1, "runtime", return_value=native_module(capture)):
            adapter = av1.Av1Capture()
            adapter.start_capture(legacy_settings(), callback)
        capture.callback(b"bad native frame")
        capture.callback(native_frame(1, 0))
        with self.assertRaisesRegex(RuntimeError, "frame delivery failed"):
            adapter.check_health()
        self.assertEqual(callback.call_count, 1)

    def test_midstream_software_demotion_is_a_failure_not_a_continuing_mode(self):
        capture = NativeCapture()
        callback = Mock()
        with patch.object(av1, "runtime", return_value=native_module(capture)):
            adapter = av1.Av1Capture()
            adapter.start_capture(legacy_settings(), callback)
        capture.info.update(hardware=False, encoder="SVT-AV1", encoder_reason="device lost")
        with self.assertRaisesRegex(RuntimeError, "device lost"):
            adapter.check_health()
        capture.callback(native_frame(1, 0))
        self.assertEqual(callback.call_count, 1)


def server_methods(names, **extra):
    source = BACKEND / "selkies.py"
    tree = ast.parse(source.read_text(encoding="utf-8-sig"))
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "DataStreamingServer")
    names = set(names) | {"_av1_rejection", "_notify_av1_fallback", "_finish_video_metrics"}
    cls.body = [node for node in cls.body if getattr(node, "name", "") in names]
    metrics_spec = importlib.util.spec_from_file_location("av1_metrics_tests", BACKEND / "video_diagnostics.py")
    metrics_module = importlib.util.module_from_spec(metrics_spec)
    metrics_spec.loader.exec_module(metrics_module)
    namespace = {"asyncio": asyncio, "json": json, "data_logger": Mock(),
                 "websockets": SimpleNamespace(ConnectionClosed=ConnectionError), "IS_WAYLAND": False,
                 "av1_available": lambda: True, "hevc_available": lambda: True, "CURSOR_SIZE": 0,
                 "SETTING_DEFINITIONS": [], "VideoSessionMetrics": metrics_module.VideoSessionMetrics}
    namespace.update(extra)
    exec(compile(ast.Module(body=[cls], type_ignores=[]), str(source), "exec"), namespace)
    return namespace["DataStreamingServer"](), namespace


def settings_server(**extra):
    server, namespace = server_methods({"_apply_client_settings", "_parse_settings_payload"}, **extra)
    definitions = [{"name": "encoder", "type": "enum", "default": "x264enc",
                    "meta": {"allowed": ["x264enc", "h265enc", "av1enc"]}}]
    defaults = {"encoder": "x264enc"}
    for name in ("is_manual_resolution_mode", "use_cpu", "h264_fullcolor"):
        definitions.append({"name": name, "type": "bool", "default": False})
        defaults[name] = (False, False)
    definitions.append({"name": "framerate", "type": "range", "meta": {"default_value": 30}})
    defaults["framerate"] = (1, 240)
    namespace["SETTING_DEFINITIONS"] = definitions
    server.cli_args = SimpleNamespace(**defaults)
    server._reconfigure_lock = asyncio.Lock()
    server.app = SimpleNamespace(audio_bitrate=128000, encoder="x264enc")
    server.display_clients = {"primary": {"width": 1920, "height": 1080, "position": "right"}}
    server._initial_h264_crf = 24
    server._av1_capability = {"available": True, "reason_code": "available"}
    server._refresh_low_latency_runtime_tuning = Mock()
    server.input_handler = None
    server.is_pcmflux_capturing = False
    server.reconfigure_displays = AsyncMock()
    return server, namespace


class Av1ServerTests(unittest.IsolatedAsyncioTestCase):
    async def test_client_capability_survives_parse_and_partial_updates(self):
        server, _ = settings_server()
        websocket = SimpleNamespace(send=AsyncMock())
        parsed = server._parse_settings_payload('{"displayId":"primary","displayPosition":"right","encoder":"av1enc","av1_supported":true,"use_cpu":false}')
        self.assertIs(parsed["av1_supported"], True)
        await server._apply_client_settings(websocket, parsed, False)
        state = server.display_clients["primary"]
        self.assertEqual(state["encoder"], "av1enc")
        self.assertIs(state["h264_fullcolor"], False)
        partial = server._parse_settings_payload('{"displayId":"primary","displayPosition":"right","encoder":"av1enc","framerate":45,"use_cpu":false}')
        self.assertNotIn("av1_supported", partial)
        await server._apply_client_settings(websocket, partial, False)
        self.assertIs(state["av1_supported"], True)
        self.assertEqual(state["encoder"], "av1enc")
        websocket.send.assert_not_awaited()

    async def test_unsupported_cpu_locked_runtime_and_wayland_refuse_av1(self):
        for reason in ("capability", "cpu", "locked", "runtime", "wayland"):
            server, namespace = settings_server()
            websocket = SimpleNamespace(send=AsyncMock())
            settings = {"encoder": "av1enc", "av1_supported": True, "use_cpu": False}
            if reason == "capability":
                settings.pop("av1_supported")
            elif reason == "cpu":
                settings["use_cpu"] = True
            elif reason == "locked":
                server.cli_args.use_cpu = (True, True)
            elif reason == "runtime":
                namespace["av1_available"] = lambda: False
            else:
                namespace["IS_WAYLAND"] = True
                namespace["which"] = lambda _: False
            with self.subTest(reason=reason):
                await server._apply_client_settings(websocket, settings, False)
                self.assertEqual(server.display_clients["primary"]["encoder"], "x264enc")
                self.assertTrue(websocket.send.call_args.args[0].startswith("AV1_ENCODER_FALLBACK,"))

    async def test_viewer_cannot_change_controller_codec(self):
        server, _ = settings_server()
        state = server.display_clients["primary"].copy()
        websocket = SimpleNamespace(remote_address=("viewer", 1))
        await server._apply_client_settings(websocket, {"encoder": "av1enc", "av1_supported": True}, False, "viewer")
        self.assertEqual(server.display_clients["primary"], state)

    async def test_shared_settings_and_immediate_resume_request_key_without_resetting_controller(self):
        for codec in ("av1enc", "h265enc", "x264enc"):
            with self.subTest(codec=codec):
                server, _ = stats_server(gpus=False)
                server.ws_handler.__func__.__globals__["active_mk_token"] = None
                server.ws_handler.__func__.__globals__["data_logger"] = Mock()
                methods, _ = server_methods(
                    {"_sync_shared_viewer", "_parse_settings_payload", "broadcast_stream_resolution"},
                    websockets=SimpleNamespace(broadcast=Mock(), ConnectionClosed=ConnectionError))
                for name in ("_sync_shared_viewer", "_parse_settings_payload", "broadcast_stream_resolution"):
                    setattr(server, name, getattr(methods, name).__func__.__get__(server))
                events = []
                capture = SimpleNamespace()
                if codec != "x264enc":
                    capture.request_idr_frame = Mock(side_effect=lambda: events.append("key"))
                server.capture_instances = {"primary": {"module": capture}}
                controller = ScriptedWebSocket(port=4501)
                server.clients.add(controller)
                server.data_ws = controller
                state = {"ws": controller, "encoder": codec, "use_cpu": False,
                         "acknowledged_frame_id": 17, "width": 1920, "height": 1080}
                server.display_clients = {"primary": state.copy()}
                viewer = ScriptedWebSocket()
                viewer.request.path = "/#shared"

                async def send(message):
                    if message == "PIPELINE_RESETTING primary":
                        events.append("reset")

                viewer.send.side_effect = send
                viewer.feed('SETTINGS,{"displayId":"primary","encoder":"jpeg","use_cpu":true}', "START_VIDEO")
                viewer.hang_up()
                await asyncio.wait_for(server.ws_handler(viewer), timeout=2)
                self.assertEqual(events, ["reset", "reset"] if codec == "x264enc" else
                                 ["reset", "key", "reset", "key"])
                self.assertEqual(server.display_clients["primary"], state)
                self.assertIs(server.capture_instances["primary"]["module"], capture)
                self.assertIs(server.data_ws, controller)
                controller.send.assert_not_awaited()
                controller.close.assert_not_awaited()
                server.reconfigure_displays.assert_not_awaited()

    async def test_shared_key_request_failure_uses_av1_recovery(self):
        class FailedKeyRequest:
            def request_idr_frame(self):
                raise RuntimeError("device lost")

        server, _ = server_methods({"_sync_shared_viewer"}, Av1Capture=FailedKeyRequest)
        server.capture_loop = asyncio.get_running_loop()
        capture = FailedKeyRequest()
        server.capture_instances = {"primary": {"module": capture}}
        server.broadcast_stream_resolution = AsyncMock()
        server._fallback_av1_capture = AsyncMock()
        viewer = SimpleNamespace(send=AsyncMock())
        await server._sync_shared_viewer(viewer)
        viewer.send.assert_awaited_once_with("PIPELINE_RESETTING primary")
        server._fallback_av1_capture.assert_awaited_once()
        args = server._fallback_av1_capture.call_args.args
        self.assertEqual(args[:2], ("primary", capture))
        self.assertEqual(str(args[2]), "device lost")
        self.assertEqual(args[3], "keyframe_request_failed")

    async def test_health_failure_resets_current_capture_but_ignores_stale_instance(self):
        server, namespace = server_methods({"_monitor_av1_capture", "_fallback_av1_capture"})
        capture = SimpleNamespace(check_health=Mock(side_effect=RuntimeError("lost GPU")))
        server.capture_loop = asyncio.get_running_loop()
        server._reconfigure_lock = asyncio.Lock()
        websocket = SimpleNamespace(send=AsyncMock())
        server.display_clients = {"primary": {"encoder": "av1enc", "ws": websocket}}
        server.capture_instances = {"primary": {"module": capture}}
        server._restart_capture_for_display_settings_locked = AsyncMock(return_value=None)
        await server._fallback_av1_capture("primary", object(), "stale")
        server._restart_capture_for_display_settings_locked.assert_not_awaited()
        namespace["asyncio"] = SimpleNamespace(sleep=AsyncMock(), CancelledError=asyncio.CancelledError,
                                              wait_for=asyncio.wait_for)
        await server._monitor_av1_capture("primary", capture)
        self.assertEqual(server.display_clients["primary"]["encoder"], "x264enc")
        server._restart_capture_for_display_settings_locked.assert_awaited_once_with("primary")
        self.assertTrue(websocket.send.call_args.args[0].startswith("AV1_ENCODER_FALLBACK,"))

    async def test_startup_failure_stops_capture_and_falls_back_even_if_notification_disconnects(self):
        bad_capture = SimpleNamespace(start_capture=Mock(side_effect=RuntimeError("VAAPI failed")),
                                      stop_capture=Mock(side_effect=RuntimeError("already stopped")))
        good_capture = SimpleNamespace(start_capture=Mock(), stop_capture=Mock())
        server, _ = server_methods({"_start_capture_for_display"},
                                   Av1Capture=lambda: bad_capture, ScreenCapture=lambda: good_capture,
                                   StripeCallback=lambda callback: callback)
        server._adaptive_sleeping = False
        server._stream_sleep_requested = lambda: False
        server.capture_instances = {}
        server.video_chunk_queues = {}
        websocket = SimpleNamespace(send=AsyncMock(side_effect=ConnectionError("disconnected")))
        server.display_clients = {"primary": {"encoder": "av1enc", "ws": websocket}}
        server.app = SimpleNamespace(encoder="x264enc")
        server._get_capture_settings = lambda *args: legacy_settings()
        server._video_chunk_sender = AsyncMock()
        server.capture_loop = asyncio.get_running_loop()
        await server._start_capture_for_display("primary", 1920, 1080, 0, 0)
        self.assertEqual(server.display_clients["primary"]["encoder"], "x264enc")
        self.assertIs(server.capture_instances["primary"]["module"], good_capture)
        good_capture.start_capture.assert_called_once()
        bad_capture.stop_capture.assert_called_once()
        server.capture_instances["primary"]["sender_task"].cancel()

    async def test_stop_cancels_monitor_and_sender_even_when_native_av1_stop_fails(self):
        class FailedAv1Stop:
            def stop_capture(self):
                raise RuntimeError("driver already stopped")

        server, _ = server_methods({"_stop_capture_for_display"}, Av1Capture=FailedAv1Stop)
        server.capture_loop = asyncio.get_running_loop()
        server._ensure_backpressure_task_is_stopped = AsyncMock(return_value=True)
        health = asyncio.create_task(asyncio.Event().wait())
        sender = asyncio.create_task(asyncio.Event().wait())
        server.capture_instances = {"primary": {"module": FailedAv1Stop(), "health_task": health, "sender_task": sender}}
        server.video_chunk_queues = {"primary": asyncio.Queue()}
        self.assertTrue(await server._stop_capture_for_display("primary"))
        self.assertTrue(health.cancelled())
        self.assertTrue(sender.cancelled())
        self.assertNotIn("primary", server.capture_instances)
        self.assertNotIn("primary", server.video_chunk_queues)

    async def test_monitor_can_stop_its_own_capture_without_canceling_itself(self):
        server, _ = server_methods({"_stop_capture_for_display"})
        server.capture_loop = asyncio.get_running_loop()
        server._ensure_backpressure_task_is_stopped = AsyncMock(return_value=False)
        capture = SimpleNamespace(stop_capture=Mock())
        server.capture_instances = {"primary": {"module": capture, "health_task": asyncio.current_task()}}
        server.video_chunk_queues = {"primary": asyncio.Queue()}
        self.assertFalse(await server._stop_capture_for_display("primary"))
        self.assertFalse(asyncio.current_task().cancelling())
        capture.stop_capture.assert_called_once()


if __name__ == "__main__":
    unittest.main()
