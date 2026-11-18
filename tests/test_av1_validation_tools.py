import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


diagnostics = load("av1_host_diagnostics", "root/scripts/av1-host-diagnostics.py")
benchmark = load("codec_benchmark", "scripts/ops/codec-benchmark.py")


class HostDiagnosticsTests(unittest.TestCase):
    def test_encode_entries_are_distinct_from_decode_only_and_wrong_profile(self):
        for entry, expected in (("VAEntrypointEncSlice", True),
                                ("VAEntrypointEncSliceLP", True), ("VAEntrypointVLD", False)):
            with self.subTest(entry=entry):
                result = diagnostics.parse_vainfo({"exit_code": 0, "timeout": False,
                    "stdout": "VAProfileAV1Profile0 : " + entry,
                    "stderr": "VAProfileH264High : VAEntrypointEncSlice"})
                self.assertEqual(result["av1_encode_entry"], expected)
                self.assertEqual(result["av1_decode_entry"], entry == "VAEntrypointVLD")
        wrong = diagnostics.parse_vainfo({"exit_code": 0, "stdout": "VAProfileAV1Profile1 : VAEntrypointEncSlice"})
        self.assertFalse(wrong["av1_encode_entry"])

    def test_failed_or_timed_out_vainfo_cannot_pass_from_partial_stdout(self):
        for code, timeout in ((1, False), (None, True)):
            result = diagnostics.parse_vainfo({"exit_code": code, "timeout": timeout,
                "stdout": "VAProfileAV1Profile0 : VAEntrypointEncSlice"})
            self.assertFalse(result["av1_encode_entry"])

    def test_device_failure_is_preserved_and_vainfo_is_not_run(self):
        with patch.object(diagnostics.os, "stat", side_effect=PermissionError(13, "denied")), \
                patch.object(diagnostics, "command") as command:
            result = diagnostics.inspect_node("/dev/dri/renderD128", "radeonsi")
        self.assertEqual(result["reason_code"], "DEVICE_OPEN_FAILED")
        self.assertEqual(result["errno"], 13)
        self.assertFalse(result["open_read_write"])
        command.assert_not_called()
        self.assertEqual(diagnostics.inspect_node("/etc/passwd", "radeonsi")["reason_code"], "INVALID_RENDER_NODE")

    def test_timeout_retains_partial_diagnostic_text(self):
        with patch.object(diagnostics.subprocess, "run", side_effect=subprocess.TimeoutExpired(
                ["vainfo"], 10, output=b"driver initialized", stderr=b"stuck")):
            result = diagnostics.command(["vainfo"])
        self.assertTrue(result["timeout"])
        self.assertIsNone(result["exit_code"])
        self.assertEqual(result["stdout"], "driver initialized")
        self.assertEqual(result["stderr"], "stuck")

    def test_root_worker_must_really_match_desktop_identity(self):
        account = SimpleNamespace(pw_uid=1000)
        with patch.object(diagnostics.pwd, "getpwnam", return_value=account), \
                patch.object(diagnostics.os, "geteuid", return_value=0), \
                patch.object(diagnostics, "command", return_value={"exit_code": 0,
                    "stdout": json.dumps({"identity": {"uid": 0}, "av1_encode_entry": True})}):
            result = diagnostics.inspect_as_user("/dev/dri/renderD128", "radeonsi", "abc")
        self.assertEqual(result["reason_code"], "DESKTOP_USER_PROBE_FAILED")


class BenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.args = SimpleNamespace(codec="av1", width=1920, height=1080, fps=30, segment_seconds=5)
        self.state = {"session_id": "sample-session", "active": True, "requested_encoder": "av1enc",
                      "codec": "av1", "hardware": None, "width": 1920, "height": 1080,
                      "target_fps": 30, "frames": 100, "bytes": 1000000, "updated_at": 100.0,
                      "bitrate_bps": 8000000}

    def test_stale_snapshot_and_actual_codec_mismatch_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            path.write_text(json.dumps({"schema_version": 1, "updated_at": 100,
                                       "displays": {"primary": self.state}}))
            self.assertEqual(benchmark.read_stream(path, now=105)[1], "stale_stream_snapshot")
            state, error = benchmark.read_stream(path, now=101)
            self.assertIsNone(error)
            self.assertEqual(benchmark.stream_problems(state, self.args), [])
            state["codec"] = "h264"
            self.assertIn("actual_codec_mismatch", benchmark.stream_problems(state, self.args))
            state["session_id"] = "new-session"
            self.assertIn("stream_session_changed", benchmark.stream_problems(state, self.args, "sample-session"))

    def test_fdinfo_units_capacity_and_counter_regression(self):
        key, first = benchmark.parse_fdinfo("drm-client-id: 8\ndrm-pdev: 0000:04:00.0\n"
            "drm-engine-enc: 100000000 ns\ndrm-engine-capacity-enc: 2\n")
        _, second = benchmark.parse_fdinfo("drm-client-id: 8\ndrm-pdev: 0000:04:00.0\n"
            "drm-engine-enc: 500000000 ns\ndrm-engine-capacity-enc: 2\n")
        self.assertEqual(benchmark.gpu_delta({key: first}, {key: second}, 1), {"0000:04:00.0/enc": 20.0})
        _, regressed = benchmark.parse_fdinfo("drm-client-id: 8\ndrm-pdev: 0000:04:00.0\n"
            "drm-engine-enc: 400000000 ns\ndrm-engine-capacity-enc: 2\n")
        self.assertEqual(benchmark.gpu_delta({key: second}, {key: regressed}, 1), {"0000:04:00.0/enc": 0.0})
        self.assertEqual(regressed["engines"]["enc"], 500000000)
        self.assertIsNone(benchmark.gpu_delta({}, {}, 1))

    def test_workload_timeline_and_unknown_hardware_are_not_fabricated(self):
        self.assertEqual(benchmark.phase_at(4, 5, 20), ("warmup", 4))
        self.assertEqual(benchmark.phase_at(5, 5, 20), ("static", 0))
        self.assertEqual(benchmark.phase_at(25, 5, 20), ("scroll", 0))
        self.assertEqual(benchmark.phase_at(45, 5, 20), ("mixed", 0))
        rows = []
        for index in range(15):
            state = dict(self.state, updated_at=100 + index, frames=100 + 30 * index, bytes=1000000 + 100000 * index)
            rows.append({"elapsed_seconds": index, "phase": benchmark.PHASES[index // 5], "cpu_one_core_percent": 10,
                         "stream": state, "gpu_engine_percent": None, "problems": []})
        result = benchmark.summarize(rows, self.args)
        self.assertTrue(result["valid_run"])
        self.assertEqual(result["hardware_evidence"], "unknown")
        self.assertFalse(result["hardware_comparison_ready"])
        self.assertEqual(result["wire_video"]["average_bitrate_bps"], 800000)
        self.assertEqual(result["wire_video"]["average_fps"], 30)
        for index, row in enumerate(rows):
            row['stream'].update(native_stats=dict(frames=10 * index, encode_ns=0, pipeline_ns=20_000_000 * index),
                                 frame_feedback=dict(generation=1, age_ms=10, received_total=20 * index,
                                                     decoded_total=19 * index, drawn_total=18 * index))
        result = benchmark.summarize(rows, self.args)
        self.assertEqual(result['reported_client_rates']['drawn_fps'], 18)
        self.assertIsNone(result['native_timing']['encode_mean_ms'])
        self.assertEqual(result['native_timing']['pipeline_mean_ms'], 2)
        rows[-1]['stream']['frame_feedback']['age_ms'] = 3000
        self.assertIsNone(benchmark.summarize(rows, self.args)['reported_client_rates'])
        rows[-1]["problems"] = ["stream_session_changed"]
        self.assertFalse(benchmark.summarize(rows, self.args)["valid_run"])

    def test_fresh_status_without_video_progress_cannot_pass_workload(self):
        rows = [{"elapsed_seconds": index, "phase": benchmark.PHASES[index // 5],
                 "cpu_one_core_percent": 10, "stream": dict(self.state, updated_at=100 + index),
                 "gpu_engine_percent": None, "problems": []} for index in range(15)]
        summary = benchmark.summarize(rows, self.args)
        self.assertFalse(summary["valid_run"])
        self.assertIn("no_video_during_scroll", summary["problems"])
        self.assertIn("no_video_during_mixed", summary["problems"])

    def test_duplicate_drm_file_descriptors_count_once(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            for pid, counter in ((100, 100000000), (101, 100000100)):
                info = proc / str(pid) / "fdinfo"
                info.mkdir(parents=True)
                (info / "9").write_text("drm-client-id: 8\ndrm-pdev: 0000:04:00.0\n"
                                       f"drm-engine-enc: {counter} ns\n")
            result = benchmark.gpu_snapshot(proc)
            self.assertEqual(len(result), 1)
            self.assertEqual(result["0000:04:00.0:8"]["engines"]["enc"], 100000100)

    def test_output_preserves_missing_metrics_in_json_and_csv(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "sample"
            benchmark.write_results(base, {}, [{"elapsed_seconds": 1, "phase": "static",
                "cpu_one_core_percent": None, "stream": self.state, "gpu_engine_percent": None,
                "problems": []}], {"valid_run": False})
            document = json.loads(base.with_suffix(".json").read_text())
            self.assertIsNone(document["samples"][0]["cpu_one_core_percent"])
            self.assertIsNone(document["samples"][0]["gpu_engine_percent"])
            self.assertIn("actual_codec,hardware,fps", base.with_suffix(".csv").read_text())


if __name__ == "__main__":
    unittest.main()
