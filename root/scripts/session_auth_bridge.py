#!/usr/bin/env python3
import hashlib
import hmac
import http.server
import json
import os
import secrets
import time
from http import HTTPStatus
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import urlparse


PORT = int(os.environ.get("SELKIES_SESSION_AUTH_PORT", "38082"))
PASSWORD = os.environ.get("PASSWORD", "")
SESSION_MODE = os.environ.get("SELKIES_SESSION_MODE", "pin-takeover")
STATE_PATH = Path(os.environ.get("SELKIES_SESSION_STATE_PATH", "/run/selkies-active-session.json"))
COOKIE_NAME = os.environ.get("SELKIES_SESSION_COOKIE_NAME", "selkies_session")
COOKIE_PATH = os.environ.get("SELKIES_SESSION_COOKIE_PATH", os.environ.get("SUBFOLDER", "/") or "/")


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
            if not is_valid_token(parse_cookie(self.headers.get("Cookie"))):
                self.send_empty(HTTPStatus.UNAUTHORIZED)
                return
            self.send_empty(HTTPStatus.NO_CONTENT)
            return
        if path == "/session":
            token = parse_cookie(self.headers.get("Cookie"))
            if not PASSWORD:
                self.send_json(HTTPStatus.OK, {"ok": True, "enabled": False})
                return
            if not is_valid_token(token):
                self.send_json(HTTPStatus.UNAUTHORIZED, {"ok": False, "stale": True})
                return
            state = read_state()
            self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "enabled": True,
                    "session_id": state.get("session_id", ""),
                    "session_epoch": state.get("session_epoch", 0),
                    "mode": state.get("mode", SESSION_MODE),
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
