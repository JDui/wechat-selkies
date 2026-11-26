import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

class PreferencesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        import importlib.util
        spec = importlib.util.spec_from_file_location("session_auth_bridge_test", Path(__file__).resolve().parents[1] / "root/scripts/session_auth_bridge.py")
        self.bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.bridge)
        self.bridge.PREFERENCES_PATH = Path(self.temp.name) / "preferences.json"

    def test_settings_and_named_favorites_survive_reload(self):
        patch = {"bottom_action_dock_position": "top", "notification_center_enabled": False,
                 "dock_network_monitor_enabled": False,
                 "download_favorites:/files/:/config": [{"path": "微信/文件", "name": "工作文件"}]}
        self.bridge.update_preferences(patch)
        spec = importlib.util.spec_from_file_location("session_auth_bridge_test_restart", Path(__file__).resolve().parents[1] / "root/scripts/session_auth_bridge.py")
        restarted = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(restarted)
        restarted.PREFERENCES_PATH = self.bridge.PREFERENCES_PATH
        self.assertEqual(restarted.read_preferences(), patch)
        restarted.update_preferences({"download_favorites:/files/:/config": []})
        self.assertEqual(restarted.read_preferences()["download_favorites:/files/:/config"], [])
        self.assertEqual(restarted.read_preferences()["bottom_action_dock_position"], "top")

    def test_video_panel_survives_restart_and_rejects_invalid_patch_atomically(self):
        settings = {"encoder": "h265enc", "framerate": 45, "h264_crf": 24,
                    "h264_paintover_crf": 16, "use_paint_over_quality": True,
                    "h264_streaming_mode": False, "h264_fullcolor": False, "use_cpu": False,
                    "encoder_display2": "x264enc", "framerate_display2": 30}
        self.bridge.update_preferences(settings)
        restarted = load("session_auth_bridge")
        restarted.PREFERENCES_PATH = self.bridge.PREFERENCES_PATH
        self.assertEqual(restarted.read_preferences(), settings)
        for key, value in (("encoder", "unknown"), ("framerate", True),
                           ("framerate", 241), ("h264_crf", 51), ("h264_streaming_mode", 1),
                           ("h264_paintover_crf", 4), ("encoder_display2", "hevc")):
            with self.assertRaises(ValueError):
                restarted.update_preferences({"use_paint_over_quality": False, key: value})
            self.assertEqual(restarted.read_preferences(), settings)

    def test_concurrent_partial_updates_do_not_lose_other_settings(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(self.bridge.update_preferences, [
                {"bottom_action_dock_position": "top"}, {"notification_center_enabled": False},
                {"legacy_upload_fallback_enabled": True}, {"bottom_action_dock_collapsed": True},
            ]))
        self.assertEqual(len(self.bridge.read_preferences()), 4)

    def test_av1_video_preferences_survive_restart_for_each_display(self):
        settings = {"encoder": "av1enc", "use_cpu": False, "h264_fullcolor": False,
                    "encoder_display2": "av1enc", "framerate_display2": 45,
                    "use_cpu_display2": False, "live_paint_mode": "inherit", "frame_feedback_mode": "true",
                    "live_paint_mode_display2": "false", "frame_feedback_mode_display2": "observe"}
        self.bridge.update_preferences(settings)
        restarted = load("session_auth_bridge")
        restarted.PREFERENCES_PATH = self.bridge.PREFERENCES_PATH
        self.assertEqual(restarted.read_preferences(), settings)
        with self.assertRaises(ValueError):
            restarted.update_preferences({"live_paint_mode": "observe"})

    def test_invalid_favorites_do_not_overwrite_settings(self):
        self.bridge.update_preferences({"notification_center_enabled": True})
        for path in ("../ssl", "/etc", "a/../b", "a\\b", "a\x00b"):
            with self.assertRaises(ValueError):
                self.bridge.update_preferences({"download_favorites:/files/:/config": [{"path": path, "name": "name"}]})
        self.assertEqual(self.bridge.read_preferences(), {"notification_center_enabled": True})

    def test_all_throttle_parameters_survive_reload_and_invalid_patch_is_atomic(self):
        settings = {"dynamic_low_latency_enabled": False, "dynamic_throttle_mode": "idle-low-occupancy",
                    "dynamic_low_latency_hold_ms": 8700, "dynamic_low_latency_fps": 4,
                    "dynamic_throttle_strength": 63, "dynamic_low_latency_h264_crf": 40,
                    "dynamic_low_latency_sample_percent": 60, "dynamic_low_latency_disable_paint_over": True}
        self.bridge.update_preferences(settings)
        restarted = load("session_auth_bridge")
        restarted.PREFERENCES_PATH = self.bridge.PREFERENCES_PATH
        self.assertEqual(restarted.read_preferences(), settings)
        for key, value in [("dynamic_low_latency_fps", True), ("dynamic_low_latency_fps", 0),
                           ("dynamic_low_latency_hold_ms", 30001), ("dynamic_throttle_strength", 1.5),
                           ("dynamic_throttle_mode", "unknown")]:
            with self.assertRaises(ValueError):
                restarted.update_preferences({"dynamic_low_latency_enabled": True, key: value})
            self.assertEqual(restarted.read_preferences(), settings)


if __name__ == "__main__":
    unittest.main()
