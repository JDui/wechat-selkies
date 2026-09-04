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
FRONTEND_ACTIVITY_STATE_PATH = Path(
    os.environ.get("SELKIES_FRONTEND_ACTIVITY_STATE_PATH", "/tmp/selkies-frontend-activity.json")
)
MODE_STATE_PATH = Path(os.environ.get("NOTIFICATION_BRIDGE_MODE_PATH", "/config/state/notification-bridge.json"))
STATE_PATH = Path(os.environ.get("SELKIES_CONTAINER_SLEEP_STATE_PATH", "/run/selkies-container-sleep.json"))
IDLE_SECONDS = max(15, int(os.environ.get("SELKIES_CONTAINER_SLEEP_IDLE_SECONDS", "180") or "180"))
CHECK_SECONDS = max(2, int(os.environ.get("SELKIES_CONTAINER_SLEEP_CHECK_SECONDS", "5") or "5"))
STARTUP_GRACE_SECONDS = max(
    15, int(os.environ.get("SELKIES_CONTAINER_SLEEP_STARTUP_GRACE_SECONDS", "180") or "180")
)
WAKE_VERIFY_SECONDS = max(1, int(os.environ.get("SELKIES_CONTAINER_SLEEP_WAKE_VERIFY_SECONDS", "8") or "8"))
WARNING_SECONDS = max(15, min(300, int(os.environ.get("SELKIES_CONTAINER_SLEEP_WARNING_SECONDS", "60") or "60")))
ADAPTIVE_SLEEP_IDLE_OPTIONS = {60, 900, 1800, 2700, 3600}
ACTIVITY_FUTURE_SKEW_SECONDS = max(
    0, int(os.environ.get("SELKIES_CONTAINER_SLEEP_ACTIVITY_FUTURE_SKEW_SECONDS", "30") or "30")
)
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


def normalize_timestamp(value, default=0.0):
    try:
        ts = float(value)
    except Exception:
        return default
    if ts > 10_000_000_000:
        ts = ts / 1000.0
    if ts < 0:
        return default
    return ts


def sanitize_adaptive_sleep_idle_seconds(value):
    try:
        seconds = int(str(value).strip())
    except Exception:
        seconds = int(os.environ.get("SELKIES_ADAPTIVE_SLEEP_IDLE_SECONDS", "3600") or "3600")
    if seconds not in ADAPTIVE_SLEEP_IDLE_OPTIONS:
        seconds = 3600
    return seconds


def mode_bool(value, fallback=False):
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off"):
        return False
    return fallback


def read_json(path, default=None):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else (default or {})
    except Exception:
        return default or {}


def read_sleep_mode_config():
    payload = read_json(MODE_STATE_PATH, {})
    idle_seconds = sanitize_adaptive_sleep_idle_seconds(
        payload.get("adaptive_sleep_idle_seconds", os.environ.get("SELKIES_ADAPTIVE_SLEEP_IDLE_SECONDS", "3600"))
    )
    if (
        not bool(payload.get("adaptive_sleep_idle_seconds_user_set", False))
        and idle_seconds == 60
        and sanitize_adaptive_sleep_idle_seconds(os.environ.get("SELKIES_ADAPTIVE_SLEEP_IDLE_SECONDS", "3600")) == 3600
    ):
        idle_seconds = 3600
    return {
        "sleep_settings_updated_at": normalize_timestamp(payload.get("sleep_settings_updated_at")),
        "adaptive_sleep_enabled": mode_bool(payload.get("adaptive_sleep_enabled"), False),
        "adaptive_sleep_idle_seconds": idle_seconds,
    }


def write_frontend_activity(ts=None):
    timestamp = time.time()  # Browser clocks may differ by minutes or hours.
    try:
        FRONTEND_ACTIVITY_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "updated_at": time.time(),
            "last_interaction_at": timestamp,
        }
        tmp_path = FRONTEND_ACTIVITY_STATE_PATH.with_suffix(FRONTEND_ACTIVITY_STATE_PATH.suffix + ".tmp")
        tmp_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        tmp_path.replace(FRONTEND_ACTIVITY_STATE_PATH)
    except Exception as exc:
        log(f"failed to persist frontend activity: {exc}")
    return timestamp


def latest_frontend_interaction_at():
    payload = read_json(FRONTEND_ACTIVITY_STATE_PATH, {})
    now = time.time()
    received_at = normalize_timestamp(payload.get("updated_at"), 0.0)
    candidates = []
    for key in ("last_interaction_at", "interaction_at"):
        ts = normalize_timestamp(payload.get(key), 0.0)
        if ts <= 0:
            continue
        if ts > now + ACTIVITY_FUTURE_SKEW_SECONDS:
            if received_at > 0:
                candidates.append(received_at)
            continue
        candidates.append(min(ts, now))
    return max(candidates) if candidates else 0.0


def awake_clients_snapshot(now=None):
    now = now or time.time()
    payload = read_json(AWAKE_STATE_PATH, {})
    clients = payload.get("clients") if isinstance(payload.get("clients"), list) else []
    active_clients = []
    recent_clients = []
    last_awake_at = 0.0
    for item in clients:
        if not isinstance(item, dict):
            continue
        updated_at = normalize_timestamp(item.get("updated_at"), 0.0)
        if updated_at <= 0:
            continue
        if updated_at > now + ACTIVITY_FUTURE_SKEW_SECONDS:
            updated_at = now
        client = {
            "awake": bool(item.get("awake")),
            "updated_at": updated_at,
            "display_id": item.get("display_id") or "",
        }
        recent = now - updated_at <= 45.0
        if recent:
            recent_clients.append(client)
        if client["awake"] and recent:
            active_clients.append(client)
            last_awake_at = max(last_awake_at, updated_at)
    updated_at = normalize_timestamp(payload.get("updated_at"), 0.0)
    if updated_at > now + ACTIVITY_FUTURE_SKEW_SECONDS:
        updated_at = now
    return {
        "updated_at": updated_at,
        "state_age_seconds": max(0.0, now - updated_at) if updated_at > 0 else None,
        "awake_clients": len(active_clients),
        "recent_clients": len(recent_clients),
        "any_awake": bool(active_clients),
        "last_awake_at": last_awake_at,
    }


def idle_reference(now, last_interaction_at):
    settings_at = min(now, read_sleep_mode_config()["sleep_settings_updated_at"])
    return max(last_interaction_at, started_at, settings_at), "server-activity-or-settings"


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
            "pending_sleep": False,
        }
    state["enabled"] = is_feature_enabled()
    state.setdefault("sleeping", False)
    state.setdefault("frozen_pids", [])
    state.setdefault("updated_at", time.time())
    state.setdefault("pending_sleep", False)
    return state


def clear_pending_sleep(reason="interaction"):
    state = read_state()
    if not state.get("pending_sleep"):
        return state
    state.update(
        {
            "pending_sleep": False,
            "pending_cleared_reason": reason,
            "pending_cleared_at": time.time(),
            "warning_started_at": 0.0,
            "warning_deadline_at": 0.0,
            "updated_at": time.time(),
        }
    )
    write_state(state)
    log(f"cleared sleep warning reason={reason}")
    return state


def begin_pending_sleep(idle_seconds, last_interaction_at):
    now = time.time()
    state = read_state()
    state.update(
        {
            "enabled": is_feature_enabled(),
            "sleeping": False,
            "pending_sleep": True,
            "warning_started_at": now,
            "warning_deadline_at": now + WARNING_SECONDS,
            "warning_seconds": WARNING_SECONDS,
            "idle_seconds": int(idle_seconds),
            "last_interaction_at": float(last_interaction_at or 0.0),
            "updated_at": now,
        }
    )
    write_state(state)
    log(f"started sleep warning idle_seconds={idle_seconds} warning_seconds={WARNING_SECONDS}")
    return state


def status_payload():
    now = time.time()
    state = read_state()
    config = read_sleep_mode_config()
    last_interaction_at = latest_frontend_interaction_at()
    idle_seconds = int(config["adaptive_sleep_idle_seconds"])
    reference_at, reference_reason = idle_reference(now, last_interaction_at)
    idle_for = max(0.0, now - reference_at)
    awake_state = awake_clients_snapshot(now)
    warning_deadline_at = normalize_timestamp(state.get("warning_deadline_at"), 0.0)
    pending_sleep = bool(state.get("pending_sleep")) and not bool(state.get("sleeping"))
    warning_remaining = max(0.0, warning_deadline_at - now) if pending_sleep else 0.0
    if not is_feature_enabled():
        sleep_block_reason = "feature-disabled"
    elif not bool(config["adaptive_sleep_enabled"]):
        sleep_block_reason = "adaptive-sleep-disabled"
    elif bool(state.get("sleeping")):
        sleep_block_reason = "sleeping"
    elif now - started_at < STARTUP_GRACE_SECONDS:
        sleep_block_reason = "startup-grace"
    elif idle_for < idle_seconds:
        sleep_block_reason = "idle-window"
    elif pending_sleep and awake_state["any_awake"]:
        sleep_block_reason = "warning-countdown"
    else:
        sleep_block_reason = "ready"
    payload = dict(state)
    payload.update(
        {
            "ok": True,
            "feature_enabled": is_feature_enabled(),
            "adaptive_sleep_enabled": bool(config["adaptive_sleep_enabled"]),
            "adaptive_sleep_idle_seconds": idle_seconds,
            "idle_seconds": idle_seconds,
            "warning_seconds": WARNING_SECONDS,
            "last_interaction_at": last_interaction_at,
            "idle_reference_at": reference_at,
            "idle_reference_reason": reference_reason,
            "idle_for_seconds": idle_for,
            "idle_remaining_seconds": max(0.0, idle_seconds - idle_for),
            "awake_clients": awake_state["awake_clients"],
            "recent_clients": awake_state["recent_clients"],
            "any_awake": awake_state["any_awake"],
            "awake_state_age_seconds": awake_state["state_age_seconds"],
            "last_awake_at": awake_state["last_awake_at"],
            "pending_sleep": pending_sleep,
            "warning_remaining_seconds": warning_remaining,
            "sleep_block_reason": sleep_block_reason,
            "updated_at": now,
        }
    )
    return payload


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
            "pending_sleep": False,
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
            "pending_sleep": False,
            "reason": reason,
            "left_at": time.time(),
            "updated_at": time.time(),
            "frozen_pids": [],
            "resumed_count": resumed,
        }
        write_state(payload)
        write_frontend_activity()
        if pids:
            log(f"left internal sleep reason={reason} resumed={resumed}/{len(pids)}")
        return True


def awake_clients_active():
    return bool(awake_clients_snapshot().get("any_awake"))


def monitor_loop():
    global idle_since
    write_state(read_state())
    while True:
        time.sleep(CHECK_SECONDS)
        try:
            with state_lock:
                config = read_sleep_mode_config()
                adaptive_enabled = bool(config["adaptive_sleep_enabled"])
                idle_seconds = int(config["adaptive_sleep_idle_seconds"])
                if not is_feature_enabled() or not adaptive_enabled:
                    if read_state().get("sleeping"):
                        leave_sleep("disabled")
                    clear_pending_sleep("disabled")
                    idle_since = 0.0
                    continue
                state = read_state()
                if state.get("sleeping"):
                    continue
                now = time.time()
                if now - started_at < STARTUP_GRACE_SECONDS:
                    clear_pending_sleep("startup grace")
                    idle_since = 0.0
                    continue

                last_interaction_at = latest_frontend_interaction_at()
                reference_at, reference_reason = idle_reference(now, last_interaction_at)
                awake_state = awake_clients_snapshot(now)
                pending_started_at = normalize_timestamp(state.get("warning_started_at"), 0.0)
                if state.get("pending_sleep") and last_interaction_at > pending_started_at:
                    clear_pending_sleep("client interaction")
                    idle_since = 0.0
                    continue

                idle_for = now - reference_at
                if idle_for < idle_seconds:
                    clear_pending_sleep("client interaction")
                    idle_since = 0.0
                    continue

                if state.get("pending_sleep") and not awake_state["any_awake"]:
                    log(
                        "sleep warning skipped because no awake clients remain "
                        f"idle_for={idle_for:.1f} reference={reference_reason}"
                    )
                    enter_sleep("idle timeout no awake clients")
                    continue

                if not state.get("pending_sleep"):
                    if not awake_state["any_awake"]:
                        log(
                            "idle timeout reached with no awake clients "
                            f"idle_for={idle_for:.1f} reference={reference_reason}"
                        )
                        enter_sleep("idle timeout no awake clients")
                        continue
                    begin_pending_sleep(idle_seconds, last_interaction_at)
                    idle_since = now
                    continue

                deadline_at = normalize_timestamp(state.get("warning_deadline_at"), 0.0)
                if deadline_at > 0 and now >= deadline_at:
                    enter_sleep("idle interaction timeout")
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
            self.send_json(HTTPStatus.OK, status_payload())
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"ok": False})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/activity":
            length = int(self.headers.get("Content-Length", "0") or "0")
            payload = {}
            if length > 0:
                try:
                    body = self.rfile.read(min(length, 32768))
                    payload = json.loads(body.decode("utf-8", errors="replace") or "{}")
                except Exception:
                    payload = {}
            with state_lock:
                recorded_at = write_frontend_activity()
                clear_pending_sleep("client interaction")
            response = status_payload()
            response["recorded_interaction_at"] = recorded_at
            self.send_json(HTTPStatus.OK, response)
            return
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
