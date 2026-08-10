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

    def test_drag_drop_is_routed_to_the_standalone_uploader(self):
        source = BRIDGE.read_text(encoding="utf-8")

        # File drags must be prevented everywhere so the browser cannot navigate
        # to the dropped file (an unload that lands back on the PIN screen).
        self.assertIn('["dragenter", "dragover"].forEach', source)
        self.assertIn("event.dataTransfer.dropEffect = \"copy\"", source)

        # The drop must be captured before the Selkies bundle's legacy handler
        # and handed to the standalone uploader instead of the data channel.
        self.assertIn('document.addEventListener("drop"', source)
        self.assertIn("event.stopImmediatePropagation()", source)
        self.assertIn("relayFiles(files)", source)
        self.assertIn('isFileDrag(event)', source)


if __name__ == "__main__":
    unittest.main()
