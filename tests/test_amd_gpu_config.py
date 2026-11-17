import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "root/scripts/configure-amd-gpu.py"
spec = importlib.util.spec_from_file_location("amd_gpu", SOURCE)
gpu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gpu)


class AmdGpuConfig(unittest.TestCase):
    def test_auto_skips_other_vendors_and_uses_amd_on_second_node(self):
        nodes = [Path("/dev/dri/renderD128"), Path("/dev/dri/renderD129")]
        with patch.object(Path, "glob", return_value=nodes), \
                patch.object(gpu, "amd_node", side_effect=lambda node: node == nodes[1]), \
                patch.object(gpu, "probe", return_value=(True, "supported")) as probe:
            result = gpu.select({"INTEL_VAAPI_DRIVER": "iHD", "LIBVA_DRIVER_NAME": "iHD"})
        self.assertEqual(result["node"], str(nodes[1]))
        self.assertEqual(result["driver"], "radeonsi")
        self.assertEqual(result["backend"], "amd-vaapi")
        probe.assert_called_once_with(nodes[1], "radeonsi")

    def test_auto_tries_next_amd_but_explicit_device_never_changes(self):
        nodes = [Path("/dev/dri/renderD128"), Path("/dev/dri/renderD129")]
        with patch.object(Path, "glob", return_value=nodes), \
                patch.object(gpu, "amd_node", return_value=True), \
                patch.object(gpu, "probe", side_effect=[(False, "unsupported"), (True, "supported")]):
            result = gpu.select({})
        self.assertEqual(result["node"], str(nodes[1]))
        with patch.object(gpu, "amd_node", return_value=True), \
                patch.object(gpu, "probe", return_value=(False, "unsupported")) as probe:
            result = gpu.select({"DRI_NODE": "/dev/dri/renderD128"})
        self.assertEqual(result["backend"], "cpu")
        self.assertEqual(probe.call_count, 1)

    def test_wrong_explicit_device_does_not_select_another_gpu(self):
        with patch.object(gpu, "amd_node", return_value=False), patch.object(gpu, "probe") as probe:
            result = gpu.select({"DRI_NODE": "/dev/dri/renderD128"})
        self.assertEqual(result["backend"], "cpu")
        probe.assert_not_called()

    def test_cpu_fallback_persists_backend_lock_and_clears_stale_node(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(gpu, "amd_node", return_value=False):
            root = Path(tmp)
            gpu.configure({"DRI_NODE": "/dev/dri/renderD128"}, root / "env", root / "status.json")
            self.assertEqual((root / "env/DRI_NODE").read_text(), "")
            self.assertEqual((root / "env/SELKIES_USE_CPU").read_text(), "true|locked")
            self.assertEqual((root / "env/SELKIES_DEFAULT_USE_CPU").read_text(), "true")

    def test_explicit_cpu_skips_hardware_probe(self):
        for settings in ({"SELKIES_USE_CPU": "true|locked"}, {"SELKIES_DEFAULT_USE_CPU": "true"}):
            with patch.object(gpu, "probe") as probe:
                self.assertEqual(gpu.select(settings)["backend"], "cpu")
                probe.assert_not_called()

    def test_probe_requires_h264_encode_as_streaming_user_and_handles_timeout(self):
        for entry, expected in (("VAEntrypointEncSlice", True), ("VAEntrypointVLD", False),
                                ("VAEntrypointEncSliceLP", False)):
            output = subprocess.CompletedProcess([], 0, f"VAProfileH264Main : {entry}\n", "")
            with patch.object(subprocess, "run", return_value=output) as run:
                ok, _ = gpu.probe(Path("/dev/dri/renderD128"), "radeonsi")
                self.assertEqual(ok, expected)
                self.assertEqual(run.call_args.args[0][:3], ["s6-setuidgid", "abc", "env"])
                self.assertIn("LIBVA_DRIVER_NAME=radeonsi", run.call_args.args[0])
        with patch.object(subprocess, "run", side_effect=subprocess.TimeoutExpired("vainfo", 8)):
            self.assertFalse(gpu.probe(Path("/dev/dri/renderD128"), "radeonsi")[0])

    def test_vendor_and_device_checks(self):
        node = Path("/dev/dri/renderD129")
        with patch.object(Path, "is_char_device", return_value=True):
            for vendor, expected in (("0x1002\n", True), ("0x8086\n", False), ("0x10de\n", False)):
                with patch.object(Path, "read_text", return_value=vendor):
                    self.assertEqual(gpu.amd_node(node), expected)
            with patch.object(Path, "read_text", side_effect=OSError("missing sysfs")):
                self.assertFalse(gpu.amd_node(node))
        with patch.object(Path, "is_char_device", return_value=False):
            self.assertFalse(gpu.amd_node(node))
        self.assertFalse(gpu.amd_node(Path("/dev/dri/card0")))

    def test_success_replaces_inherited_intel_driver_in_service_environment(self):
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(gpu, "amd_node", return_value=True), \
                patch.object(gpu, "probe", return_value=(True, "supported")):
            root = Path(tmp)
            (root / "env").mkdir()
            (root / "env/LIBVA_DRIVER_NAME").write_text("iHD")
            gpu.configure({"DRI_NODE": "/dev/dri/renderD129", "LIBVA_DRIVER_NAME": "iHD"},
                          root / "env", root / "status.json")
            self.assertEqual((root / "env/LIBVA_DRIVER_NAME").read_text(), "radeonsi")
            self.assertEqual((root / "env/DRI_NODE").read_text(), str(Path("/dev/dri/renderD129")))
            self.assertFalse((root / "env/SELKIES_USE_CPU").exists())


if __name__ == "__main__":
    unittest.main()
