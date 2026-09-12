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


if __name__ == "__main__":
    unittest.main()
