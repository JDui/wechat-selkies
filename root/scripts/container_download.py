"""Thin X11 drag-and-drop adapter; Rust sidecar owns copy, cache and job state."""
import json
import os
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class DownloadError(ValueError):
    pass


ERROR_MESSAGES = {
    "source-outside-allowed-roots": "此文件暂不支持直接下载，请先另存到下载目录",
    "source-missing": "源文件不存在，请先在聊天应用中下载完整附件后重试",
    "permission-denied": "容器没有读取该文件的权限",
    "size-limit": "文件大小或临时缓存总量超出限制",
    "insufficient-space": "临时缓存空间不足",
    "source-changed": "源文件仍在写入或已变化，请下载完成后重试",
    "session-or-job-expired": "文件准备超时或会话已失效，请重新拖入",
    "regular-file-required": "仅支持普通文件，不支持目录或设备",
    "one-file-at-a-time": "请每次拖入一个文件",
    "already-preparing": "已有文件正在准备，请稍后重试",
    "queue-full": "下载任务已满，请稍后重试",
    "session-expired": "会话已失效，请重新登录后重试",
    "download-expired": "下载任务已过期，请重新拖入文件",
    "io-error": "文件读取失败，请检查附件是否已下载完成",
}


def error_details(error):
    code = str(error) if isinstance(error, DownloadError) else "io-error"
    return code, ERROR_MESSAGES.get(code, ERROR_MESSAGES["io-error"])


class Downloads:
    def __init__(self, identity):
        self.identity = identity
        self.port = int(os.environ.get("SELKIES_UPLOAD_PORT", os.environ.get("SELKIES_CONTAINER_SLEEP_PORT", os.environ.get("LOCAL_LINK_BRIDGE_PORT", "38084"))))
        self.lock = threading.RLock()
        self.lease = None
        self.phase = "idle"
        self.error = ""
        self.error_id = ""
        self.native_ready = False

    def _sidecar_request(self, path, method="GET", payload=None, timeout=3.0):
        url = f"http://127.0.0.1:{self.port}{path}"
        data = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request = Request(url, data=data, method=method)
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urlopen(request, timeout=timeout) as response:
                body = response.read().decode("utf-8", errors="replace")
                return response.status, json.loads(body or "{}")
        except HTTPError as error:
            try:
                body = error.read().decode("utf-8", errors="replace")
                payload = json.loads(body or "{}")
            except Exception:
                payload = {}
            code = str(payload.get("error") or "io-error")
            raise DownloadError(code) from error
        except (URLError, TimeoutError, OSError) as error:
            raise DownloadError("io-error") from error

    def configure(self, sid, client, rect):
        if not isinstance(client, str) or not 16 <= len(client) <= 80 or not client.isalnum():
            raise DownloadError("invalid-client")
        if rect is not None and (not isinstance(rect, list) or len(rect) != 4 or
                any(type(value) is not int for value in rect) or min(rect[:2]) < 0 or
                min(rect[2:]) <= 0 or max(rect) > 32767):
            raise DownloadError("invalid-geometry")
        with self.lock:
            now = time.monotonic()
            if rect is None:
                if self.lease and self.lease[:2] == (sid, client):
                    self.lease = None
                    if self.phase in ("target", "dragging", "unsupported"):
                        self.phase = "idle"
                return
            if self.lease and self.lease[2] > now and self.lease[:2] != (sid, client):
                if self.lease[0] == self.identity():
                    raise DownloadError("another-page-active")
            self.lease = (sid, client, now + 3, rect)

    def current(self):
        with self.lock:
            lease = self.lease
            if not lease or lease[2] < time.monotonic() or lease[0] != self.identity():
                return None
            return lease

    def geometry(self):
        lease = self.current()
        return lease[3] if lease else None

    def event(self, phase, **fields):
        with self.lock:
            if phase == "ready":
                self.native_ready = True
            if phase in ("enter", "position"):
                self.phase = "target" if fields.get("accepted", fields.get("uri_list", False)) else "unsupported"
            elif phase == "armed":
                self.phase = "dragging"
            elif phase in ("idle", "leave", "cancelled") and self.phase not in ("preparing", "error"):
                self.phase = "idle"

    def submit(self, files, lease):
        # The native X11 selection is still owned by Python. File validation,
        # copying, cache quotas and job lifecycle are delegated to Rust.
        with self.lock:
            current = self.current()
            if not lease or not current or current[:2] != lease[:2]:
                raise DownloadError("session-expired")
            if len(files) != 1:
                raise DownloadError("one-file-at-a-time")
            sid, client = lease[:2]
            identity = self.identity()
            if not identity or identity != sid or not isinstance(sid, tuple) or len(sid) != 2:
                raise DownloadError("session-expired")
            try:
                session_id, epoch = str(sid[0]), int(sid[1])
            except (TypeError, ValueError):
                raise DownloadError("session-expired")
            source = str(files[0][0])
            self.phase, self.error, self.error_id = "preparing", "", ""
        try:
            _, result = self._sidecar_request(
                "/native-download/jobs",
                method="POST",
                payload={
                    "source": source,
                    "session_id": session_id,
                    "session_epoch": epoch,
                    "client": client,
                },
                timeout=3.0,
            )
        except DownloadError as error:
            code, message = error_details(error)
            with self.lock:
                self.phase, self.error = "error", message
                self.error_id = ""
            raise
        if not result.get("id"):
            raise DownloadError("io-error")
        return result["id"]

    def status(self, sid, client):
        identity = self.identity()
        if not identity or identity != sid or not isinstance(sid, tuple) or len(sid) != 2:
            return dict(ok=True, native_ready=self.native_ready, phase="idle", error="", error_id="", jobs=[])
        session_id, epoch = str(sid[0]), int(sid[1])
        try:
            _, payload = self._sidecar_request(
                "/native-download/state?" + urlencode({"sid": session_id, "epoch": epoch, "client": client}),
                timeout=1.5,
            )
        except (DownloadError, ValueError):
            payload = {"ok": False, "jobs": []}
        jobs = payload.get("jobs") if isinstance(payload.get("jobs"), list) else []
        with self.lock:
            own = self.lease and self.lease[:2] == (sid, client) and self.lease[2] >= time.monotonic()
            phase = self.phase if own else "idle"
            error = self.error if own else ""
            error_id = self.error_id if own else ""
            if own and jobs:
                preparing = next((job for job in jobs if job.get("state") == "preparing"), None)
                failed = next((job for job in jobs if job.get("state") == "error"), None)
                if preparing:
                    phase = "preparing"
                elif failed:
                    phase = "error"
                    error = failed.get("error") or error
                    error_id = failed.get("id") or error_id
                elif any(job.get("state") in ("ready", "sent") for job in jobs):
                    phase = "idle"
                    error = ""
                    error_id = ""
            return dict(
                ok=bool(payload.get("ok", False)),
                native_ready=self.native_ready,
                phase=phase,
                error=error,
                error_id=error_id,
                jobs=jobs,
            )

    def start(self):
        def worker():
            from xdnd_receiver import run
            while True:
                try:
                    run(self)
                except Exception as error:
                    self.native_ready = False
                    print("[dock-download] native receiver unavailable:", type(error).__name__, flush=True)
                    time.sleep(5)

        threading.Thread(target=worker, daemon=True, name="selkies-xdnd-receiver").start()
