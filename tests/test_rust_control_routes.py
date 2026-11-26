import unittest
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

    def test_local_link_shell_port_expansion_is_balanced(self):
        helper = self.read("root/scripts/local-link-open-helper.sh")
        self.assertIn(
            'local port="${SELKIES_UPLOAD_PORT:-${SELKIES_CONTAINER_SLEEP_PORT:-${LOCAL_LINK_BRIDGE_PORT:-38084}}}"',
            helper,
        )


if __name__ == "__main__":
    unittest.main()
