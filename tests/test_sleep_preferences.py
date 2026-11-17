import importlib.util
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "root/scripts" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SleepTimingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.manager = load("container_sleep_manager")
        self.manager.FRONTEND_ACTIVITY_STATE_PATH = Path(self.temp.name) / "activity.json"
        self.manager.MODE_STATE_PATH = Path(self.temp.name) / "mode.json"
        self.manager.STATE_PATH = Path(self.temp.name) / "sleep.json"
        self.manager.AWAKE_STATE_PATH = Path(self.temp.name) / "awake.json"
        self.manager.started_at = 1000

    def test_browser_clock_skew_cannot_shorten_idle_window(self):
        for client_time in (1, 1234567890000, 9999999999999):
            with mock.patch.object(self.manager.time, "time", return_value=2000):
                self.assertEqual(self.manager.write_frontend_activity(client_time), 2000)
            with mock.patch.object(self.manager.time, "time", return_value=2030):
                payload = self.manager.status_payload()
                self.assertEqual(payload["idle_for_seconds"], 30)
                self.assertEqual(payload["idle_remaining_seconds"], 3570)

    def test_changing_idle_setting_starts_a_full_new_window(self):
        self.manager.MODE_STATE_PATH.write_text(json.dumps({
            "adaptive_sleep_enabled": True, "adaptive_sleep_idle_seconds": 900,
            "sleep_settings_updated_at": 2000,
        }))
        with mock.patch.object(self.manager.time, "time", return_value=2005):
            self.assertEqual(self.manager.status_payload()["idle_remaining_seconds"], 895)

    def test_warning_starts_only_after_full_idle_window(self):
        self.manager.ENABLED = True
        self.manager.REQUIRE_PIN = False
        self.manager.MODE_STATE_PATH.write_text(json.dumps({
            "adaptive_sleep_enabled": True, "adaptive_sleep_idle_seconds": 60,
            "adaptive_sleep_idle_seconds_user_set": True,
        }))
        self.manager.AWAKE_STATE_PATH.write_text(json.dumps({
            "clients": [{"awake": True, "updated_at": 2059}],
        }))
        with mock.patch.object(self.manager.time, "time", return_value=2000):
            self.manager.write_frontend_activity()
        for now, expected in ((2059, False), (2060, True)):
            with mock.patch.object(self.manager.time, "time", return_value=now), \
                 mock.patch.object(self.manager.time, "sleep", side_effect=[None, KeyboardInterrupt]):
                with self.assertRaises(KeyboardInterrupt):
                    self.manager.monitor_loop()
            self.assertEqual(self.manager.read_state()["pending_sleep"], expected)
        self.assertEqual(self.manager.read_state()["warning_deadline_at"], 2120)

    def test_wake_resets_activity(self):
        with mock.patch.object(self.manager.time, "time", return_value=2100):
            self.manager.leave_sleep()
            self.assertEqual(self.manager.latest_frontend_interaction_at(), 2100)

    def test_full_sleep_freezes_workload_and_wake_resumes_it(self):
        self.manager.ENABLED = True
        self.manager.REQUIRE_PIN = False
        with mock.patch.object(self.manager, "list_freezable_pids", return_value=[201, 200]), \
             mock.patch.object(self.manager, "signal", mock.Mock(SIGSTOP=19, SIGCONT=18)), \
             mock.patch.object(self.manager, "send_signal", return_value=True) as signal_process:
            self.assertTrue(self.manager.enter_sleep("idle"))
            self.assertTrue(self.manager.enter_sleep("manual"))
            self.assertEqual(signal_process.call_args_list, [
                mock.call(201, self.manager.signal.SIGSTOP), mock.call(200, self.manager.signal.SIGSTOP)])
            state = self.manager.read_state()
            self.assertEqual(state["mode"], "full")
            self.assertEqual(state["frozen_pids"], [201, 200])
            signal_process.reset_mock()
            self.manager.leave_sleep()
            self.assertEqual(signal_process.call_args_list, [
                mock.call(201, self.manager.signal.SIGCONT), mock.call(200, self.manager.signal.SIGCONT)])
            self.assertFalse(self.manager.read_state()["sleeping"])

    def test_sleep_keeps_discovery_and_auth_but_freezes_desktop(self):
        commands = {200: "python3 /scripts/lan_discovery_service.py",
                    201: "python3 /scripts/session_auth_bridge.py",
                    202: "/opt/wechat/wechat", 203: "python3 /scripts/notification_bridge.py"}
        with mock.patch.object(self.manager, "current_ancestor_pids", return_value={1}), \
             mock.patch.object(self.manager.Path, "iterdir", return_value=[Path(str(pid)) for pid in commands]), \
             mock.patch.object(self.manager, "proc_cmdline", side_effect=commands.get), \
             mock.patch.object(self.manager, "proc_comm", return_value="python3"), \
             mock.patch.object(self.manager, "proc_state", return_value="S"):
            self.assertEqual(self.manager.list_freezable_pids(), [203, 202])

    def test_manual_sleep_survives_disabled_automatic_timer(self):
        self.manager.ENABLED = True
        self.manager.REQUIRE_PIN = False
        self.manager.MODE_STATE_PATH.write_text(json.dumps({"adaptive_sleep_enabled": False}))
        self.manager.write_state({"sleeping": True, "reason": "manual", "mode": "full"})
        with mock.patch.object(self.manager.time, "sleep", side_effect=[None, KeyboardInterrupt]), \
             mock.patch.object(self.manager, "leave_sleep") as wake:
            with self.assertRaises(KeyboardInterrupt):
                self.manager.monitor_loop()
            wake.assert_not_called()
        self.assertTrue(self.manager.read_state()["sleeping"])
        self.assertEqual(self.manager.status_payload()["sleep_block_reason"], "sleeping")


class PreferencesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.bridge = load("session_auth_bridge")
        self.bridge.PREFERENCES_PATH = Path(self.temp.name) / "preferences.json"

    def test_settings_and_named_favorites_survive_reload(self):
        patch = {"bottom_action_dock_position": "top", "notification_center_enabled": False,
                 "dock_network_monitor_enabled": False,
                 "download_favorites:/files/:/config": [{"path": "微信/文件", "name": "工作文件"}]}
        self.bridge.update_preferences(patch)
        restarted = load("session_auth_bridge")
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
