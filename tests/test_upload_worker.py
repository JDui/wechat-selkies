from pathlib import Path
import unittest


WORKER = (
    Path(__file__).parents[1]
    / "root"
    / "usr"
    / "share"
    / "selkies"
    / "selkies-dashboard"
    / "uploader"
    / "upload-worker.js"
)
ROOT = Path(__file__).resolve().parents[1]


class UploadWorkerRecoveryTests(unittest.TestCase):
    def test_default_chunk_size_is_512_kib_in_all_upload_layers(self):
        worker_source = WORKER.read_text(encoding="utf-8")
        sidecar_source = (ROOT / "upload-sidecar" / "src" / "lib.rs").read_text(encoding="utf-8")
        auth_source = (ROOT / "root" / "scripts" / "session_auth_bridge.py").read_text(encoding="utf-8")
        docker_source = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        readme_source = (ROOT / "README.md").read_text(encoding="utf-8")

        self.assertIn('"524288"', sidecar_source)
        self.assertIn('"524288"', auth_source)
        self.assertIn('SELKIES_UPLOAD_CHUNK_SIZE="524288"', docker_source)
        self.assertIn("`SELKIES_UPLOAD_CHUNK_SIZE` | `524288`", readme_source)
        self.assertNotIn("8388608", sidecar_source + auth_source + docker_source)
        self.assertIn("CHUNK_REQUEST_TIMEOUT_MS = 45000", worker_source)

    def test_chunk_timeout_is_cleaned_and_distinguishes_abort_types(self):
        source = WORKER.read_text(encoding="utf-8")

        self.assertIn("var timedOut = false", source)
        self.assertIn("controller.abort()", source)
        self.assertIn("clearTimeout(timeoutId)", source)
        self.assertIn('error.name = "TimeoutError"', source)
        self.assertIn("if (task.staleSession) throw task.staleError || error", source)

    def test_chunk_timeout_clears_after_response_body_before_local_persistence(self):
        source = WORKER.read_text(encoding="utf-8")
        upload_start = source.index("async function uploadChunk(task, index)")
        response_index = source.index("var remote = await response.json();", upload_start)
        clear_index = source.index("clearChunkTimeout();", response_index)
        save_index = source.index("await saveTask(task);", response_index)
        finally_index = source.index("} finally {", clear_index)

        self.assertLess(response_index, clear_index)
        self.assertLess(clear_index, save_index)
        self.assertIn("clearChunkTimeout();", source[finally_index:])

    def test_chunk_retry_classification_and_structured_diagnostics_are_bounded(self):
        source = WORKER.read_text(encoding="utf-8")

        self.assertIn("function isRetryableChunkStatus", source)
        self.assertIn("status === 401", source)
        for status in ("408", "425", "429"):
            self.assertIn(status, source)
        self.assertIn("status >= 500 && status <= 599", source)
        self.assertIn("function isRetryableChunkError", source)
        self.assertIn('"upload-chunk-attempt"', source)
        self.assertIn('"upload-chunk-success"', source)
        self.assertIn('"upload-chunk-failure"', source)
        self.assertIn('"upload-chunk-retry"', source)
        self.assertIn("delete payload.authorization", source)
        self.assertIn("delete payload.token", source)
        self.assertIn("DIAGNOSTIC_MAX_PATH_LENGTH", source)
        self.assertIn("DIAGNOSTIC_MAX_MESSAGE_LENGTH", source)
        self.assertIn("启用【回退旧版上传工具】", source)
    def test_stale_session_is_typed_and_not_retried_as_a_chunk(self):
        source = WORKER.read_text(encoding="utf-8")

        self.assertIn("error.code = String(payload.error || payload.code || \"\")", source)
        self.assertIn("error.status = response.status", source)
        self.assertIn("function isStaleSessionError", source)
        self.assertIn("if (isStaleSessionError(error))", source)
        self.assertIn("task.staleSession = true", source)
        self.assertIn("task.controllers.forEach(function (controller) { controller.abort(); });", source)

    def test_concurrent_runners_settle_before_session_rebuild(self):
        source = WORKER.read_text(encoding="utf-8")

        self.assertIn("Promise.allSettled(runners)", source)
        self.assertIn("resetTaskForCurrentSession(task, sessionRecoveries)", source)
        self.assertIn("task.sessionId = null", source)
        self.assertIn("task.uploadedChunks = []", source)
        self.assertIn("tokenState = null", source)
        self.assertIn("MAX_SESSION_RECOVERIES", source)

    def test_old_eight_megabyte_sessions_migrate_once(self):
        source = WORKER.read_text(encoding="utf-8")

        self.assertNotIn("LEGACY_CHUNK_SIZE_LIMIT", source)
        self.assertIn("Number(remote.chunk_size) > currentServiceChunkSize", source)
        self.assertIn("Number(tokenState && tokenState.chunk_size) || 0", source)
        self.assertIn("currentServiceChunkSize > 0", source)
        self.assertIn("!task.sessionMigrationAttempted", source)
        self.assertIn('method: "DELETE"', source)
        self.assertIn("task.sessionMigrationAttempted = true", source)

    def test_undeclared_or_equal_service_chunk_size_does_not_migrate(self):
        source = WORKER.read_text(encoding="utf-8")

        self.assertIn("var currentServiceChunkSize = Number(tokenState && tokenState.chunk_size) || 0", source)
        self.assertIn("currentServiceChunkSize > 0", source)
        self.assertIn("Number(remote.chunk_size) > currentServiceChunkSize", source)


if __name__ == "__main__":
    unittest.main()
