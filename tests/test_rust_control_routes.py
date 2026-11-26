import unittest
import importlib.util
import json
import http.client
import threading
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class RustControlRouteTests(unittest.TestCase):
    def read(self, relative):
        return (ROOT / relative).read_text(encoding="utf-8")

    def test_session_auth_endpoints_are_owned_by_rust(self):
        nginx = self.read("root/defaults/default.conf")
        rust = self.read("upload-sidecar/src/lib.rs")
        bridge = self.read("root/scripts/session_auth_bridge.py")
        for route in [
            "auth/check", "auth/pin", "auth/logout",
            "auth/session", "auth/upload-token",
        ]:
            self.assertIn(f"/{route}", rust)
        self.assertNotIn('if path == "/check":', bridge)
        self.assertNotIn('if path == "/pin":', bridge)
        self.assertNotIn('if path == "/logout":', bridge)
        self.assertNotIn('if path == "/session":', bridge)
        self.assertNotIn('if path == "/upload-token":', bridge)
        self.assertIn("CUPLOAD/auth/check", nginx)
        self.assertIn("CUPLOAD/auth/pin", nginx)
        self.assertIn("CUPLOAD/auth/upload-token", nginx)
        self.assertIn("CUPLOAD/auth/session", nginx)
        self.assertIn("CAUTH/dock-download/state", nginx)
        self.assertIn('if path == "/dock-download/state":', bridge)

    def test_preferences_api_is_served_by_rust_sidecar(self):
        nginx = self.read("root/defaults/default.conf")
        rust = self.read("upload-sidecar/src/lib.rs")
        auth = self.read("root/scripts/session_auth_bridge.py")
        self.assertEqual(nginx.count("proxy_pass http://127.0.0.1:CUPLOAD/preferences;"), 2)
        self.assertIn('.route("/preferences", get(preferences_get).post(preferences_update))', rust)
        self.assertNotIn('if path == "/preferences":', auth)
        self.assertNotIn("def read_preferences(", auth)
        self.assertNotIn("def update_preferences(", auth)

    def test_local_link_polling_is_prefixed_to_rust_route(self):
        nginx = self.read("root/defaults/default.conf")
        rust = self.read("upload-sidecar/src/lib.rs")
        helper = self.read("root/scripts/local-link-open-helper.sh")
        self.assertEqual(nginx.count("proxy_pass              http://127.0.0.1:CLINK/local-link/;"), 2)
        self.assertIn('.route("/local-link/push", post(local_link_push))', rust)
        self.assertIn('.route("/local-link/pull", get(local_link_pull))', rust)
        self.assertIn('/local-link/push', helper)
        self.assertIn('Content-Type", "application/json"', helper)

    def test_sleep_routes_are_served_by_the_runtime_sidecar(self):
        nginx = self.read("root/defaults/default.conf")
        rust = self.read("upload-sidecar/src/lib.rs")
        service = self.read("root/etc/s6-overlay/s6-rc.d/svc-runtime-sidecar/run")
        self.assertIn("127.0.0.1:CSLEEP/sleep/status", nginx)
        self.assertIn("127.0.0.1:CSLEEP/sleep/", nginx)
        self.assertIn('.route("/sleep/status", get(sleep_status))', rust)
        self.assertIn("selkies-upload-sidecar", service)

    def test_runtime_paths_and_healthcheck_match_single_sidecar(self):
        docker = self.read("Dockerfile")
        compose = self.read("docker-compose.yml")
        health = self.read("root/scripts/healthcheck.sh")
        watchdog = self.read("root/scripts/process-watchdog.sh")
        for path in ("/run/selkies-runtime/active-session.json", "/run/selkies-runtime/container-sleep.json"):
            self.assertIn(path, docker)
            self.assertIn(path, compose)
        self.assertIn("${runtime_port}/health", health)
        self.assertNotIn("38083", health)
        self.assertNotIn("container_sleep_manager.py", watchdog)

    def test_download_state_parses_real_http_query(self):
        path = ROOT / "root/scripts/session_auth_bridge.py"
        spec = importlib.util.spec_from_file_location("runtime_bridge_test", path)
        bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bridge)
        identity = ("sid_test", 42)
        manager = mock.Mock()
        manager.status.return_value = {"ok": True, "jobs": []}
        with mock.patch.object(bridge, "DOWNLOADS", manager), \
             mock.patch.object(bridge, "download_identity", return_value=identity), \
             mock.patch.object(bridge, "request_has_valid_session", return_value=True):
            server = bridge.http.server.ThreadingHTTPServer(("127.0.0.1", 0), bridge.Handler)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                connection.request("GET", "/dock-download/state?client=client123")
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertTrue(json.loads(response.read())["ok"])
                connection.close()
                manager.status.assert_called_once_with(identity, "client123")
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=3)

    def test_local_link_shell_port_expansion_is_balanced(self):
        helper = self.read("root/scripts/local-link-open-helper.sh")
        self.assertIn(
            'local port="${SELKIES_UPLOAD_PORT:-${SELKIES_CONTAINER_SLEEP_PORT:-${LOCAL_LINK_BRIDGE_PORT:-38084}}}"',
            helper,
        )


if __name__ == "__main__":
    unittest.main()
