import http.client
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "root/scripts"
sys.path.insert(0, str(SCRIPTS))
from container_download import Downloads, DownloadError, default_source_roots, error_details


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.sid = ("one", 1)
        self.client = "a" * 32
        self.env = patch.dict(os.environ, {"SELKIES_DROP_CACHE": str(self.root / "cache"),
                 "SELKIES_DROP_SOURCE_ROOTS": str(self.source), "SELKIES_DROP_MIN_FREE_BYTES": "0"})
        self.env.start()
        self.manager = Downloads(lambda: self.sid)
        self.manager.configure(self.sid, self.client, [0, 0, 100, 50])

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def ready(self, name="测试.txt", content=b"unchanged"):
        source = self.source / name
        source.write_bytes(content)
        self.manager.submit([(str(source), len(content))], self.manager.current())
        until = time.monotonic() + 3
        while time.monotonic() < until:
            job = list(self.manager.jobs.values())[-1]
            if job["state"] != "preparing":
                self.assertEqual(job["state"], "ready", job)
                return source, job
            time.sleep(.01)
        self.fail("copy timeout")

    def test_copy_limits_and_paths(self):
        source, job = self.ready()
        self.assertEqual((self.manager.root / (job["id"] + ".data")).read_bytes(), source.read_bytes())
        (self.root / "outside").write_bytes(b"private")
        with self.assertRaises(DownloadError):
            self.manager.open_source(str(self.root / "outside"))
        if os.name == "posix":
            link = self.source / "alias"
            link.symlink_to(self.root)
            with self.assertRaises(DownloadError):
                self.manager.open_source(str(link / "cache" / (job["id"] + ".data")))
        with self.assertRaises(DownloadError):
            self.manager.submit([(str(source), 9)] * 2, self.manager.current())
        self.manager.max_jobs = 1
        with self.assertRaises(DownloadError):
            self.manager.submit([(str(source), 9)], self.manager.current())

    def test_default_chat_attachment_roots_exclude_databases(self):
        home = self.root / "home"
        profile = home / ".config/QQ/nt_qq_example/nt_data"
        (profile / "File").mkdir(parents=True)
        (profile / "Pic").mkdir()
        (profile / "Emoji").mkdir()
        (profile / "mmkv").mkdir()
        roots = default_source_roots(home)
        self.assertIn((home / "xwechat_files").resolve(), roots)
        self.assertIn((profile / "File").resolve(), roots)
        self.assertIn((profile / "Pic").resolve(), roots)
        self.assertIn((profile / "Emoji").resolve(), roots)
        self.assertFalse(any((profile / "mmkv/account.db").resolve().is_relative_to(root) for root in roots))
        # Explicit overrides continue to be exact: never silently expand them.
        self.assertFalse(self.manager.use_default_roots)
        (home / "xwechat_files").mkdir()
        for attachment in (home / "xwechat_files/sample.txt", profile / "File/sample.txt", profile / "Emoji/sample.gif"):
            attachment.write_bytes(b"chat attachment")
            with patch("container_download.default_source_roots", return_value=roots):
                self.manager.use_default_roots = True
                stream, _ = self.manager.open_source(str(attachment))
                with stream:
                    self.assertEqual(stream.read(), b"chat attachment")
        (profile / "mmkv/account.db").write_bytes(b"private")
        with patch("container_download.default_source_roots", return_value=roots), self.assertRaises(DownloadError):
            self.manager.open_source(str(profile / "mmkv/account.db"))
        self.manager.use_default_roots = False

    def test_failure_reasons_are_distinct_and_do_not_expose_paths(self):
        missing = error_details(FileNotFoundError("private filename"))
        scope = error_details(DownloadError("source-outside-allowed-roots"))
        size = error_details(DownloadError("size-limit"))
        self.assertEqual(missing[0], "source-missing")
        self.assertNotEqual(scope, size)
        self.assertNotIn("private filename", missing[1])

    def test_expiry_active_cleanup_restart_and_takeover(self):
        _, job = self.ready()
        target = self.manager.root / (job["id"] + ".data")
        job.update(active=1, expires=0)
        self.manager.sweep()
        self.assertTrue(target.exists())
        job["active"] = 0
        self.manager.sweep()
        self.assertFalse(target.exists())
        _, job = self.ready()
        self.sid = ("two", 2)
        self.assertIsNone(self.manager.current())
        self.manager.sweep()
        self.assertFalse(self.manager.jobs)
        orphan = self.manager.root / ("axi-drop-" + "a" * 48 + ".part")
        orphan.write_bytes(b"incomplete")
        Downloads(lambda: self.sid)
        self.assertFalse(orphan.exists())

    def test_cache_requires_dedicated_directory(self):
        shared = self.root / "shared"
        shared.mkdir()
        file = shared / "other-service.part"
        file.write_bytes(b"keep")
        mode = shared.stat().st_mode
        with patch.dict(os.environ, {"SELKIES_DROP_CACHE": str(shared)}), self.assertRaises(DownloadError):
            Downloads(lambda: self.sid)
        self.assertEqual(file.read_bytes(), b"keep")
        self.assertEqual(shared.stat().st_mode, mode)
        (shared / ".selkies-drop-cache-v1").write_text("selkies native download cache v1\n")
        with patch.dict(os.environ, {"SELKIES_DROP_CACHE": str(shared)}), self.assertRaises(DownloadError):
            Downloads(lambda: self.sid)
        self.assertEqual(shared.stat().st_mode, mode)
        self.assertEqual(file.read_bytes(), b"keep")

    def test_hidden_page_releases_only_its_lease(self):
        self.manager.configure(self.sid, self.client, None)
        other = "b" * 32
        self.manager.configure(self.sid, other, [0, 0, 50, 50])
        self.manager.configure(self.sid, self.client, None)
        self.assertEqual(self.manager.current()[1], other)

    def test_limit_failure_and_interrupted_stream(self):
        self.manager.max_file = 1
        source = self.source / "limited.txt"
        source.write_bytes(b"too large")
        self.manager.submit([(str(source), 9)], self.manager.current())
        deadline = time.monotonic() + 3
        while any(j["state"] == "preparing" for j in self.manager.jobs.values()) and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(next(iter(self.manager.jobs.values()))["state"], "error")
        error_id = self.manager.status(self.sid, self.client)["error_id"]
        self.assertTrue(error_id)
        # Cache/job reclamation must not make the same error a new UI notice.
        for job in self.manager.jobs.values():
            job["expires"] = 0
        self.manager.sweep()
        self.assertEqual(self.manager.status(self.sid, self.client)["error_id"], error_id)
        self.assertFalse(list(self.manager.root.glob("*.part")))
        self.manager.max_file = 1024
        _, job = self.ready()
        class BrokenStream:
            def write(self, chunk):
                raise BrokenPipeError()
        class Handler:
            wfile = BrokenStream()
            connection = type("Connection", (), {"settimeout": lambda *args: None})()
            def send_response(self, status): pass
            def send_header(self, *args): pass
            def end_headers(self): pass
        self.manager.stream(Handler(), self.sid, job["id"], job["token"])
        self.assertEqual(job["state"], "ready")
        self.assertFalse(job["used"])
        self.assertEqual(job["active"], 0)

    def test_protected_stream(self):
        spec = importlib.util.spec_from_file_location("auth_test", SCRIPTS / "session_auth_bridge.py")
        bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bridge)
        bridge.DOWNLOADS = self.manager
        bridge.download_identity = lambda: self.sid
        bridge.request_has_valid_session = lambda handler: handler.headers.get("Cookie") == "valid"
        server = bridge.http.server.ThreadingHTTPServer(("127.0.0.1", 0), bridge.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            source, job = self.ready('测试"\r\n.txt')
            def get(token=None, cookie="valid"):
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                connection.request("GET", "/dock-download/file/" + job["id"] + "?token=" + (token or job["token"]), headers={"Cookie": cookie})
                response = connection.getresponse()
                result = response.status, dict(response.getheaders()), response.read()
                connection.close()
                return result
            self.assertEqual(get(cookie="stale")[0], 401)
            self.assertEqual(get(token="wrong")[0], 410)
            job["expires"] = 0
            self.assertEqual(get()[0], 410)
            job["expires"] = time.time() + 60
            previous = self.sid
            self.sid = ("takeover", 2)
            self.assertEqual(get()[0], 410)
            self.sid = previous
            status, headers, content = get()
            self.assertEqual(status, 200)
            self.assertEqual(content, source.read_bytes())
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertIn("filename*=UTF-8''", headers["Content-Disposition"])
            self.assertNotIn("%0D", headers["Content-Disposition"])
            self.assertEqual(get()[0], 410)
            self.assertEqual(job["state"], "sent")
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
