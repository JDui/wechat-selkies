#!/usr/bin/env python3
import hashlib
import hmac
import http.server
import json
import os
import secrets
import time
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
    state = {
        "session_id": session_id,
        "session_epoch": now_ms,
        "token_hash": token_digest(token),
        "issued_at": now_ms,
        "mode": SESSION_MODE,
    }
    write_state(state)
    return token, state


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

    def do_GET(self):
        path = urlparse(self.path).path
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
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as httpd:
        httpd.serve_forever()
