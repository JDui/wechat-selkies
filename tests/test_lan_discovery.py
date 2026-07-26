import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


SCRIPTS = Path(__file__).parents[1] / "root" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from lan_discovery_common import (  # noqa: E402
    DEFAULT_BROADCAST_NAME,
    SERVICE_TYPE,
    build_identity_payload,
    is_valid_broadcast_name,
    read_discovery_state,
    sanitize_broadcast_name,
)
import notification_bridge  # noqa: E402


class LanDiscoveryTests(unittest.TestCase):
    def test_broadcast_name_is_uppercase_and_constrained(self):
        self.assertEqual(sanitize_broadcast_name(" axisnsbox-123 "), "AXISNSBOX-123")
        self.assertTrue(is_valid_broadcast_name("BOX_01"))
        self.assertFalse(is_valid_broadcast_name("box.local"))
        self.assertEqual(sanitize_broadcast_name("bad name"), DEFAULT_BROADCAST_NAME)

    def test_missing_state_defaults_to_disabled(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state = read_discovery_state(Path(temp_dir) / "missing.json")
        self.assertFalse(state["lan_discovery_enabled"])
        self.assertEqual(state["lan_broadcast_name"], DEFAULT_BROADCAST_NAME)

    def test_shared_state_controls_discovery(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "state.json"
            path.write_text(
                json.dumps(
                    {
                        "mode": "internal",
                        "lan_discovery_enabled": True,
                        "lan_broadcast_name": "livingroom-01",
                    }
                ),
                encoding="utf-8",
            )
            state = read_discovery_state(path)
        self.assertTrue(state["lan_discovery_enabled"])
        self.assertEqual(state["lan_broadcast_name"], "LIVINGROOM-01")

    def test_identity_payload_uses_advertised_ports(self):
        with mock.patch.dict(
            os.environ,
            {
                "SELKIES_LAN_ADVERTISE_HTTP_PORT": "3100",
                "SELKIES_LAN_ADVERTISE_HTTPS_PORT": "3101",
                "SUBFOLDER": "/wechat",
            },
            clear=False,
        ):
            payload = build_identity_payload(
                {
                    "lan_discovery_enabled": True,
                    "lan_broadcast_name": "AXISNSBOX-007",
                }
            )
        self.assertEqual(payload["service_type"], SERVICE_TYPE)
        self.assertEqual(payload["http_port"], 3100)
        self.assertEqual(payload["https_port"], 3101)
        self.assertEqual(payload["path"], "/wechat/")

    def test_notification_bridge_persists_sidebar_settings(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "notification-bridge.json"
            status_path = Path(temp_dir) / "lan-discovery-status.json"
            with mock.patch.object(notification_bridge, "MODE_STATE_PATH", state_path), mock.patch.object(
                notification_bridge,
                "LAN_DISCOVERY_STATUS_PATH",
                status_path,
            ):
                notification_bridge.write_mode_state(
                    lan_discovery_enabled=True,
                    lan_broadcast_name="office-box",
                )
                payload = notification_bridge.current_state_payload()
        self.assertTrue(payload["lan_discovery_enabled"])
        self.assertEqual(payload["lan_broadcast_name"], "OFFICE-BOX")

    def test_compose_and_frontend_include_discovery_controls(self):
        repo = Path(__file__).parents[1]
        compose = (repo / "docker-compose.yml").read_text(encoding="utf-8")
        frontend = (
            repo
            / "root"
            / "usr"
            / "share"
            / "selkies"
            / "selkies-dashboard"
            / "src"
            / "selkies-runtime-overrides.js"
        ).read_text(encoding="utf-8")
        nginx = (repo / "root" / "defaults" / "default.conf").read_text(encoding="utf-8")
        self.assertIn("axisnsbox-discovery:", compose)
        self.assertIn("network_mode: host", compose)
        self.assertIn('data-debug-toggle="lan-discovery"', frontend)
        self.assertIn('data-debug-input="lan-broadcast-name"', frontend)
        self.assertEqual(nginx.count("location = SUBFOLDER.well-known/axisnsbox"), 2)


if __name__ == "__main__":
    unittest.main()
