import ast
import importlib.util
from pathlib import Path
import struct
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "root/lsiopy/lib/python3.12/site-packages/selkies"
PACKAGE = "h264_capture_tests"
package = ModuleType(PACKAGE)
package.__path__ = [str(BACKEND)]
sys.modules[PACKAGE] = package
spec = importlib.util.spec_from_file_location(PACKAGE + ".h264_capture", BACKEND / "h264_capture.py")
h264 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h264)


class Frame:
    def __init__(self, frame_id, payload, data_type=1):
        self.frame_id = frame_id
        self.data_type = data_type
        self.payload = payload

    def __bytes__(self):
        return self.payload


def legacy_settings(**changes):
    values = dict(
        capture_width=1920, capture_height=1080, capture_x=0, capture_y=0,
        capture_cursor=False, target_fps=30, scale=1.0,
        auto_adjust_screen_capture_size=False, use_cpu=False,
        use_paint_over_quality=True, paint_over_trigger_frames=15,
        damage_block_threshold=10, damage_block_duration=20,
        watermark_location_enum=0, watermark_path=b"",
        h264_crf=24, h264_paintover_crf=18, h264_paintover_burst_frames=5,
        h264_streaming_mode=True, h264_fullcolor=False,
        vaapi_render_node_index=0,
    )
    values.update(changes)
    return SimpleNamespace(**values)


class NativeCapture:
    def __init__(self, frames=None, info=None):
        self.frames = list(frames or [Frame(0, b"\\x00\\x00\\x00\\x01\\x67SPS\\x00\\x00\\x00\\x01\\x68PPS\\x00\\x00\\x00\\x01\\x65IDR")])
        self.info = info or {"codec": "h264", "hardware": True, "fullcolor": False, "striped": False}
        self.callback = None
        self.settings = None
        self.stops = 0
        self.idr_requests = 0

    def start_capture(self, callback, settings):
        self.callback, self.settings = callback, settings
        for frame in self.frames:
            callback(frame)

    def stream_info(self):
        return self.info

    def stop_capture(self):
        self.stops += 1

    def request_idr_frame(self):
        self.idr_requests += 1

    def update_framerate(self, fps):
        self.fps = fps

    def update_tunables(self, settings):
        self.tunables = settings


def module_for(capture):
    return SimpleNamespace(
        ScreenCapture=lambda: capture,
        CaptureSettings=SimpleNamespace,
        hardware_encoders=lambda _node: {"h264": "VAAPI"},
    )


class H264PacketTests(unittest.TestCase):
    def test_wire_header_marks_idr_and_preserves_wrapping_frame_id(self):
        frame = Frame(65537, b"\\x00\\x00\\x00\\x01\\x67SPS\\x00\\x00\\x00\\x01\\x68PPS\\x00\\x00\\x00\\x01\\x65IDR")
        data, frame_id = h264.packet(frame, 1920, 1080)
        self.assertEqual(struct.unpack("!BBHHHH", data[:10]), (1, 1, 1, 0, 1920, 1080))
        self.assertEqual(frame_id, 1)
        self.assertEqual(data[10:], bytes(frame))

    def test_delta_frame_is_not_marked_as_keyframe(self):
        frame = Frame(7, b"\\x00\\x00\\x00\\x01\\x41delta")
        data, frame_id = h264.packet(frame, 1280, 720)
        self.assertEqual(struct.unpack("!BBHHHH", data[:10]), (1, 0, 7, 0, 1280, 720))

    def test_rejects_wrong_codec_frame_type(self):
        with self.assertRaisesRegex(RuntimeError, "Unexpected Pixelflux frame type"):
            h264.packet(Frame(1, b"data", data_type=5), 1920, 1080)


class H264CaptureTests(unittest.TestCase):
    def test_uses_private_runtime_and_preserves_keyframe_then_delta_order(self):
        key = Frame(10, b"\\x00\\x00\\x00\\x01\\x67SPS\\x00\\x00\\x00\\x01\\x68PPS\\x00\\x00\\x00\\x01\\x65IDR")
        delta = Frame(11, b"\\x00\\x00\\x00\\x01\\x41delta")
        capture = NativeCapture([Frame(9, b"\\x00\\x00\\x00\\x01\\x41early"), key, delta])
        module = module_for(capture)
        delivered = []
        with patch.object(h264, "runtime", return_value=module):
            adapter = h264.H264Capture()
            adapter.start_capture(legacy_settings(), lambda data, frame_id: delivered.append((data, frame_id)))
        self.assertEqual([frame_id for _, frame_id in delivered], [10, 11])
        self.assertEqual(capture.settings.codec, "h264")
        self.assertTrue(capture.settings.video_fullframe)
        self.assertEqual(capture.settings.video_crf, 24)
        self.assertEqual(capture.settings.video_paintover_crf, 18)
        self.assertTrue(capture.settings.video_streaming_mode)
        self.assertEqual(capture.idr_requests, 1)
        capture.callback(Frame(12, b"\\x00\\x00\\x00\\x01\\x41next"))
        self.assertEqual([frame_id for _, frame_id in delivered], [10, 11, 12])
        adapter.stop_capture()
        capture.callback(Frame(13, b"\\x00\\x00\\x00\\x01\\x41late"))
        self.assertEqual(len(delivered), 3)

    def test_requires_hardware_when_cpu_encoding_is_not_requested(self):
        capture = NativeCapture()
        module = module_for(capture)
        module.hardware_encoders = lambda _node: {}
        with patch.object(h264, "runtime", return_value=module):
            with self.assertRaisesRegex(RuntimeError, "no H.264 hardware encoder"):
                h264.H264Capture().start_capture(legacy_settings(), Mock())
        self.assertIsNone(capture.callback)

    def test_rejects_software_demotion_when_hardware_was_requested(self):
        capture = NativeCapture(info={"codec": "h264", "hardware": False, "encoder": "x264"})
        callback = Mock()
        with patch.object(h264, "runtime", return_value=module_for(capture)):
            with self.assertRaisesRegex(RuntimeError, "hardware initialization failed"):
                h264.H264Capture().start_capture(legacy_settings(), callback)
        callback.assert_not_called()
        self.assertEqual(capture.stops, 1)

    def test_waits_for_idr_and_times_out_without_publishing_delta_frames(self):
        capture = NativeCapture([Frame(1, b"\\x00\\x00\\x00\\x01\\x41delta")])
        callback = Mock()
        with patch.object(h264, "runtime", return_value=module_for(capture)), patch.object(h264, "FIRST_FRAME_TIMEOUT", 0):
            with self.assertRaisesRegex(RuntimeError, "no IDR frame"):
                h264.H264Capture().start_capture(legacy_settings(), callback)
        callback.assert_not_called()
        self.assertEqual(capture.stops, 1)

    def test_exposes_live_framerate_and_paint_over_controls(self):
        capture = NativeCapture()
        module = module_for(capture)
        with patch.object(h264, "runtime", return_value=module):
            adapter = h264.H264Capture()
            adapter.start_capture(legacy_settings(), Mock())
            adapter.update_framerate(24)
            adapter.update_paint_over(False)
            self.assertEqual(capture.fps, 24.0)
            self.assertFalse(capture.tunables.use_paint_over_quality)
            changed = legacy_settings(h264_crf=28, h264_paintover_crf=16, h264_paintover_burst_frames=3)
            adapter.update_quality(changed)
            self.assertEqual(capture.tunables.video_crf, 28)
            self.assertEqual(capture.tunables.video_paintover_crf, 16)
            self.assertEqual(capture.tunables.video_paintover_burst_frames, 3)

    def test_server_routes_fullframe_h264_to_new_adapter_and_striped_remains_separate(self):
        source = (BACKEND / "selkies.py").read_text(encoding="utf-8-sig")
        self.assertIn('elif encoder_for_this_capture == "x264enc":', source)
        self.assertIn("capture_module = H264Capture()", source)
        self.assertIn('encoder_for_this_capture in ("x264enc", "h265enc", "av1enc")', source)
        self.assertIn("capture_module = ScreenCapture()", source)


if __name__ == "__main__":
    unittest.main()
