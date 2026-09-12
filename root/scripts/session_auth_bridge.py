#!/usr/bin/env python3
import hashlib
import hmac
import http.server
import json
import os
import secrets
import time
import threading
import base64
import urllib.error
import urllib.request
from http import HTTPStatus
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs, urlparse


PORT = int(os.environ.get("SELKIES_SESSION_AUTH_PORT", "38082"))
PASSWORD = os.environ.get("PASSWORD", "")
SESSION_MODE = os.environ.get("SELKIES_SESSION_MODE", "pin-takeover")
STATE_PATH = Path(os.environ.get("SELKIES_SESSION_STATE_PATH", "/run/selkies-active-session.json"))
COOKIE_NAME = os.environ.get("SELKIES_SESSION_COOKIE_NAME", "selkies_session")
COOKIE_PATH = os.environ.get("SELKIES_SESSION_COOKIE_PATH", os.environ.get("SUBFOLDER", "/") or "/")
SLEEP_MANAGER_PORT = int(os.environ.get("SELKIES_CONTAINER_SLEEP_PORT", "38083"))
SLEEP_MANAGER_URL = f"http://127.0.0.1:{SLEEP_MANAGER_PORT}"
SLEEP_WAKE_TIMEOUT_SECONDS = float(os.environ.get("SELKIES_CONTAINER_SLEEP_WAKE_TIMEOUT_SECONDS", "45") or "45")
SLEEP_ENABLED = os.environ.get("SELKIES_CONTAINER_SLEEP", "false").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
SLEEP_STATE_PATH = Path(os.environ.get("SELKIES_CONTAINER_SLEEP_STATE_PATH", "/run/selkies-container-sleep.json"))
UPLOAD_ENABLED = os.environ.get("SELKIES_UPLOAD_ENABLED", "true").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
UPLOAD_ROOT = os.environ.get("SELKIES_UPLOAD_DIR", os.environ.get("FILE_MANAGER_PATH", "/config/uploads"))
UPLOAD_MAX_FILE_SIZE = int(os.environ.get("SELKIES_UPLOAD_MAX_FILE_SIZE", "2147483648"))
UPLOAD_TOKEN_TTL_SECONDS = max(30, int(os.environ.get("SELKIES_UPLOAD_TOKEN_TTL_SECONDS", "300")))
UPLOAD_CHUNK_SIZE = int(os.environ.get("SELKIES_UPLOAD_CHUNK_SIZE", "524288"))
UPLOAD_MAX_CONCURRENCY = int(os.environ.get("SELKIES_UPLOAD_MAX_CONCURRENCY", "3"))
UPLOAD_ALLOW_OVERWRITE = os.environ.get("SELKIES_UPLOAD_ALLOW_OVERWRITE", "false").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
PREFERENCES_PATH = Path(os.environ.get("SELKIES_UI_PREFERENCES_PATH", "/config/state/ui-preferences.json"))
PREFERENCES_LOCK = threading.Lock()
TOOL_PREFERENCES = {
    "notification_center_enabled", "dock_network_monitor_enabled", "legacy_upload_fallback_enabled",
    "bottom_action_clipboard_buttons_enabled", "bottom_action_dock_position",
    "bottom_action_dock_collapsed", "input_sampling_multiplier",
}


def read_preferences():
    try:
        payload = json.loads(PREFERENCES_PATH.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except FileNotFoundError:
        return {}


def update_preferences(patch):
    clean = {}
    for key, value in patch.items():
        if key in TOOL_PREFERENCES:
            if key == "bottom_action_dock_position":
                if value not in ("top", "bottom"):
                    raise ValueError("Invalid dock position")
                clean[key] = value
            elif key == "input_sampling_multiplier":
                if isinstance(value, bool):
                    raise ValueError("Invalid input sampling multiplier")
                try:
                    multiplier = float(value)
                except (TypeError, ValueError):
                    raise ValueError("Invalid input sampling multiplier")
                if not (0.5 <= multiplier <= 2):
                    raise ValueError("Invalid input sampling multiplier")
                clean[key] = round(multiplier, 2)
            elif isinstance(value, bool) or value in ("true", "false"):
                clean[key] = value is True or value == "true"
            else:
                raise ValueError("Invalid toggle")
        elif key.startswith("download_favorites:") and len(key) <= 2048:
            if not isinstance(value, list) or len(value) > 20:
                raise ValueError("Invalid favorites")
            entries = []
            for item in value:
                if not isinstance(item, dict):
                    raise ValueError("Invalid favorite")
                path, name = item.get("path"), item.get("name")
                if (not isinstance(path, str) or len(path) > 4096 or
                    path.startswith("/") or "\\" in path or "\x00" in path or
                    (path and any(part in ("", ".", "..") for part in path.split("/"))) or
                    not isinstance(name, str) or not name.strip() or len(name) > 80):
                    raise ValueError("Invalid favorite path or name")
                if not any(entry["path"] == path for entry in entries):
                    entries.append({"path": path, "name": name.strip()})
            clean[key] = entries
        else:
            raise ValueError("Unknown preference")
    with PREFERENCES_LOCK:
        state = read_preferences()
        state.update(clean)
        body = json.dumps(state, ensure_ascii=False)
        if len(body.encode("utf-8")) > 262144:
            raise ValueError("Preferences are too large")
        PREFERENCES_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary = PREFERENCES_PATH.with_suffix(".tmp")
        temporary.write_text(body, encoding="utf-8")
        temporary.replace(PREFERENCES_PATH)
        return state


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


def normalize_cookie_path(path):
    path = str(path or "/")
    if not path.startswith("/"):
        path = "/" + path
    if not path.endswith("/"):
        path += "/"
    return path


COOKIE_PATH = normalize_cookie_path(COOKIE_PATH)


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


def write_state(state):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = STATE_PATH.with_suffix(STATE_PATH.suffix + ".tmp")
    tmp_path.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")
    tmp_path.replace(STATE_PATH)


def ensure_upload_signing_key(state):
    state = dict(state or {})
    if not state.get("upload_signing_key"):
        state["upload_signing_key"] = secrets.token_urlsafe(48)
    return state


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


def sleep_manager_json(path, method="GET", timeout=1.0):
    req = urllib.request.Request(f"{SLEEP_MANAGER_URL}{path}", method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return resp.status, json.loads(body or "{}")
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8", errors="replace") or "{}")
        except Exception:
            payload = {}
        return exc.code, payload
    except Exception:
        return 0, {}


def is_container_sleeping():
    status, payload = sleep_manager_json("/status", timeout=0.6)
    if status == 200:
        return bool(payload.get("sleeping"))
    if not SLEEP_ENABLED:
        return False
    try:
        state = json.loads(SLEEP_STATE_PATH.read_text(encoding="utf-8"))
        return bool(isinstance(state, dict) and state.get("sleeping"))
    except Exception:
        return False


def wake_container_for_pin():
    if not is_container_sleeping():
        return True
    deadline = time.time() + max(1.0, SLEEP_WAKE_TIMEOUT_SECONDS)
    while time.time() < deadline:
        status, payload = sleep_manager_json("/wake", method="POST", timeout=10.0)
        if status == 200 and payload.get("ok") and not payload.get("sleeping"):
            return True
        time.sleep(0.5)
    return False


def request_has_valid_session(handler):
    token = parse_cookie(handler.headers.get("Cookie"))
    if is_valid_token(token):
        return True

    session_id, session_epoch = parse_session_identity_from_query(urlparse(handler.path).query)
    if is_valid_session_identity(session_id, session_epoch):
        return True

    session_id, session_epoch = parse_session_identity_from_url(handler.headers.get("X-Original-URI"))
    return is_valid_session_identity(session_id, session_epoch)


def new_session():
    now_ms = int(time.time() * 1000)
    session_id = "sid_" + secrets.token_urlsafe(18).replace("-", "").replace("_", "")
    token = "st_" + secrets.token_urlsafe(32)
    state = ensure_upload_signing_key({
        "session_id": session_id,
        "session_epoch": now_ms,
        "token_hash": token_digest(token),
        "issued_at": now_ms,
        "mode": SESSION_MODE,
    })
    write_state(state)
    return token, state


def base64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def issue_upload_token():
    state = ensure_upload_signing_key(read_state())
    if not state.get("session_id") and not PASSWORD:
        state.update(
            {
                "session_id": "anonymous",
                "session_epoch": int(time.time() * 1000),
                "issued_at": int(time.time() * 1000),
                "mode": SESSION_MODE,
            }
        )
    write_state(state)
    now = int(time.time())
    claims = {
        "v": 1,
        "sid": str(state.get("session_id") or ""),
        "epoch": int(state.get("session_epoch") or 0),
        "iat": now,
        "exp": now + UPLOAD_TOKEN_TTL_SECONDS,
        "root": UPLOAD_ROOT,
        "max_file_size": UPLOAD_MAX_FILE_SIZE,
        "overwrite": UPLOAD_ALLOW_OVERWRITE,
    }
    encoded = base64url(json.dumps(claims, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = base64url(
        hmac.new(
            str(state["upload_signing_key"]).encode("utf-8"),
            encoded.encode("ascii"),
            hashlib.sha256,
        ).digest()
    )
    return f"{encoded}.{signature}", claims


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
        if len(suffix) != 8 or not suffix.isdigit():
            continue
        if suffix <= cutoff:
            try:
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
    filtered = strip_periodic_samples(payload)
    records = filtered.get("records") if isinstance(filtered, dict) else None
    if isinstance(records, list) and not records:
        # Heartbeats only: keep the log for real events.
        return
    rotate_diagnostics_file(time.time())
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


def cookie_header(token, max_age=None):
    parts = [
        f"{COOKIE_NAME}={token}",
        f"Path={COOKIE_PATH}",
        "HttpOnly",
        "SameSite=Lax",
    ]
    if max_age is not None:
        parts.append(f"Max-Age={int(max_age)}")
    return "; ".join(parts)


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
        if path == "/preferences":
            if not request_has_valid_session(self):
                self.send_json(HTTPStatus.UNAUTHORIZED, {"ok": False})
                return
            try:
                self.send_json(HTTPStatus.OK, {"ok": True, "preferences": read_preferences()})
            except (OSError, ValueError):
                self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False})
            return
        if path == "/health":
            self.send_json(HTTPStatus.OK, {"ok": True})
            return
        if path == "/check":
            if not PASSWORD:
                self.send_empty(HTTPStatus.NO_CONTENT)
                return
            if is_container_sleeping():
                self.send_empty(HTTPStatus.IM_A_TEAPOT)
                return
            if not request_has_valid_session(self):
                self.send_empty(HTTPStatus.UNAUTHORIZED)
                return
            self.send_empty(HTTPStatus.NO_CONTENT)
            return
        if path == "/session":
            if not PASSWORD:
                self.send_json(HTTPStatus.OK, {"ok": True, "enabled": False})
                return
            if not request_has_valid_session(self):
                self.send_json(HTTPStatus.UNAUTHORIZED, {"ok": False, "stale": True})
                return
            state = read_state()
            sleeping = is_container_sleeping()
            self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "enabled": True,
                    "session_id": state.get("session_id", ""),
                    "session_epoch": state.get("session_epoch", 0),
                    "mode": state.get("mode", SESSION_MODE),
                    "sleeping": sleeping,
                },
            )
            return
        self.send_empty(HTTPStatus.NOT_FOUND)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/preferences":
            if not request_has_valid_session(self):
                self.send_json(HTTPStatus.UNAUTHORIZED, {"ok": False})
                return
            patch = self.read_json_body()
            if patch is None:
                self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False})
                return
            try:
                state = update_preferences(patch)
                self.send_json(HTTPStatus.OK, {"ok": True, "preferences": state})
            except ValueError:
                self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False})
            except OSError:
                self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False})
            return
        if path == "/upload-token":
            if not UPLOAD_ENABLED:
                self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "disabled": True})
                return
            if not request_has_valid_session(self):
                self.send_json(HTTPStatus.UNAUTHORIZED, {"ok": False, "stale": True})
                return
            token, claims = issue_upload_token()
            self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "token": token,
                    "expires_at": claims["exp"],
                    "session_id": claims["sid"],
                    "session_epoch": claims["epoch"],
                    "max_file_size": claims["max_file_size"],
                    "overwrite": claims["overwrite"],
                    "chunk_size": UPLOAD_CHUNK_SIZE,
                    "max_concurrency": UPLOAD_MAX_CONCURRENCY,
                },
            )
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
        if path == "/pin":
            if not PASSWORD:
                self.send_empty(HTTPStatus.NO_CONTENT)
                return
            pin = self.headers.get("X-PIN", "")
            if not hmac.compare_digest(pin, PASSWORD):
                self.send_empty(HTTPStatus.UNAUTHORIZED)
                return
            if not wake_container_for_pin():
                self.send_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {"ok": False, "wakeup_failed": True},
                )
                return
            token, state = new_session()
            self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "session_id": state["session_id"],
                    "session_epoch": state["session_epoch"],
                },
                {"Set-Cookie": cookie_header(token)},
            )
            return
        if path == "/logout":
            token = parse_cookie(self.headers.get("Cookie"))
            state = read_state()
            if token and state.get("token_hash") == token_digest(token):
                write_state({})
            self.send_empty(HTTPStatus.NO_CONTENT, {"Set-Cookie": cookie_header("", 0)})
            return
        self.send_empty(HTTPStatus.NOT_FOUND)


if __name__ == "__main__":
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    initial_state = ensure_upload_signing_key(read_state())
    if not initial_state.get("session_id") and not PASSWORD:
        now_ms = int(time.time() * 1000)
        initial_state.update(
            {
                "session_id": "anonymous",
                "session_epoch": now_ms,
                "issued_at": now_ms,
                "mode": SESSION_MODE,
            }
        )
    write_state(initial_state)
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as httpd:
        httpd.serve_forever()
