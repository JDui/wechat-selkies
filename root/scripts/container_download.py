"""Session-scoped native desktop downloads. No browser supplied source paths."""
import hmac
import json
import os
from pathlib import Path
import secrets
import re
import shutil
import stat
import sys
import threading
import time
import unicodedata
from urllib.parse import quote


class DownloadError(ValueError):
    pass


def default_source_roots(home=Path("/config")):
    roots = [home / name for name in ("Desktop", "Downloads", "Documents", "uploads", "xwechat_files")]
    # QQ profiles are account-specific. Include attachment leaves only, never
    # the entire profile (which also stores account/session databases).
    qq = home / ".config" / "QQ"
    for layout in ("nt_qq_*/nt_data", "nt_qq_*/nt_data/*", "nt_qq/*/nt_data"):
        for profile in qq.glob(layout):
            for leaf in ("File", "Pic", "Video", "Ptt", "file_recv", "FileRecv"):
                attachment = profile / leaf
                if attachment.is_dir() and attachment.resolve().is_relative_to(qq.resolve()):
                    roots.append(attachment)
    return [path.resolve() for path in roots]


def error_details(error):
    code = str(error) if isinstance(error, DownloadError) else (
        "source-missing" if isinstance(error, FileNotFoundError) else
        "permission-denied" if isinstance(error, PermissionError) else "io-error")
    messages = {
        "source-outside-allowed-roots": "文件目录未获下载授权，请将附件保存到下载目录后重试，或配置 SELKIES_DROP_SOURCE_ROOTS",
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
    }
    return code, messages.get(code, "文件读取失败，请检查附件是否已下载完成")


class Downloads:
    def __init__(self, identity):
        self.identity = identity
        self.root = Path(os.getenv("SELKIES_DROP_CACHE", "/run/selkies-drop-cache"))
        download_root = Path(os.getenv("SELKIES_DOWNLOAD_ROOT", "/config")).resolve()
        if self.root.is_symlink() or self.root.resolve().is_relative_to(download_root):
            raise DownloadError("cache-must-be-outside-download-root")
        self.root = self.root.resolve()
        marker = self.root / ".selkies-drop-cache-v1"
        # Never chmod or sweep an arbitrary pre-existing directory. An empty
        # dedicated directory (including cont-init's default) may be adopted.
        entries = list(self.root.iterdir()) if self.root.exists() else []
        foreign_entries = any(file.is_symlink() or not file.is_file() or
                              (file.name != marker.name and not re.fullmatch(r"axi-drop-[0-9a-f]{48}\.(part|data)", file.name))
                              for file in entries)
        if (len(self.root.parts) < 3 or self.root == Path("/var/tmp") or foreign_entries or
                (entries and (not marker.is_file() or marker.is_symlink() or
                 marker.read_text() != "selkies native download cache v1\n"))):
            raise DownloadError("cache-must-be-dedicated-directory")
        self.max_file = int(os.getenv("SELKIES_DROP_MAX_FILE_BYTES", str(2 * 1024**3)))
        self.max_total = int(os.getenv("SELKIES_DROP_MAX_CACHE_BYTES", str(4 * 1024**3)))
        self.min_free = int(os.getenv("SELKIES_DROP_MIN_FREE_BYTES", str(256 * 1024**2)))
        self.max_jobs = int(os.getenv("SELKIES_DROP_MAX_JOBS", "4"))
        self.ttl = int(os.getenv("SELKIES_DROP_TTL_SECONDS", "300"))
        self.prepare_timeout = int(os.getenv("SELKIES_DROP_PREPARE_TIMEOUT_SECONDS", "3600"))
        configured = os.getenv("SELKIES_DROP_SOURCE_ROOTS")
        self.use_default_roots = configured is None
        self.allowed = [Path(p).resolve() for p in configured.split(":") if p] if configured is not None else default_source_roots()
        self.lock = threading.RLock()
        self.jobs = {}
        self.lease = None
        self.phase = "idle"
        self.error = ""
        self.native_ready = False
        if min(self.max_file, self.max_total, self.max_jobs, self.ttl, self.prepare_timeout) <= 0 or self.min_free < 0:
            raise DownloadError("invalid-limits")
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.root.chmod(0o700)
        if not marker.exists():
            with marker.open("x") as owner_file:
                owner_file.write("selkies native download cache v1\n")
        # This dedicated, non-public directory is exclusively owned by this
        # process. In-memory credentials deliberately do not survive restart.
        for file in self.root.iterdir():
            if file.is_file() and re.fullmatch(r"axi-drop-[0-9a-f]{48}\.(part|data)", file.name):
                file.unlink(missing_ok=True)

    def configure(self, sid, client, rect):
        if not isinstance(client, str) or not 16 <= len(client) <= 80 or not client.isalnum():
            raise DownloadError("invalid-client")
        if rect is not None and (not isinstance(rect, list) or len(rect) != 4 or
                any(type(n) is not int for n in rect) or min(rect[:2]) < 0 or
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
        # Called only from native selection conversion; never exposed as HTTP.
        with self.lock:
            if not lease or not self.current() or self.current()[:2] != lease[:2]:
                raise DownloadError("session-expired")
            if len(files) != 1:
                raise DownloadError("one-file-at-a-time")
            if any(j["state"] == "preparing" for j in self.jobs.values()):
                raise DownloadError("already-preparing")
            if len(self.jobs) >= self.max_jobs:
                raise DownloadError("queue-full")
            job_id = "axi-drop-" + secrets.token_hex(24)
            job = dict(id=job_id, token=secrets.token_urlsafe(32), sid=lease[0], client=lease[1],
                       expires=time.time() + self.prepare_timeout, state="preparing", size=0, active=0,
                       name="", error="", used=False)
            self.jobs[job_id] = job
            self.phase, self.error = "preparing", ""
        threading.Thread(target=self.copy, args=(job, files[0][0]), daemon=True).start()

    def open_source(self, name):
        original = Path(name)
        resolved = original.resolve(strict=True)
        allowed = default_source_roots() if self.use_default_roots else self.allowed
        if not any(resolved.is_relative_to(root) for root in allowed):
            raise DownloadError("source-outside-allowed-roots")
        # Resolve aliases, then open beneath the configured root using dirfds.
        # O_NOFOLLOW on every component prevents intermediate symlink swaps.
        chosen = next(root for root in allowed if resolved.is_relative_to(root))
        fd = os.open(chosen, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            parts = resolved.relative_to(chosen).parts
            if not parts:
                raise DownloadError("regular-file-required")
            for part in parts[:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            source = os.open(parts[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=fd)
        finally:
            os.close(fd)
        info = os.fstat(source)
        if not stat.S_ISREG(info.st_mode):
            os.close(source)
            raise DownloadError("regular-file-required")
        return os.fdopen(source, "rb"), info

    def copy(self, job, source):
        part = self.root / (job["id"] + ".part")
        try:
            stream, before = self.open_source(source)
            with stream:
                size = before.st_size
                with self.lock:
                    if size > self.max_file or sum(j["size"] for j in self.jobs.values()) + size > self.max_total:
                        raise DownloadError("size-limit")
                    if shutil.disk_usage(self.root).free < size + self.min_free:
                        raise DownloadError("insufficient-space")
                    job["size"] = size
                copied = 0
                with part.open("xb") as destination:
                    while True:
                        if job["sid"] != self.identity() or time.time() > job["expires"]:
                            raise DownloadError("session-or-job-expired")
                        chunk = stream.read(1024 * 1024)
                        if not chunk:
                            break
                        copied += len(chunk)
                        if copied > size:
                            raise DownloadError("source-changed")
                        destination.write(chunk)
                    destination.flush()
                after = os.fstat(stream.fileno())
                if copied != size or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                    raise DownloadError("source-changed")
            part.replace(self.root / (job["id"] + ".data"))
            with self.lock:
                job.update(state="ready", name=Path(source).name, expires=time.time() + self.ttl)
                self.phase = "idle"
            print("[dock-download] job", job["id"], "ready bytes", size, flush=True, file=sys.stderr)
        except (OSError, ValueError) as error:
            part.unlink(missing_ok=True)
            code, message = error_details(error)
            with self.lock:
                job.update(state="error", error=message, expires=time.time() + 20)
                self.phase, self.error = "error", job["error"]
            print("[dock-download] job", job["id"], "prepare-failed", code, flush=True, file=sys.stderr)

    def sweep(self):
        with self.lock:
            for key, job in list(self.jobs.items()):
                if not job["active"] and job["state"] != "preparing" and (
                        job["expires"] < time.time() or job["sid"] != self.identity()):
                    for suffix in (".part", ".data"):
                        (self.root / (key + suffix)).unlink(missing_ok=True)
                    del self.jobs[key]

    def status(self, sid, client):
        self.sweep()
        with self.lock:
            lease = self.current()
            own = lease and lease[:2] == (sid, client)
            jobs = [{k: j[k] for k in ("id", "state", "name", "size", "error")} |
                    ({"token": j["token"]} if j["state"] == "ready" and not j["used"] else {})
                    for j in self.jobs.values() if j["sid"] == sid and j["client"] == client]
            return dict(ok=True, native_ready=self.native_ready, phase=self.phase if own else "idle",
                        error=self.error if own else "", jobs=jobs)

    def stream(self, handler, sid, job_id, token):
        with self.lock:
            job = self.jobs.get(job_id)
            if (not job or job["sid"] != sid or sid != self.identity() or job["used"] or
                    job["state"] != "ready" or job["expires"] < time.time() or
                    not hmac.compare_digest(job["token"], token)):
                handler.send_json(410, dict(ok=False, error="download-expired"))
                return
            job["used"], job["active"] = True, 1
        success = False
        try:
            with (self.root / (job_id + ".data")).open("rb") as source:
                clean = "".join(c for c in job["name"] if not unicodedata.category(c).startswith("C") and c not in '/\\')[:180] or "download"
                handler.send_response(200)
                handler.send_header("Content-Type", "application/octet-stream")
                handler.send_header("Content-Disposition", "attachment; filename=\"download\"; filename*=UTF-8''" + quote(clean, safe=""))
                handler.send_header("Content-Length", str(job["size"]))
                handler.send_header("Cache-Control", "no-store")
                handler.send_header("X-Content-Type-Options", "nosniff")
                handler.end_headers()
                handler.connection.settimeout(30)
                while True:
                    if sid != self.identity():
                        raise ConnectionAbortedError("session-changed")
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    handler.wfile.write(chunk)
                success = True
        except OSError:
            handler.close_connection = True
        finally:
            with self.lock:
                job["active"] = 0
                job["state"] = "sent" if success else "ready"
                job["used"] = success
                job["expires"] = min(job["expires"], time.time() + (15 if success else 60))
            print("[dock-download] job", job_id, "sent" if success else "interrupted", "bytes", job["size"], flush=True, file=sys.stderr)

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

        def cleanup():
            while True:
                time.sleep(5)
                self.sweep()

        threading.Thread(target=worker, daemon=True).start()
        threading.Thread(target=cleanup, daemon=True).start()
