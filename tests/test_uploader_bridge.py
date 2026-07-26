from pathlib import Path
import unittest


BRIDGE = (
    Path(__file__).parents[1]
    / "root"
    / "usr"
    / "share"
    / "selkies"
    / "selkies-dashboard"
    / "src"
    / "selkies-uploader-bridge.js"
)


class UploaderBridgeTests(unittest.TestCase):
    def test_existing_file_input_is_transparently_intercepted(self):
        source = BRIDGE.read_text(encoding="utf-8")

        self.assertIn('document.addEventListener("change"', source)
        self.assertIn('input.type !== "file"', source)
        self.assertIn("event.stopImmediatePropagation()", source)
        self.assertIn("relayFiles(input.files)", source)

    def test_bridge_does_not_render_a_standalone_launcher(self):
        source = BRIDGE.read_text(encoding="utf-8")

        self.assertNotIn("selkies-uploader-launcher", source)
        self.assertNotIn("ensureLauncher", source)
        self.assertNotIn('document.createElement("button")', source)


if __name__ == "__main__":
    unittest.main()
