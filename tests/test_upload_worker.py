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


class UploadWorkerRecoveryTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
