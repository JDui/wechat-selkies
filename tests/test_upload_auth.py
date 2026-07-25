import base64
import hashlib
import hmac
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


BRIDGE_PATH = (
    Path(__file__).resolve().parents[1] / "root" / "scripts" / "session_auth_bridge.py"
)


def decode_base64url(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


class UploadAuthTests(unittest.TestCase):
    def load_bridge(self, temporary):
        state_path = Path(temporary) / "session.json"
        diagnostics_path = Path(temporary) / "diagnostics.jsonl"
        state_path.write_text(
            json.dumps(
                {
                    "session_id": "sid_test",
                    "session_epoch": 42,
                    "upload_signing_key": "test-signing-key",
                }
            ),
            encoding="utf-8",
        )
        environment = {
            "PASSWORD": "123456",
            "SELKIES_SESSION_STATE_PATH": str(state_path),
            "SELKIES_UPLOAD_DIR": "/config/uploads",
            "SELKIES_UPLOAD_MAX_FILE_SIZE": "4096",
            "SELKIES_UPLOAD_TOKEN_TTL_SECONDS": "120",
            "SELKIES_UPLOAD_DIAGNOSTICS_LOG_PATH": str(diagnostics_path),
        }
        with mock.patch.dict(os.environ, environment, clear=False):
            spec = importlib.util.spec_from_file_location("session_auth_bridge_test", BRIDGE_PATH)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        return module, diagnostics_path

    def test_upload_token_binds_epoch_root_and_limits(self):
        with tempfile.TemporaryDirectory() as temporary:
            bridge, _ = self.load_bridge(temporary)
            token, claims = bridge.issue_upload_token()
            encoded, signature = token.split(".", 1)
            expected = hmac.new(
                b"test-signing-key", encoded.encode("ascii"), hashlib.sha256
            ).digest()
            self.assertTrue(hmac.compare_digest(decode_base64url(signature), expected))
            decoded = json.loads(decode_base64url(encoded))
            self.assertEqual(decoded["sid"], "sid_test")
            self.assertEqual(decoded["epoch"], 42)
            self.assertEqual(decoded["root"], "/config/uploads")
            self.assertEqual(decoded["max_file_size"], 4096)
            self.assertEqual(decoded, claims)
            self.assertNotIn("123456", token)

    def test_diagnostics_are_json_lines(self):
        with tempfile.TemporaryDirectory() as temporary:
            bridge, diagnostics_path = self.load_bridge(temporary)
            bridge.append_diagnostics({"records": [{"event": "long-task", "duration": 250}]})
            record = json.loads(diagnostics_path.read_text(encoding="utf-8"))
            self.assertEqual(record["source"], "browser")
            self.assertEqual(record["metrics"]["records"][0]["event"], "long-task")


if __name__ == "__main__":
    unittest.main()
