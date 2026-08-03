import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


BRIDGE_PATH = Path(__file__).resolve().parents[1] / "root" / "scripts" / "notification_bridge.py"
RUNTIME_PATH = (
    Path(__file__).resolve().parents[1]
    / "root"
    / "usr"
    / "share"
    / "selkies"
    / "selkies-dashboard"
    / "src"
    / "selkies-runtime-overrides.js"
)
sys.path.insert(0, str(BRIDGE_PATH.parent))


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

    def test_auto_split_uses_strict_four_to_three_thresholds(self):
        source = RUNTIME_PATH.read_text(encoding="utf-8")

        self.assertIn("function selectAutoSplitLayout(pageWidth, pageHeight)", source)
        self.assertIn("width * 3 > height * 4", source)
        self.assertIn("height * 3 > width * 4", source)
        self.assertIn('mode: "fullscreen"', source)

    def test_bottom_bar_split_button_runs_auto_layout_directly_when_enabled(self):
        source = RUNTIME_PATH.read_text(encoding="utf-8")
        handler = source[source.index('if (action === "split-toggle")') :]
        handler = handler[: handler.index('if (action === "split-lr")')]

        self.assertIn("if (autoSplitEnabled)", handler)
        self.assertIn("getCurrentPageSize()", handler)
        self.assertIn("selectAutoSplitLayout(pageSize.width, pageSize.height)", handler)
        self.assertIn('"python3 /scripts/window_tiler.py split --mode " + layout.mode', handler)
        self.assertLess(handler.index("if (autoSplitEnabled)"), handler.index("setBottomActionSplitOpen(!bottomActionSplitOpen)"))

    def test_collapsed_bottom_bar_only_keeps_toggle_hit_area(self):
        source = RUNTIME_PATH.read_text(encoding="utf-8")

        self.assertIn("#selkies-bottom-action-dock-shell[data-collapsed='1']{width:30px;pointer-events:none}", source)
        self.assertIn(
            "#selkies-bottom-action-dock-shell[data-collapsed='1'] #selkies-bottom-dock-collapsed-toggle"
            "{opacity:1;transform:translateX(-50%) translateY(0) scale(1);pointer-events:auto}",
            source,
        )


if __name__ == "__main__":
    unittest.main()
