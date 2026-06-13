#!/usr/bin/env python3
import http.server
import json
import os
import signal
import threading
import time
from http import HTTPStatus
from pathlib import Path
from urllib.parse import urlparse


PORT = int(os.environ.get("SELKIES_CONTAINER_SLEEP_PORT", "38083"))
ENABLED = os.environ.get("SELKIES_CONTAINER_SLEEP", "false").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
REQUIRE_PIN = os.environ.get("SELKIES_CONTAINER_SLEEP_REQUIRE_PIN", "true").strip().lower() not in (
    "0",
    "false",
    "no",
    "off",
)
PASSWORD = os.environ.get("PASSWORD", "")
AWAKE_STATE_PATH = Path(os.environ.get("SELKIES_AWAKE_STATE_PATH", "/tmp/selkies-client-awake.json"))
STATE_PATH = Path(os.environ.get("SELKIES_CONTAINER_SLEEP_STATE_PATH", "/run/selkies-container-sleep.json"))
IDLE_SECONDS = max(15, int(os.environ.get("SELKIES_CONTAINER_SLEEP_IDLE_SECONDS", "180") or "180"))
CHECK_SECONDS = max(2, int(os.environ.get("SELKIES_CONTAINER_SLEEP_CHECK_SECONDS", "5") or "5"))
STARTUP_GRACE_SECONDS = max(
    15, int(os.environ.get("SELKIES_CONTAINER_SLEEP_STARTUP_GRACE_SECONDS", "180") or "180")
)
WAKE_VERIFY_SECONDS = max(1, int(os.environ.get("SELKIES_CONTAINER_SLEEP_WAKE_VERIFY_SECONDS", "8") or "8"))
LOG_PREFIX = "[container-sleep]"

PROTECTED_CMD_PATTERNS = (
    "container_sleep_manager.py",
    "session_auth_bridge.py",
    "nginx",
    "s6-",
    "/init",
    "s6-svscan",
    "s6-supervise",
    "s6-linux-init",
    "s6-rc",
)
PROTECTED_COMM_NAMES = {
    "init",
    "nginx",
    "s6-svscan",
    "s6-supervise",
    "s6-rc",
    "s6-ipcserverd",
}

state_lock = threading.RLock()
started_at = time.time()
idle_since = 0.0


def log(message):
    print(f"{LOG_PREFIX} {time.strftime('%Y-%m-%dT%H:%M:%S%z')} {message}", flush=True)


def is_feature_enabled():
    if not ENABLED:
        return False
    if REQUIRE_PIN and not PASSWORD:
        return False
    return True


def read_json(path, default=None):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else (default or {})
    except Exception:
        return default or {}


def write_state(payload):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = STATE_PATH.with_suffix(STATE_PATH.suffix + ".tmp")
    tmp_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    tmp_path.replace(STATE_PATH)


def read_state():
    state = read_json(STATE_PATH, {})
    if not state:
        return {
            "sleeping": False,
            "enabled": is_feature_enabled(),
            "updated_at": time.time(),
            "frozen_pids": [],
        }
    state["enabled"] = is_feature_enabled()
    state.setdefault("sleeping", False)
    state.setdefault("frozen_pids", [])
    state.setdefault("updated_at", time.time())
    return state


def proc_cmdline(pid):
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
        return raw.replace(b"\x00", b" ").decode("utf-8", errors="replace").strip()
    except Exception:
        return ""


def proc_comm(pid):
    try:
        return Path(f"/proc/{pid}/comm").read_text(encoding="utf-8", errors="replace").strip()
    except Exception:
        return ""


def proc_state(pid):
    try:
        text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8", errors="replace")
        right = text.rfind(")")
        return text[right + 2 :].split(" ", 1)[0] if right >= 0 else ""
    except Exception:
        return ""


def current_ancestor_pids():
    pids = set()
    pid = os.getpid()
    while pid and pid not in pids:
        pids.add(pid)
        try:
            with open(f"/proc/{pid}/stat", "r", encoding="utf-8", errors="replace") as handle:
                text = handle.read()
            right = text.rfind(")")
            fields = text[right + 2 :].split()
            pid = int(fields[1]) if len(fields) > 1 else 0
        except Exception:
            break
    pids.add(1)
    return pids


def is_protected_process(pid, protected_pids):
    if pid in protected_pids or pid <= 1:
        return True
    cmdline = proc_cmdline(pid)
    comm = proc_comm(pid)
    if comm in PROTECTED_COMM_NAMES:
        return True
    haystack = f"{comm} {cmdline}"
    return any(pattern in haystack for pattern in PROTECTED_CMD_PATTERNS)


def list_freezable_pids():
    protected_pids = current_ancestor_pids()
    pids = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if is_protected_process(pid, protected_pids):
            continue
        state = proc_state(pid)
        if state in ("", "Z", "X", "T", "t"):
            continue
        cmdline = proc_cmdline(pid)
        if not cmdline:
            continue
        pids.append(pid)
    return sorted(pids, reverse=True)


def send_signal(pid, sig):
    try:
        os.kill(pid, sig)
        return True
    except ProcessLookupError:
        return False
    except PermissionError as exc:
        log(f"permission denied signaling pid={pid} sig={sig}: {exc}")
        return False
    except Exception as exc:
        log(f"failed signaling pid={pid} sig={sig}: {exc}")
        return False


def enter_sleep(reason="idle"):
    with state_lock:
        if not is_feature_enabled():
            return False
        state = read_state()
        if state.get("sleeping"):
            return True
        pids = list_freezable_pids()
        frozen = []
        for pid in pids:
            if send_signal(pid, signal.SIGSTOP):
                frozen.append(pid)
        payload = {
            "enabled": True,
            "sleeping": True,
            "reason": reason,
            "entered_at": time.time(),
            "updated_at": time.time(),
            "frozen_pids": frozen,
            "frozen_count": len(frozen),
        }
        write_state(payload)
        log(f"entered internal sleep reason={reason} frozen={len(frozen)}")
        return True


def leave_sleep(reason="pin"):
    with state_lock:
        state = read_state()
        pids = [int(pid) for pid in state.get("frozen_pids", []) if str(pid).isdigit()]
        resumed = 0
        for pid in pids:
            if send_signal(pid, signal.SIGCONT):
                resumed += 1
        payload = {
            "enabled": is_feature_enabled(),
            "sleeping": False,
            "reason": reason,
            "left_at": time.time(),
            "updated_at": time.time(),
            "frozen_pids": [],
            "resumed_count": resumed,
        }
        write_state(payload)
        if pids:
            log(f"left internal sleep reason={reason} resumed={resumed}/{len(pids)}")
        return True


def awake_clients_active():
    payload = read_json(AWAKE_STATE_PATH, {})
    now = time.time()
    clients = payload.get("clients") if isinstance(payload.get("clients"), list) else []
    for item in clients:
        if not isinstance(item, dict):
            continue
        updated_at = float(item.get("updated_at", 0.0) or 0.0)
        if item.get("awake") and updated_at > 0 and now - updated_at <= 45.0:
            return True
    return bool(payload.get("any_awake")) and now - float(payload.get("updated_at", 0.0) or 0.0) <= 45.0


def monitor_loop():
    global idle_since
    write_state(read_state())
    while True:
        time.sleep(CHECK_SECONDS)
        try:
            if not is_feature_enabled():
                if read_state().get("sleeping"):
                    leave_sleep("disabled")
                idle_since = 0.0
                continue
            if read_state().get("sleeping"):
                continue
            if time.time() - started_at < STARTUP_GRACE_SECONDS:
                idle_since = 0.0
                continue
            if awake_clients_active():
                idle_since = 0.0
                continue
            if idle_since <= 0:
                idle_since = time.time()
                continue
            if time.time() - idle_since >= IDLE_SECONDS:
                enter_sleep("no awake clients")
        except Exception as exc:
            log(f"monitor error: {exc}")


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "ContainerSleepManager/1.0"

    def log_message(self, fmt, *args):
        return

    def send_json(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/health", "/status"):
            state = read_state()
            state["ok"] = True
            state["feature_enabled"] = is_feature_enabled()
            self.send_json(HTTPStatus.OK, state)
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"ok": False})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/wake":
            leave_sleep("pin")
            deadline = time.time() + WAKE_VERIFY_SECONDS
            while time.time() < deadline:
                if not read_state().get("sleeping"):
                    self.send_json(HTTPStatus.OK, {"ok": True, "sleeping": False})
                    return
                time.sleep(0.2)
            self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "sleeping": True})
            return
        if path == "/sleep":
            ok = enter_sleep("manual")
            self.send_json(HTTPStatus.OK if ok else HTTPStatus.SERVICE_UNAVAILABLE, {"ok": ok})
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"ok": False})


if __name__ == "__main__":
    log(
        "starting "
        f"enabled={ENABLED} require_pin={REQUIRE_PIN} "
        f"idle_seconds={IDLE_SECONDS} startup_grace={STARTUP_GRACE_SECONDS}"
    )
    threading.Thread(target=monitor_loop, daemon=True).start()
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as server:
        server.serve_forever()
