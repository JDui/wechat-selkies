import ast
import importlib.util
import json
from pathlib import Path
import struct
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "root/lsiopy/lib/python3.12/site-packages/selkies"
spec = importlib.util.spec_from_file_location("hevc_capture", BACKEND / "hevc_capture.py")
hevc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hevc)


class HevcTests(unittest.TestCase):
    def test_annex_b_keyframe_and_ack_header(self):
        for nal_type, key in ((19, 1), (21, 1), (1, 0)):
            payload = b"\x00\x00\x00\x01\x40\x01vps\x00\x00\x01" + bytes([nal_type << 1, 1]) + b"frame"
            data = hevc.packet(payload, 65537, 1920, 1080)
            self.assertEqual(struct.unpack("!BBHHHH", data[:10]), (5, key, 1, 0, 1920, 1080))
            self.assertEqual(data[10:], payload)

    def test_capability_survives_settings_parser_and_missing_is_not_false(self):
        tree = ast.parse((BACKEND / "selkies.py").read_text(encoding="utf-8-sig"))
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "DataStreamingServer")
        method = next(n for n in cls.body if getattr(n, "name", "") == "_parse_settings_payload")
        scope = {"json": json, "data_logger": Mock()}
        exec(compile(ast.Module(body=[method], type_ignores=[]), "settings-parser", "exec"), scope)
        parse = scope["_parse_settings_payload"]
        self.assertIs(parse(None, '{"encoder":"h265enc","hevc_supported":true}')["hevc_supported"], True)
        self.assertIs(parse(None, '{"hevc_supported":false}')["hevc_supported"], False)
        self.assertNotIn("hevc_supported", parse(None, '{"framerate":45}'))

    def test_missing_gpu_encoder_does_not_silently_use_software(self):
        capture = Mock()
        module = SimpleNamespace(ScreenCapture=lambda: capture, CaptureSettings=SimpleNamespace,
                                 hardware_encoders=lambda _: {})
        legacy = SimpleNamespace(**{key: 0 for key in (
            "capture_width", "capture_height", "capture_x", "capture_y", "capture_cursor", "target_fps",
            "scale", "auto_adjust_screen_capture_size", "use_paint_over_quality", "paint_over_trigger_frames",
            "damage_block_threshold", "damage_block_duration", "watermark_location_enum", "h264_crf",
            "h264_paintover_crf", "h264_paintover_burst_frames", "h264_streaming_mode", "vaapi_render_node_index")},
            use_cpu=False, watermark_path=b"")
        with patch.object(hevc, "runtime", return_value=module):
            with self.assertRaisesRegex(RuntimeError, "no H.265 encoder"):
                hevc.HevcCapture().start_capture(legacy, Mock())
        capture.start_capture.assert_not_called()


if __name__ == "__main__":
    unittest.main()
