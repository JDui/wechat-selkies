from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "root" / "lsiopy" / "lib" / "python3.12" / "site-packages" / "selkies" / "selkies.py"
RUNTIME = ROOT / "root" / "usr" / "share" / "selkies" / "selkies-dashboard" / "src" / "selkies-runtime-overrides.js"
BRIDGE = ROOT / "root" / "usr" / "share" / "selkies" / "selkies-dashboard" / "src" / "selkies-uploader-bridge.js"


class StreamFreezeRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = SERVER.read_text(encoding="utf-8")
        cls.runtime = RUNTIME.read_text(encoding="utf-8")
        cls.bridge = BRIDGE.read_text(encoding="utf-8")

    def test_h264_high_load_preserves_order_and_does_not_prune_on_edge(self):
        self.assertIn('or display_state.get("high_load_active")', self.server)
        self.assertIn('if not self._should_preserve_encoded_frame_order(display_state):', self.server)
        self.assertIn('if old_value == new_value:', self.server)

    def test_high_load_fps_is_independent_from_idle_low_latency_fps(self):
        self.assertIn('DEFAULT_STREAM_LOAD_SEND_FPS = 18.0', self.server)
        self.assertIn('max(12.0,', self.server)
        self.assertIn('display_state["high_load_send_fps"] = max(1.0, min(base_fps, high_load_send_fps))', self.server)
        self.assertNotIn('display_state["high_load_send_fps"] = max(1.0, min(display_state["low_latency_send_fps"]', self.server)
        self.assertIn('target_fps = min(\n                target_fps,\n                float(display_state.get("high_load_send_fps"', self.server)
        self.assertIn("elif display_state.get(\"dynamic_low_latency_active\")", self.server)

    def test_http_sidecar_and_frontend_freeze_guards_are_present(self):
        self.assertIn('transport: "http-sidecar"', self.bridge)
        self.assertIn('if (payload.transport === "http-sidecar")', self.runtime)
        self.assertIn('if (state.transport !== "http-sidecar") setHighLoadState(true, "file upload");', self.runtime)
        self.assertIn('if (window.__selkiesHasActiveFileTransfer && window.__selkiesHasActiveFileTransfer()) return;', self.runtime)

    def test_overlay_and_activity_history_are_throttled(self):
        self.assertIn('window.setInterval(renderAdaptiveSleepOverlay, 1000)', self.runtime)
        self.assertNotIn('overlay.style.backgroundColor =', self.runtime)
        self.assertNotIn('backdrop-filter:blur(2px)', self.bridge)
        self.assertIn('__historySignature', self.runtime)


if __name__ == "__main__":
    unittest.main()
