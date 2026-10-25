import unittest

from tests.ime_container_stress import host_main


class IMEFirstCharacterBackendTests(unittest.TestCase):
    def test_fresh_focus_existing_text_and_held_key_boundaries(self):
        result = host_main("wechat-selkies:1.73", first_character=True)
        self.assertEqual(result, 0)


if __name__ == "__main__":
    unittest.main()
