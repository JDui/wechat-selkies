import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock


BRIDGE_PATH = (
    Path(__file__).resolve().parents[1] / "root" / "scripts" / "session_auth_bridge.py"
)
MIN_MAX_BYTES = 64 * 1024


class DiagnosticsRotationTests(unittest.TestCase):
    def load_bridge(self, temporary, extra_environment=None):
        state_path = Path(temporary) / "session.json"
        diagnostics_path = Path(temporary) / "diagnostics.jsonl"
        state_path.write_text(
            json.dumps({"session_id": "sid_test", "session_epoch": 42}),
            encoding="utf-8",
        )
        environment = {
            "PASSWORD": "123456",
            "SELKIES_SESSION_STATE_PATH": str(state_path),
            "SELKIES_UPLOAD_DIAGNOSTICS_LOG_PATH": str(diagnostics_path),
            "SELKIES_UPLOAD_DIAGNOSTICS_MAX_BYTES": str(MIN_MAX_BYTES),
            "SELKIES_UPLOAD_DIAGNOSTICS_ARCHIVES": "2",
        }
        environment.update(extra_environment or {})
        with mock.patch.dict(os.environ, environment, clear=False):
            spec = importlib.util.spec_from_file_location(
                "session_auth_bridge_diagnostics_test", BRIDGE_PATH
            )
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        return module, diagnostics_path

    def read_lines(self, path):
        if not path.exists():
            return []
        return [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_heartbeat_only_payload_is_not_written(self):
        with tempfile.TemporaryDirectory() as temporary:
            bridge, diagnostics_path = self.load_bridge(temporary)
            bridge.append_diagnostics({"records": [{"event": "browser-sample", "jsHeapUsedBytes": 1}]})
            bridge.append_diagnostics({"records": [{"event": "upload-worker-sample", "value": 2}]})
            self.assertFalse(diagnostics_path.exists())

    def test_real_events_survive_sample_filtering(self):
        with tempfile.TemporaryDirectory() as temporary:
            bridge, diagnostics_path = self.load_bridge(temporary)
            bridge.append_diagnostics(
                {
                    "records": [
                        {"event": "browser-sample", "jsHeapUsedBytes": 1},
                        {"event": "websocket-close", "code": 1006},
                        {"event": "browser-sample", "jsHeapUsedBytes": 2},
                    ]
                }
            )
            lines = self.read_lines(diagnostics_path)
            self.assertEqual(len(lines), 1)
            records = lines[0]["metrics"]["records"]
            self.assertEqual([record["event"] for record in records], ["websocket-close"])
            self.assertEqual(lines[0]["metrics"]["droppedSamples"], 2)

    def test_keep_samples_flag_retains_heartbeats(self):
        with tempfile.TemporaryDirectory() as temporary:
            bridge, diagnostics_path = self.load_bridge(
                temporary, {"SELKIES_UPLOAD_DIAGNOSTICS_KEEP_SAMPLES": "true"}
            )
            bridge.append_diagnostics({"records": [{"event": "browser-sample", "jsHeapUsedBytes": 1}]})
            lines = self.read_lines(diagnostics_path)
            self.assertEqual(len(lines), 1)
            self.assertEqual(lines[0]["metrics"]["records"][0]["event"], "browser-sample")

    def test_active_file_rotates_before_exceeding_cap(self):
        with tempfile.TemporaryDirectory() as temporary:
            bridge, diagnostics_path = self.load_bridge(temporary)
            payload = {"records": [{"event": "upload-task-status", "blob": "x" * MIN_MAX_BYTES}]}
            bridge.append_diagnostics(payload)
            bridge.append_diagnostics(payload)
            archive = diagnostics_path.with_name(diagnostics_path.name + ".1")
            self.assertTrue(archive.exists(), "rotation should archive the oversized active file")
            self.assertLess(diagnostics_path.stat().st_size, MIN_MAX_BYTES * 2)

    def test_archive_count_is_bounded(self):
        with tempfile.TemporaryDirectory() as temporary:
            bridge, diagnostics_path = self.load_bridge(temporary)
            payload = {"records": [{"event": "upload-task-status", "blob": "x" * MIN_MAX_BYTES}]}
            for _ in range(6):
                bridge.append_diagnostics(payload)
            archives = sorted(
                entry.name
                for entry in diagnostics_path.parent.iterdir()
                if entry.name.startswith(diagnostics_path.name + ".")
            )
            self.assertEqual(
                archives,
                [diagnostics_path.name + ".1", diagnostics_path.name + ".2"],
            )

    def test_day_stamped_archives_are_not_mistaken_for_size_archives(self):
        with tempfile.TemporaryDirectory() as temporary:
            bridge, diagnostics_path = self.load_bridge(temporary)
            today = time.strftime("%Y%m%d")
            day_archive = diagnostics_path.with_name(diagnostics_path.name + "." + today)
            day_archive.write_text("stale\n", encoding="utf-8")
            payload = {"records": [{"event": "upload-task-status", "blob": "x" * MIN_MAX_BYTES}]}
            for _ in range(4):
                bridge.append_diagnostics(payload)
            self.assertTrue(day_archive.exists(), "today's day archive must survive size rotation")
            self.assertTrue(
                diagnostics_path.with_name(diagnostics_path.name + ".1").exists(),
                "size archive must coexist with the day archive",
            )

    def test_expired_day_stamped_archives_are_pruned(self):
        with tempfile.TemporaryDirectory() as temporary:
            bridge, diagnostics_path = self.load_bridge(temporary)
            stale = diagnostics_path.with_name(diagnostics_path.name + ".20200101")
            stale.write_text("stale\n", encoding="utf-8")
            bridge.append_diagnostics({"records": [{"event": "websocket-close", "code": 1006}]})
            self.assertFalse(stale.exists())


if __name__ == "__main__":
    unittest.main()
