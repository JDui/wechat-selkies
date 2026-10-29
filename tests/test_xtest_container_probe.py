"""Native typing correctness and frame ACK regression probe in the real image.

Follows the repository convention of driving a container harness from a thin
test (see tests/test_ime_first_character.py), but skips instead of failing when
Docker or the pinned image is missing, so it stays runnable on any machine.

    SELKIES_TEST_IMAGE=wechat-selkies:1.75 python -m unittest tests.test_xtest_container_probe
"""

import os
import unittest

from tests.ime_xtest_container_probe import CONTAINER_PYTHON, docker_has_image, host_main

IMAGE = os.environ.get("SELKIES_TEST_IMAGE", "wechat-selkies:latest")


@unittest.skipUnless(docker_has_image(IMAGE), f"{IMAGE} is not available locally")
class XTestInjectionContainerTests(unittest.TestCase):
    def test_native_commits_preserve_text_and_keep_frame_acks_flowing(self):
        self.assertEqual(host_main(IMAGE, CONTAINER_PYTHON), 0)


if __name__ == "__main__":
    unittest.main()
