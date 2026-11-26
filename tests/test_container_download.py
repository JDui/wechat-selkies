import importlib.util
import io
import json
import tempfile
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


class FakeHandler:
    def __init__(self):
        self.status = None
        self.headers = {}
        self.body = io.BytesIO()
        self.wfile = self.body
        self.connection = mock.Mock()
        self.close_connection = False
        self.json_error = None

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.headers[key] = value

    def end_headers(self):
        pass

    def send_json(self, status, payload):
        self.status = status
        self.json_error = payload


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

    def test_submit_delegates_source_copy_to_rust_sidecar(self):
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

    def test_stream_verifies_rust_job_and_reports_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            self.manager.cache_root = Path(directory)
            job_id = "axi-drop-" + "c" * 48
            token = "test-token"
            data = b"video-content"
            (self.manager.cache_root / (job_id + ".data")).write_bytes(data)
            verify = {"id": job_id, "name": "video.mp4", "size": len(data)}
            with mock.patch.object(self.manager, "_sidecar_request", side_effect=[
                (200, verify),
                (200, {"ok": True}),
            ]) as request:
                handler = FakeHandler()
                self.manager.stream(handler, "sid_test", job_id, token)
            self.assertEqual(handler.status, 200)
            self.assertEqual(handler.body.getvalue(), data)
            self.assertEqual(handler.headers["Content-Length"], str(len(data)))
            finish = request.call_args_list[-1]
            self.assertTrue(finish.kwargs["payload"]["success"])
            self.assertEqual(finish.kwargs["payload"]["token"], token)

    def test_stream_rejects_expired_rust_job(self):
        with mock.patch.object(self.manager, "_sidecar_request", side_effect=module.DownloadError("download-expired")):
            handler = FakeHandler()
            self.manager.stream(handler, "sid_test", "axi-drop-" + "d" * 48, "bad")
        self.assertEqual(handler.status, 410)
        self.assertEqual(handler.json_error["error"], "download-expired")


if __name__ == "__main__":
    unittest.main()
