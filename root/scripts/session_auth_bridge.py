#!/usr/bin/env python3
import hashlib
import hmac
import http.server
import json
import os
import time
import threading
from http import HTTPStatus
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs, urlparse


PORT = int(os.environ.get("SELKIES_SESSION_AUTH_PORT", "38082"))
PASSWORD = os.environ.get("PASSWORD", "")
STATE_PATH = Path(os.environ.get("SELKIES_SESSION_STATE_PATH", "/run/selkies-runtime/active-session.json"))
COOKIE_NAME = os.environ.get("SELKIES_SESSION_COOKIE_NAME", "selkies_session")
def diagnostics_env_int(name, default, minimum, maximum=None):
    try:
        value = int(str(os.environ.get(name, default)).strip())
    except (TypeError, ValueError):
        value = int(default)
    if value < minimum:
        value = minimum
    if maximum is not None and value > maximum:
        value = maximum
    return value


DIAGNOSTICS_LOG_PATH = Path(
    os.environ.get("SELKIES_UPLOAD_DIAGNOSTICS_LOG_PATH", "/config/logs/upload-diagnostics.jsonl")
)
DIAGNOSTICS_RETENTION_DAYS = diagnostics_env_int("SELKIES_UPLOAD_DIAGNOSTICS_RETENTION_DAYS", 7, 1, 90)
# Hard size cap for the active file; older content rotates into .1/.2/... archives.
DIAGNOSTICS_MAX_BYTES = diagnostics_env_int(
    "SELKIES_UPLOAD_DIAGNOSTICS_MAX_BYTES", 512 * 1024, 64 * 1024, 32 * 1024 * 1024
)
DIAGNOSTICS_SIZE_ARCHIVES = diagnostics_env_int("SELKIES_UPLOAD_DIAGNOSTICS_ARCHIVES", 3, 1, 10)
# Periodic heartbeat samples ("*-sample") dominate the volume and carry no failure signal,
# so they are dropped unless explicitly requested.
DIAGNOSTICS_KEEP_SAMPLES = str(
    os.environ.get("SELKIES_UPLOAD_DIAGNOSTICS_KEEP_SAMPLES", "false")
).strip().lower() in ("1", "true", "yes", "on")
DIAGNOSTICS_DATE_FORMAT = "%Y%m%d"
MAX_DIAGNOSTICS_BODY = 64 * 1024
_diagnostics_active_date = None
DIAGNOSTICS_LOCK = threading.RLock()


def read_state():
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except FileNotFoundError:
        pass
    except Exception:
        pass
    return {}


def token_digest(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def parse_cookie(header):
    cookie = SimpleCookie()
    try:
        cookie.load(header or "")
    except Exception:
        return ""
    morsel = cookie.get(COOKIE_NAME)
    return morsel.value if morsel else ""


def is_valid_token(token):
    if not PASSWORD:
        return True
    if not token:
        return False
    state = read_state()
    expected = str(state.get("token_hash") or "")
    return bool(expected) and hmac.compare_digest(token_digest(token), expected)


def is_valid_session_identity(session_id, session_epoch):
    if not PASSWORD:
        return True
    if not session_id or not session_epoch:
        return False
    state = read_state()
    expected_id = str(state.get("session_id") or "")
    try:
        expected_epoch = int(state.get("session_epoch") or 0)
        actual_epoch = int(session_epoch or 0)
    except (TypeError, ValueError):
        return False
    return (
        bool(expected_id)
        and hmac.compare_digest(str(session_id), expected_id)
        and actual_epoch == expected_epoch
    )


def parse_session_identity_from_query(query):
    params = parse_qs(query or "")
    return (
        str((params.get("selkies_session_id") or [""])[0] or ""),
        str((params.get("selkies_session_epoch") or [""])[0] or ""),
    )


def parse_session_identity_from_url(raw_url):
    return parse_session_identity_from_query(urlparse(raw_url or "").query)


def request_has_valid_session(handler):
    token = parse_cookie(handler.headers.get("Cookie"))
    if is_valid_token(token):
        return True

    session_id, session_epoch = parse_session_identity_from_query(urlparse(handler.path).query)
    if is_valid_session_identity(session_id, session_epoch):
        return True

    session_id, session_epoch = parse_session_identity_from_url(handler.headers.get("X-Original-URI"))
    return is_valid_session_identity(session_id, session_epoch)


def diagnostics_day_stamp(ts):
    return time.strftime(DIAGNOSTICS_DATE_FORMAT, time.localtime(ts))


def prune_diagnostics_archives(now_ts):
    cutoff = diagnostics_day_stamp(now_ts - DIAGNOSTICS_RETENTION_DAYS * 86400)
    prefix = DIAGNOSTICS_LOG_PATH.name + "."
    try:
        entries = list(DIAGNOSTICS_LOG_PATH.parent.iterdir())
    except OSError:
        return
    for entry in entries:
        if not entry.name.startswith(prefix):
            continue
        suffix = entry.name[len(prefix):]
        if not suffix.isascii() or not suffix.isdigit() or entry.is_symlink():
            continue
        try:
            if not entry.is_file():
                continue
            if len(suffix) == 8:
                expired = suffix <= cutoff
            else:
                # Numbered archives retain the original file mtime on rename.
                # Also remove archives left behind after reducing the count.
                expired = (int(suffix) > DIAGNOSTICS_SIZE_ARCHIVES or
                           entry.stat().st_mtime <= now_ts - DIAGNOSTICS_RETENTION_DAYS * 86400)
            if expired:
                entry.unlink()
        except OSError:
            pass


def rotate_diagnostics_file(now_ts):
    global _diagnostics_active_date
    today = diagnostics_day_stamp(now_ts)
    if _diagnostics_active_date == today:
        return
    try:
        stat = DIAGNOSTICS_LOG_PATH.stat()
        file_day = diagnostics_day_stamp(stat.st_mtime)
        if stat.st_size > 0 and file_day != today:
            archived = DIAGNOSTICS_LOG_PATH.with_name(f"{DIAGNOSTICS_LOG_PATH.name}.{file_day}")
            try:
                archived.unlink()
            except FileNotFoundError:
                pass
            DIAGNOSTICS_LOG_PATH.replace(archived)
    except OSError:
        pass
    _diagnostics_active_date = today
    prune_diagnostics_archives(now_ts)


def rotate_diagnostics_by_size(incoming_bytes):
    try:
        stat = DIAGNOSTICS_LOG_PATH.stat()
    except OSError:
        return
    if stat.st_size <= 0 or stat.st_size + incoming_bytes <= DIAGNOSTICS_MAX_BYTES:
        return
    for index in range(DIAGNOSTICS_SIZE_ARCHIVES - 1, 0, -1):
        source = DIAGNOSTICS_LOG_PATH.with_name(f"{DIAGNOSTICS_LOG_PATH.name}.{index}")
        if not source.exists():
            continue
        target = DIAGNOSTICS_LOG_PATH.with_name(f"{DIAGNOSTICS_LOG_PATH.name}.{index + 1}")
        try:
            if target.exists():
                target.unlink()
            source.replace(target)
        except OSError:
            pass
    first = DIAGNOSTICS_LOG_PATH.with_name(f"{DIAGNOSTICS_LOG_PATH.name}.1")
    try:
        if first.exists():
            first.unlink()
        DIAGNOSTICS_LOG_PATH.replace(first)
    except OSError:
        pass


def is_periodic_sample_event(event_name):
    return str(event_name or "").strip().lower().endswith("-sample")


def strip_periodic_samples(payload):
    if DIAGNOSTICS_KEEP_SAMPLES or not isinstance(payload, dict):
        return payload
    records = payload.get("records")
    if not isinstance(records, list) or not records:
        return payload
    kept = []
    dropped = 0
    for item in records:
        if isinstance(item, dict) and is_periodic_sample_event(item.get("event")):
            dropped += 1
            continue
        kept.append(item)
    if not dropped:
        return payload
    filtered = dict(payload)
    filtered["records"] = kept
    filtered["droppedSamples"] = dropped
    return filtered


def append_diagnostics(payload):
    with DIAGNOSTICS_LOCK:
        _append_diagnostics_unlocked(payload)


def _append_diagnostics_unlocked(payload):
    rotate_diagnostics_file(time.time())
    filtered = strip_periodic_samples(payload)
    records = filtered.get("records") if isinstance(filtered, dict) else None
    if isinstance(records, list) and not records:
        # Heartbeats only: keep the log for real events.
        return
    DIAGNOSTICS_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp_ms": int(time.time() * 1000),
        "source": "browser",
        "metrics": filtered,
    }
    line = json.dumps(record, separators=(",", ":"), ensure_ascii=False) + "\n"
    rotate_diagnostics_by_size(len(line.encode("utf-8")))
    with DIAGNOSTICS_LOG_PATH.open("a", encoding="utf-8") as stream:
        stream.write(line)


DOWNLOADS = None


def download_identity():
    state = read_state()
    sid, epoch = state.get("session_id"), state.get("session_epoch")
    return (str(sid), int(epoch)) if sid and epoch else None


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "SelkiesSessionAuth/1.0"

    def log_message(self, fmt, *args):
        return

    def send_empty(self, status, extra_headers=None):
        self.send_response(status)
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def send_json(self, status, payload, extra_headers=None):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self, max_bytes=MAX_DIAGNOSTICS_BODY):
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            return None
        if length < 0 or length > max_bytes:
            return None
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except Exception:
            return None
        return payload if isinstance(payload, dict) else None

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/discovery":
            # Discovery must work before login and while the desktop and its
            # notification bridge are frozen. Reuse the broadcaster's schema.
            from lan_discovery_common import build_identity_payload, read_discovery_state
            state_path = Path(os.environ.get(
                "NOTIFICATION_BRIDGE_MODE_PATH", "/config/state/notification-bridge.json"))
            self.send_json(HTTPStatus.OK, build_identity_payload(read_discovery_state(state_path)))
            return
        if path == "/dock-download/state":
            if not request_has_valid_session(self):
                self.send_empty(HTTPStatus.UNAUTHORIZED)
                return
            if DOWNLOADS is None:
                self.send_json(HTTPStatus.OK, {
                    "ok": True, "native_ready": False, "phase": "idle",
                    "error": "", "error_id": "", "jobs": [],
                })
                return
            client = query.get("client", [""])[0]
            self.send_json(HTTPStatus.OK, DOWNLOADS.status(download_identity(), client))
            return

        if path == "/health":
            self.send_json(HTTPStatus.OK, {"ok": True})
            return
        self.send_empty(HTTPStatus.NOT_FOUND)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/dock-download/geometry":
            if not request_has_valid_session(self):
                self.send_json(401, {"ok": False, "error": "session-expired"})
                return
            # Reject cross-origin form/JSON attempts even for anonymous mode.
            origin = self.headers.get("Origin")
            if origin and urlparse(origin).netloc != self.headers.get("Host"):
                self.send_json(403, {"ok": False})
                return
            payload = self.read_json_body(2048)
            if DOWNLOADS is None or payload is None:
                self.send_json(503 if DOWNLOADS is None else 400, {"ok": False})
                return
            try:
                DOWNLOADS.configure(download_identity(), payload.get("client"), payload.get("rect"))
                self.send_json(200, DOWNLOADS.status(download_identity(), payload.get("client")))
            except ValueError as error:
                self.send_json(409, {"ok": False, "error": str(error)})
            return
        if path == "/diagnostics":
            if not request_has_valid_session(self):
                self.send_empty(HTTPStatus.UNAUTHORIZED)
                return
            payload = self.read_json_body()
            if payload is None:
                self.send_empty(HTTPStatus.BAD_REQUEST)
                return
            try:
                append_diagnostics(payload)
            except OSError:
                self.send_empty(HTTPStatus.INTERNAL_SERVER_ERROR)
                return
            self.send_empty(HTTPStatus.NO_CONTENT)
            return
        self.send_empty(HTTPStatus.NOT_FOUND)


if __name__ == "__main__":
    # Maintenance must run even when no browser sends diagnostic events.
    rotate_diagnostics_file(time.time())
    def maintain_diagnostics():
        while True:
            time.sleep(3600)
            with DIAGNOSTICS_LOCK:
                rotate_diagnostics_file(time.time())
    threading.Thread(target=maintain_diagnostics, daemon=True).start()
    if (os.getenv("SELKIES_DROP_DOWNLOAD_ENABLED", "true").lower() in ("1", "true", "yes")
            and "download" in os.getenv("SELKIES_FILE_TRANSFERS", "upload,download")
            and os.getenv("HARDEN_DESKTOP", "false").lower() not in ("1", "true", "yes")):
        from container_download import Downloads
        try:
            DOWNLOADS = Downloads(download_identity)
            DOWNLOADS.start()
        except (OSError, ValueError) as error:
            print("[dock-download] initialization failed:", type(error).__name__, flush=True)
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as httpd:
        httpd.serve_forever()
