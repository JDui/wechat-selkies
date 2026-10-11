import importlib.util
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock


SCRIPTS_PATH = Path(__file__).resolve().parents[1] / "root" / "scripts"
WRITER_PATH = SCRIPTS_PATH / "size_limited_log_writer.py"
sys.path.insert(0, str(SCRIPTS_PATH))


def load_script(name):
    spec = importlib.util.spec_from_file_location(name + "_log_test", SCRIPTS_PATH / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LogWriterTests(unittest.TestCase):
    def test_pipe_event_is_written_before_more_input_or_eof(self):
        with tempfile.TemporaryDirectory() as temporary:
            log_path = Path(temporary) / "service.log"
            process = subprocess.Popen(
                [sys.executable, "-u", str(WRITER_PATH), str(log_path), "65536"],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            try:
                process.stdin.write(b"single event\n")
                process.stdin.flush()
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    if log_path.exists() and log_path.read_bytes() == b"single event\n":
                        break
                    time.sleep(0.02)
                self.assertTrue(log_path.exists())
                self.assertEqual(log_path.read_bytes(), b"single event\n")
                self.assertIsNone(process.poll(), "the producer pipe must remain open during the check")
            finally:
                process.stdin.close()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
                error = process.stderr.read().decode("utf-8", errors="replace")
                process.stderr.close()
            self.assertEqual(process.returncode, 0, error)

    def test_service_log_stays_bounded_without_trimming_each_append(self):
        writer = load_script("size_limited_log_writer")
        limit = 65536
        chunk = b"latest service event\n" * 64
        with tempfile.TemporaryDirectory() as temporary:
            log_path = Path(temporary) / "service.log"
            log_path.write_bytes(b"x" * limit)
            with log_path.open("a+b", buffering=0) as handle:
                with mock.patch.object(handle, "truncate", wraps=handle.truncate) as truncate:
                    for _ in range(80):
                        writer.trim_existing_log(handle, limit, chunk)
                        handle.seek(0, 2)
                        handle.write(chunk)
                        self.assertLessEqual(handle.tell(), limit)
                    self.assertLess(truncate.call_count, 10)
            self.assertTrue(log_path.read_bytes().endswith(chunk))

    def test_file_failure_keeps_draining_the_producer_pipe(self):
        # Inject the two file failures without depending on disk-full conditions
        # or platform-specific devices, then send more than a pipe buffer holds.
        bootstrap = """
import io
import pathlib
import runpy
import sys
from unittest import mock

class FullDisk(io.BytesIO):
    def write(self, data):
        raise OSError("simulated disk full")

sys.argv = [sys.argv[1], sys.argv[2], "65536"]
failure = sys.argv[1].endswith("open.log")
with mock.patch.object(pathlib.Path, "open", side_effect=OSError("simulated open failure") if failure else None, return_value=FullDisk()):
    runpy.run_path(sys.argv[0], run_name="__main__")
"""
        with tempfile.TemporaryDirectory() as temporary:
            for name in ("write.log", "open.log"):
                with self.subTest(failure=name):
                    process = subprocess.Popen(
                        [sys.executable, "-u", "-c", bootstrap, str(WRITER_PATH), str(Path(temporary) / name)],
                        stdin=subprocess.PIPE,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.PIPE,
                    )
                    try:
                        _, error = process.communicate(input=b"producer event\n" * 100000, timeout=5)
                    finally:
                        if process.poll() is None:
                            process.kill()
                            process.communicate(timeout=3)
                    self.assertEqual(process.returncode, 0, error.decode("utf-8", errors="replace"))
                    self.assertEqual(error.count(b"file logging disabled"), 1)

    def test_raw_log_retains_latest_events_and_has_room_between_trims(self):
        bridge = load_script("notification_bridge")
        limit = 65536
        with tempfile.TemporaryDirectory() as temporary:
            log_path = Path(temporary) / "raw.log"
            bridge.RAW_LOG_PATH = log_path
            bridge.RAW_LOG_MAX_BYTES = limit
            log_path.write_bytes(b"x" * limit)
            sizes = []
            for event in range(80):
                bridge.append_raw_log({"event": event, "body": "x" * 1000})
                sizes.append(log_path.stat().st_size)
            self.assertFalse(bridge.RAW_LOG_DISABLED)
            self.assertLessEqual(max(sizes), limit)
            # A trim leaves space for subsequent events instead of copying 64 KiB
            # every time an approximately 1 KiB event arrives.
            self.assertLess(sizes[0], limit * 4 // 5)
            self.assertGreater(sizes[1], sizes[0])
            self.assertEqual(json.loads(log_path.read_bytes().splitlines()[-1])["event"], 79)

    def test_oversized_raw_event_is_not_appended_twice(self):
        bridge = load_script("notification_bridge")
        limit = 65536
        with tempfile.TemporaryDirectory() as temporary:
            log_path = Path(temporary) / "raw.log"
            bridge.RAW_LOG_PATH = log_path
            bridge.RAW_LOG_MAX_BYTES = limit
            bridge.append_raw_log({"body": "x" * (limit * 2)})
            self.assertEqual(log_path.stat().st_size, limit)
            bridge.append_raw_log({"event": "latest"})
            self.assertLessEqual(log_path.stat().st_size, limit)
            self.assertEqual(json.loads(log_path.read_bytes().splitlines()[-1])["event"], "latest")


if __name__ == "__main__":
    unittest.main()
