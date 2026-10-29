import unittest
import os
from tests.ime_xtest_container_probe import docker_has_image

from tests.ime_container_stress import host_main


IMAGE = os.environ.get("SELKIES_TEST_IMAGE", "wechat-selkies:1.75")

@unittest.skipUnless(docker_has_image(IMAGE), f"{IMAGE} not available locally")
class IMEFirstCharacterBackendTests(unittest.TestCase):
    def test_fresh_focus_existing_text_and_held_key_boundaries(self):
        result = host_main(IMAGE, first_character=True)
        self.assertEqual(result, 0)


if __name__ == "__main__":
    unittest.main()
