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
UPLOADER = BRIDGE.parents[1] / "uploader" / "uploader.js"


class UploaderBridgeTests(unittest.TestCase):
    def test_existing_file_input_is_transparently_intercepted(self):
        source = BRIDGE.read_text(encoding="utf-8")

        self.assertIn('document.addEventListener("change"', source)
        self.assertIn('input.type !== "file"', source)
        self.assertIn("event.stopImmediatePropagation()", source)
        self.assertIn("relayFiles(input.files)", source)

    def test_bridge_uses_an_in_page_panel_instead_of_a_popup_launcher(self):
        source = BRIDGE.read_text(encoding="utf-8")

        self.assertNotIn("window.open", source)
        self.assertIn("__selkiesOpenUploaderPanel", source)
        self.assertIn("ensureUploaderPanel", source)
        self.assertIn("document.createElement(\"iframe\")", source)
        self.assertIn("panelRoot.hidden = true", source)
        self.assertIn("var pendingTransfers = new Map()", source)
        self.assertIn("pendingTransfers.set(transfer.transferId, transfer)", source)
        self.assertIn("Array.from(pendingTransfers.values())", source)
        self.assertIn("flushPendingTransfers()", source)
        self.assertNotIn("var pendingTransfer = null", source)

        uploader_source = UPLOADER.read_text(encoding="utf-8")
        self.assertIn('new Worker("upload-worker.js?v=1.54")', uploader_source)

    def test_fallback_leaves_file_events_for_the_native_path(self):
        source = BRIDGE.read_text(encoding="utf-8")

        self.assertIn("legacy_upload_fallback_enabled", source)
        self.assertIn("if (!shouldUseStandaloneUpload()) return;", source)
        self.assertIn("__selkiesSetLegacyUploadFallback", source)
        self.assertIn("event.preventDefault()", source)
        self.assertIn("event.stopImmediatePropagation()", source)

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
