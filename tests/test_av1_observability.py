import base64
import json
from pathlib import Path
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from tests.test_av1_capture import av1, legacy_settings, native_frame, native_module, NativeCapture


class Av1CapabilityTests(unittest.TestCase):
    def test_selected_node_and_pixel_formats_are_reported_without_capture(self):
        capture = NativeCapture()
        module = native_module(capture)
        with (patch.object(av1, "runtime", return_value=module),
              patch.object(av1, "_probe_device", return_value=({"read_write": True}, None, None)) as device):
            result = av1.probe_capability(1)
        self.assertTrue(result["available"])
        self.assertEqual(result["node_path"], "/dev/dri/renderD129")
        self.assertEqual(result["node_index"], 1)
        self.assertEqual(result["hardware_encoders"], {"av1": "VAAPI"})
        self.assertEqual(result["hardware_formats"], {"av1": ["420-8", "420-10"]})
        self.assertFalse(result["hardware_verified"])
        module.hardware_encoders.assert_called_once_with(1)
        module.hardware_formats.assert_called_once_with(1)
        device.assert_called_once_with("/dev/dri/renderD129")
        self.assertIsNone(capture.callback)
        json.dumps(result)

    def test_device_open_uses_actual_read_write_access(self):
        info = SimpleNamespace(st_mode=stat.S_IFCHR | 0o660, st_uid=1000, st_gid=107)
        with (patch.object(av1.os, "stat", return_value=info),
              patch.object(av1.os, "open", return_value=42) as opened,
              patch.object(av1.os, "close") as closed):
            device, code, reason = av1._probe_device("/dev/dri/renderD129")
        self.assertIsNone(code)
        self.assertIsNone(reason)
        self.assertEqual((device["uid"], device["gid"], device["mode"]), (1000, 107, "0o660"))
        self.assertTrue(device["read_write"])
        opened.assert_called_once()
        self.assertEqual(opened.call_args.args[1] & av1.os.O_RDWR, av1.os.O_RDWR)
        closed.assert_called_once_with(42)

    def test_access_and_probe_failures_have_distinct_codes(self):
        info = SimpleNamespace(st_mode=stat.S_IFCHR | 0o660, st_uid=0, st_gid=107)
        with patch.object(av1.os, "stat", side_effect=FileNotFoundError()):
            self.assertEqual(av1.probe_capability(0)["reason_code"], "device_missing")
        with (patch.object(av1.os, "stat", return_value=info),
              patch.object(av1.os, "open", side_effect=PermissionError("denied"))):
            self.assertEqual(av1.probe_capability(0)["reason_code"], "device_permission_denied")
        with patch.object(av1, "_probe_device", return_value=({"read_write": True}, None, None)):
            with patch.object(av1, "runtime", side_effect=ImportError("missing")):
                self.assertEqual(av1.probe_capability(0)["reason_code"], "runtime_unavailable")
            module = native_module(NativeCapture())
            with patch.object(av1, "runtime", return_value=module):
                module.hardware_encoders.return_value = {"h264": "VAAPI"}
                self.assertEqual(av1.probe_capability(0)["reason_code"], "av1_encoder_missing")
                module.hardware_encoders.return_value = {"av1": "VAAPI"}
                module.hardware_formats.return_value = {"av1": ["420-10"]}
                self.assertEqual(av1.probe_capability(0)["reason_code"], "av1_format_unsupported")
                module.hardware_formats.side_effect = RuntimeError("probe failed")
                self.assertEqual(av1.probe_capability(0)["reason_code"], "capability_probe_failed")
        self.assertEqual(av1.probe_capability(-1)["reason_code"], "invalid_render_node")
        self.assertEqual(av1.probe_capability(0, use_cpu=True)["reason_code"], "cpu_mode")
        self.assertEqual(av1.probe_capability(0, wayland=True)["reason_code"], "wayland_unsupported")


class Av1SequenceAdmissionTests(unittest.TestCase):
    def setUp(self):
        device = patch.object(av1, "_probe_device", return_value=({"read_write": True}, None, None))
        device.start()
        self.addCleanup(device.stop)

    def test_real_keys_keep_their_sequence_while_delta_needs_none(self):
        samples = json.loads((Path(__file__).parent / "fixtures/av1_samples.json").read_text())["samples"]
        frames = samples["main8-delta"]["frames"]
        for frame in frames:
            if frame["key"]:
                self.assertTrue(av1._keyframe_has_sequence(base64.b64decode(frame["base64"])))
        self.assertTrue(av1._keyframe_has_sequence(b"\x12\x00\x2a\x01\x00" +
                                                  native_frame()[12:]))
        self.assertFalse(av1._keyframe_has_sequence(b"\x32\x01\x10\x0a\x01\x00"))

    def test_later_forced_key_without_sequence_is_rejected_with_a_code(self):
        capture = NativeCapture()
        sent = Mock()
        with patch.object(av1, "runtime", return_value=native_module(capture)):
            adapter = av1.Av1Capture()
            adapter.start_capture(legacy_settings(), sent)
        adapter.request_idr_frame()
        capture.callback(native_frame(1, kind=0, payload=b"\x32\x01\x30"))
        self.assertEqual(sent.call_count, 2)
        capture.callback(native_frame(2, payload=b"\x12\x00\x32\x01\x10"))
        with self.assertRaises(av1.Av1Error) as error:
            adapter.check_health()
        self.assertEqual(error.exception.code, "sequence_header_missing")
        self.assertEqual(sent.call_count, 2)
        self.assertEqual(adapter.statistics()["reason_code"], "sequence_header_missing")
        self.assertEqual(adapter.statistics()["keyframe_requests"], 2)

    def test_malformed_and_unbounded_obus_are_rejected(self):
        for payload in (b"\x0a\x80", b"\x0a\x05\x00", b"\x8a\x00",
                        b"\x0e\x07\x01\x00", b"\x12\x00" * 4097):
            with self.subTest(payload=payload[:16]), self.assertRaises(av1.Av1Error) as error:
                av1._keyframe_has_sequence(payload)
            self.assertEqual(error.exception.code, "obu_invalid")

    def test_initial_and_runtime_software_failures_are_distinguishable(self):
        for runtime_failure, code in ((False, "initial_hardware_mismatch"), (True, "runtime_software_fallback")):
            capture = NativeCapture()
            with self.subTest(runtime_failure=runtime_failure), patch.object(av1, "runtime", return_value=native_module(capture)):
                adapter = av1.Av1Capture()
                if runtime_failure:
                    adapter.start_capture(legacy_settings(), Mock())
                capture.info["hardware"] = False
                with self.assertRaises(av1.Av1Error) as error:
                    if runtime_failure:
                        adapter.check_health()
                    else:
                        adapter.start_capture(legacy_settings(), Mock())
                self.assertEqual(error.exception.code, code)

    def test_first_frame_failure_survives_a_secondary_stop_failure(self):
        capture = NativeCapture([])
        capture.stop_capture = Mock(side_effect=RuntimeError("stop failed"))
        with (patch.object(av1, "runtime", return_value=native_module(capture)),
              patch.object(av1, "FIRST_FRAME_TIMEOUT", 0)):
            adapter = av1.Av1Capture()
            with self.assertRaises(av1.Av1Error) as error:
                adapter.start_capture(legacy_settings(), Mock())
        self.assertEqual(error.exception.code, "first_keyframe_timeout")
        self.assertIn("stop failed", error.exception.stop_error)
        self.assertEqual(adapter.statistics()["state"], "failed")

    def test_native_initialization_failure_is_not_a_first_frame_timeout(self):
        capture = NativeCapture()
        capture.start_capture = Mock(side_effect=RuntimeError("driver initialization failed"))
        with patch.object(av1, "runtime", return_value=native_module(capture)):
            adapter = av1.Av1Capture()
            with self.assertRaises(av1.Av1Error) as error:
                adapter.start_capture(legacy_settings(), Mock())
        self.assertEqual(error.exception.code, "encoder_init_failed")
        self.assertEqual(capture.stops, 1)
        self.assertIsNone(adapter.statistics()["first_keyframe_ms"])


class Av1StatisticsTests(unittest.TestCase):
    def test_rates_key_intervals_and_idle_window_are_measured(self):
        stats = av1.CaptureStatistics(10.0)
        key, _ = av1.packet(native_frame(), 1920, 1080)
        delta, _ = av1.packet(native_frame(kind=0), 1920, 1080)
        stats.record(key, 10.25)
        stats.record(delta, 10.5)
        stats.record(key, 11.25)
        current = stats.snapshot(11.25)
        self.assertEqual(current["frames_encoded"], 3)
        self.assertEqual(current["keyframes"], 2)
        self.assertEqual(current["first_keyframe_ms"], 250)
        self.assertEqual(current["keyframe_interval_ms"], 1000)
        self.assertEqual(current["keyframe_interval_frames"], 2)
        self.assertEqual(current["fps"], 2)
        self.assertEqual(current["bitrate_bps"], 2 * (len(key) - 10) * 8)
        self.assertEqual(current["average_bitrate_bps"], 3 * (len(key) - 10) * 8 / 1.25)
        self.assertEqual(current["peak_bitrate_bps"], current["bitrate_bps"])
        stats.stopped_at = 11.5
        idle = stats.snapshot(13)
        self.assertEqual(idle["fps"], 0)
        self.assertEqual(idle["bitrate_bps"], 0)
        self.assertEqual(idle["elapsed_seconds"], 1.5)
        self.assertGreater(idle["peak_bitrate_bps"], 0)


if __name__ == "__main__":
    unittest.main()
