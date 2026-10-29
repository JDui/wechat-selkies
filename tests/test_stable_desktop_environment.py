import importlib.util
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "root/scripts/stable-desktop-environment.py"
spec = importlib.util.spec_from_file_location("stable_environment", SOURCE)
env = importlib.util.module_from_spec(spec)
spec.loader.exec_module(env)


class StableEnvironment(unittest.TestCase):
    def test_existing_ids_survive_container_replacement(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "config/.xwechat").mkdir(parents=True)
            env.atomic_write(root / "etc/machine-id", "a" * 32)
            env.atomic_write(root / "var/lib/dbus/machine-id", "b" * 32)
            env.stabilize(root)
            env.atomic_write(root / "etc/machine-id", "c" * 32)
            env.atomic_write(root / "var/lib/dbus/machine-id", "d" * 32)
            env.stabilize(root)
            self.assertEqual(env.valid_id(root / "etc/machine-id"), "a" * 32)
            self.assertEqual(env.valid_id(root / "var/lib/dbus/machine-id"), "b" * 32)

    def test_fresh_config_gets_persistent_unique_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env.atomic_write(root / "etc/machine-id", "a" * 32)
            env.stabilize(root)
            first = env.valid_id(root / "etc/machine-id")
            self.assertNotEqual(first, "a" * 32)
            env.stabilize(root)
            self.assertEqual(env.valid_id(root / "etc/machine-id"), first)

    def test_corrupt_saved_identity_fails_without_rotating(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env.atomic_write(root / "config/.system-identity/machine-id", "bad")
            with self.assertRaises(RuntimeError):
                env.stabilize(root)


if __name__ == "__main__":
    unittest.main()
