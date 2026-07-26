from pathlib import Path
import unittest


RUNTIME_OVERRIDES = (
    Path(__file__).parents[1]
    / "root"
    / "usr"
    / "share"
    / "selkies"
    / "selkies-dashboard"
    / "src"
    / "selkies-runtime-overrides.js"
)


class ImeInputGuardTests(unittest.TestCase):
    def test_composition_updates_are_not_forwarded_as_committed_text(self):
        source = RUNTIME_OVERRIDES.read_text(encoding="utf-8")

        self.assertIn("__selkiesCompositionGuardInstalled", source)
        self.assertIn("event.isComposing", source)
        self.assertIn("imeCompositionActive", source)
        self.assertIn("event.stopImmediatePropagation()", source)

    def test_committed_composition_has_a_single_fallback_flush(self):
        source = RUNTIME_OVERRIDES.read_text(encoding="utf-8")

        self.assertIn('"compositionend"', source)
        self.assertIn("String(event.data || \"\")", source)
        self.assertIn("imeFinalInputSeen", source)
        self.assertIn("if (finalInputSeen) return", source)
        self.assertIn('typeof input._typeString !== "function"', source)
        self.assertIn("input._typeString(value)", source)
        self.assertIn('assist.value = ""', source)


if __name__ == "__main__":
    unittest.main()
