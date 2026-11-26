import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock
import urllib.error

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "root/scripts" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class PreferencesAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.bridge = load("session_auth_bridge_preferences_test")
        self.bridge.PREFERENCES_PORT = 38084

    def test_read_preferences_delegates_to_rust_sidecar(self):
        expected = {"encoder": "av1enc", "notification_center_enabled": True}
        with mock.patch.object(
            self.bridge,
            "_preferences_sidecar_json",
            return_value={"ok": True, "preferences": expected},
        ) as request:
            self.assertEqual(self.bridge.read_preferences(), expected)
        request.assert_called_once_with("GET")

    def test_update_preferences_posts_patch_to_rust_sidecar(self):
        patch = {"encoder": "h265enc", "framerate": 45}
        expected = {**patch, "notification_center_enabled": True}
        with mock.patch.object(
            self.bridge,
            "_preferences_sidecar_json",
            return_value={"ok": True, "preferences": expected},
        ) as request:
            self.assertEqual(self.bridge.update_preferences(patch), expected)
        request.assert_called_once_with("POST", patch)

    def test_update_rejects_non_object_patch_before_network_request(self):
        with mock.patch.object(self.bridge, "_preferences_sidecar_json") as request:
            with self.assertRaises(ValueError):
                self.bridge.update_preferences([("encoder", "av1enc")])
        request.assert_not_called()

    def test_sidecar_request_uses_loopback_and_json_without_proxy(self):
        patch = {"bottom_action_dock_position": "top", "notification_center_enabled": False}
        opener = mock.Mock()
        opener.open.return_value = FakeResponse({"ok": True, "preferences": patch})
        with mock.patch.object(self.bridge.urllib.request, "build_opener", return_value=opener) as build:
            result = self.bridge._preferences_sidecar_json("POST", patch)
        self.assertEqual(result["preferences"], patch)
        build.assert_called_once()
        proxy_handler = build.call_args.args[0]
        self.assertEqual(proxy_handler.proxies, {})
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:38084/preferences")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertEqual(json.loads(request.data.decode("utf-8")), patch)

    def test_sidecar_validation_error_is_returned_as_value_error(self):
        opener = mock.Mock()
        opener.open.side_effect = urllib.error.HTTPError(
            "http://127.0.0.1:38084/preferences", 400, "bad request", {}, None
        )
        with mock.patch.object(self.bridge.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(ValueError):
                self.bridge.update_preferences({"encoder": "unknown"})

    def test_sidecar_unavailable_is_returned_as_os_error(self):
        opener = mock.Mock()
        opener.open.side_effect = urllib.error.URLError("connection refused")
        with mock.patch.object(self.bridge.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(OSError):
                self.bridge.read_preferences()


if __name__ == "__main__":
    unittest.main()
