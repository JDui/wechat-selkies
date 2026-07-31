import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


BRIDGE_PATH = Path(__file__).resolve().parents[1] / "root" / "scripts" / "notification_bridge.py"


class NotificationBridgeStateTests(unittest.TestCase):
    def load_bridge(self, temporary, auto_split="false"):
        state_path = Path(temporary) / "notification-bridge.json"
        environment = {
            "NOTIFICATION_BRIDGE_MODE_PATH": str(state_path),
            "SELKIES_AUTO_SPLIT": auto_split,
        }
        with mock.patch.dict(os.environ, environment, clear=False):
            spec = importlib.util.spec_from_file_location("notification_bridge_state_test", BRIDGE_PATH)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        return module, state_path

    def test_environment_sets_initial_auto_split_default(self):
        with tempfile.TemporaryDirectory() as temporary:
            bridge, _ = self.load_bridge(temporary, auto_split="true")
            self.assertTrue(bridge.current_state_payload()["auto_split_enabled"])

    def test_auto_split_setting_persists_to_config_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            bridge, state_path = self.load_bridge(temporary)
            updated = bridge.write_mode_state(auto_split_enabled=True)

            self.assertTrue(updated["auto_split_enabled"])
            self.assertTrue(json.loads(state_path.read_text(encoding="utf-8"))["auto_split_enabled"])
            self.assertTrue(bridge.read_mode_state()["auto_split_enabled"])


if __name__ == "__main__":
    unittest.main()
