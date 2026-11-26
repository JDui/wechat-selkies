import importlib.util
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "container_download_adapter",
    ROOT / "root/scripts/container_download.py",
)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class DownloadAdapterTests(unittest.TestCase):
    def setUp(self):
        self.identity = ("sid_test", 42)
        self.manager = module.Downloads(lambda: self.identity)
        self.client = "a" * 32
        self.manager.configure(self.identity[0], self.client, [10, 20, 640, 480])

    def test_geometry_lease_is_session_scoped(self):
        self.assertEqual(self.manager.geometry(), [10, 20, 640, 480])
        self.identity = ("sid_other", 43)
        self.assertIsNone(self.manager.geometry())

    def test_submit_delegates_copy_and_validation_to_rust(self):
        result = {"id": "axi-drop-" + "a" * 48, "state": "preparing"}
        with mock.patch.object(self.manager, "_sidecar_request", return_value=(202, result)) as request:
            job_id = self.manager.submit([("/config/Downloads/video.mp4", 1234)], self.manager.current())
        self.assertEqual(job_id, result["id"])
        self.assertEqual(request.call_args.args[0], "/native-download/jobs")
        payload = request.call_args.kwargs["payload"]
        self.assertEqual(payload["source"], "/config/Downloads/video.mp4")
        self.assertEqual(payload["session_id"], "sid_test")
        self.assertEqual(payload["session_epoch"], 42)
        self.assertEqual(payload["client"], self.client)
        self.assertEqual(self.manager.phase, "preparing")

    def test_submit_rejects_stale_lease_and_multiple_files(self):
        with self.assertRaises(module.DownloadError):
            self.manager.submit([("/config/Downloads/a", 1), ("/config/Downloads/b", 2)], self.manager.current())
        self.identity = ("sid_replaced", 43)
        with self.assertRaises(module.DownloadError):
            self.manager.submit([("/config/Downloads/a", 1)], ("sid_test", self.client, 0, [0, 0, 10, 10]))

    def test_status_merges_rust_jobs_with_native_receiver_state(self):
        payload = {
            "ok": True,
            "jobs": [{
                "id": "axi-drop-" + "b" * 48,
                "state": "ready",
                "name": "video.mp4",
                "size": 1234,
                "error": "",
                "token": "token",
            }],
        }
        with mock.patch.object(self.manager, "_sidecar_request", return_value=(200, payload)):
            status = self.manager.status("sid_test", self.client)
        self.assertTrue(status["ok"])
        self.assertFalse(status["native_ready"])
        self.assertEqual(status["phase"], "idle")
        self.assertEqual(status["jobs"][0]["token"], "token")

    def test_adapter_has_no_python_copy_or_stream_worker(self):
        self.assertFalse(hasattr(self.manager, "copy"))
        self.assertFalse(hasattr(self.manager, "open_source"))
        self.assertFalse(hasattr(self.manager, "stream"))
        self.assertFalse(hasattr(self.manager, "sweep"))

    def test_sidecar_errors_keep_specific_user_facing_reason(self):
        self.assertEqual(module.error_details(module.DownloadError("size-limit"))[0], "size-limit")
        self.assertIn("临时缓存", module.error_details(module.DownloadError("size-limit"))[1])


if __name__ == "__main__":
    unittest.main()
