#!/usr/bin/env python3
import json
import os
import pathlib
import re
import subprocess
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from lan_discovery_common import (
    DEFAULT_BROADCAST_NAME,
    build_identity_payload,
    is_valid_broadcast_name,
    parse_bool,
    sanitize_broadcast_name,
)

try:
    import pulsectl
except Exception:
    pulsectl = None

try:
    from Xlib import X, display
except Exception:
    X = None
    display = None


def parse_int_env(name, default_value, min_value, max_value):
    raw = os.getenv(name, str(default_value)).strip()
    try:
        value = int(raw)
    except Exception:
        return default_value
    if value < min_value or value > max_value:
        return default_value
    return value


def parse_float_env(name, default_value, min_value, max_value):
    raw = os.getenv(name, str(default_value)).strip()
    try:
        value = float(raw)
    except Exception:
        return default_value
    if value < min_value or value > max_value:
        return default_value
    return value


HOST = os.getenv("NOTIFICATION_BRIDGE_HOST", "127.0.0.1")
PORT = parse_int_env("NOTIFICATION_BRIDGE_PORT", 38081, 1024, 65535)
MAX_EVENTS = parse_int_env("NOTIFICATION_BRIDGE_MAX_EVENTS", 256, 16, 4096)
FALLBACK_POLL_MS = parse_int_env("NOTIFICATION_BRIDGE_FALLBACK_POLL_MS", 1200, 300, 10000)
MODE_STATE_PATH = pathlib.Path(os.getenv("NOTIFICATION_BRIDGE_MODE_PATH", "/config/state/notification-bridge.json"))
LAN_DISCOVERY_STATUS_PATH = pathlib.Path(
    os.getenv("SELKIES_LAN_DISCOVERY_STATUS_PATH", "/config/state/lan-discovery-status.json")
)
DUNST_CONFIG_PATH = pathlib.Path(os.getenv("NOTIFICATION_BRIDGE_DUNST_CONFIG_PATH", "/config/.config/dunst/dunstrc"))
DUNST_DEFAULT_PATH = pathlib.Path(os.getenv("NOTIFICATION_BRIDGE_DUNST_DEFAULT_PATH", "/defaults/dunstrc"))
RAW_LOG_PATH = pathlib.Path(os.getenv("NOTIFICATION_BRIDGE_RAW_LOG_PATH", "/config/logs/notification-bridge-raw.log"))
RAW_LOG_MAX_BYTES = parse_int_env("NOTIFICATION_BRIDGE_RAW_LOG_MAX_BYTES", 10 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024)
AWAKE_STATE_PATH = pathlib.Path(os.getenv("SELKIES_AWAKE_STATE_PATH", "/tmp/selkies-client-awake.json"))
FRONTEND_ACTIVITY_STATE_PATH = pathlib.Path(
    os.getenv("SELKIES_NOTIFICATION_ACTIVITY_STATE_PATH", "/tmp/selkies-notification-activity.json")
)
IDLE_DEFOCUS_SECONDS = parse_int_env("NOTIFICATION_BRIDGE_IDLE_DEFOCUS_SECONDS", 600, 0, 1800)
ADAPTIVE_SLEEP_IDLE_OPTIONS = {60, 900, 1800, 2700, 3600}
ADAPTIVE_SLEEP_DEFAULT_IDLE_SECONDS = parse_int_env(
    "SELKIES_ADAPTIVE_SLEEP_IDLE_SECONDS", 3600, 60, 3600
)
if ADAPTIVE_SLEEP_DEFAULT_IDLE_SECONDS not in ADAPTIVE_SLEEP_IDLE_OPTIONS:
    ADAPTIVE_SLEEP_DEFAULT_IDLE_SECONDS = 3600
AUTO_SPLIT_DEFAULT_ENABLED = os.getenv("SELKIES_AUTO_SPLIT", "false").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
LAN_DISCOVERY_DEFAULT_ENABLED = parse_bool(
    os.getenv("SELKIES_LAN_DISCOVERY_DEFAULT_ENABLED"),
    False,
)
LAN_DISCOVERY_DEFAULT_NAME = sanitize_broadcast_name(
    os.getenv("SELKIES_LAN_DISCOVERY_DEFAULT_NAME"),
    DEFAULT_BROADCAST_NAME,
)
WECHAT_AUDIO_ENABLED = os.getenv("NOTIFICATION_BRIDGE_AUDIO_WECHAT_ENABLED", "true").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
WECHAT_AUDIO_PEAK_THRESHOLD = parse_float_env("NOTIFICATION_BRIDGE_AUDIO_PEAK_THRESHOLD", 0.095, 0.01, 1.0)
WECHAT_AUDIO_MIN_MS = parse_int_env("NOTIFICATION_BRIDGE_AUDIO_MIN_MS", 110, 50, 60000)
WECHAT_AUDIO_MAX_MS = parse_int_env("NOTIFICATION_BRIDGE_AUDIO_MAX_MS", 3000, 200, 120000)
WECHAT_AUDIO_DEDUPE_SECONDS = parse_float_env("NOTIFICATION_BRIDGE_AUDIO_DEDUPE_SECONDS", 10.0, 0.5, 120.0)
WECHAT_AUDIO_PEAK_SAMPLE_SECONDS = parse_float_env("NOTIFICATION_BRIDGE_AUDIO_PEAK_SAMPLE_SECONDS", 1.5, 0.1, 5.0)
WECHAT_FOCUS_COMMAND = os.getenv("WECHAT_FOCUS_COMMAND", "/scripts/wechat/wechat-focus.sh")
QQ_FOCUS_COMMAND = os.getenv("QQ_FOCUS_COMMAND", "/scripts/qq/qq-focus.sh")

QQ_HINTS = ("qq", "tencent qq", "\u817e\u8bafqq")
WECHAT_HINTS = ("wechat", "weixin", "\u5fae\u4fe1")
APP_DEFAULT_TITLES = {
    "wechat": {"\u5fae\u4fe1\uff08\u6d4b\u8bd5\u7248\uff09", "wechat beta", "wechat"},
    "qq": {"qq", "\u817e\u8bafqq"},
}
APP_SEARCH_PATTERNS = {
    "wechat": {
        "classes": ["wechat"],
        "names": ["\u5fae\u4fe1\uff08\u6d4b\u8bd5\u7248\uff09|WeChat Beta|WeChat"],
    },
    "qq": {
        "classes": ["qq"],
        "names": ["QQ|\u817e\u8bafQQ"],
    },
}
WECHAT_AUDIO_REJECT_HINTS = ("music", "video", "call", "voice")
IDLE_FOCUS_OPTIONS = {0, 60, 300, 600, 1800}


class EventQueue:
    def __init__(self, max_events):
        self._lock = threading.Lock()
        self._events = deque(maxlen=max_events)
        self._next_id = 1

    def push(self, event):
        with self._lock:
            payload = dict(event)
            payload["id"] = self._next_id
            self._next_id += 1
            now_ms = int(payload.get("ts") or time.time() * 1000)
            merge_key = (
                normalize_text(payload.get("app")),
                normalize_text(payload.get("title")),
            )
            events = list(self._events)
            for index in range(len(events) - 1, -1, -1):
                existing = events[index] or {}
                existing_key = (
                    normalize_text(existing.get("app")),
                    normalize_text(existing.get("title")),
                )
                try:
                    existing_ts = int(existing.get("ts") or 0)
                except Exception:
                    existing_ts = 0
                if existing_key == merge_key and abs(now_ms - existing_ts) < 8000:
                    events.pop(index)
                    events.append(payload)
                    self._events = deque(events, maxlen=self._events.maxlen)
                    return payload["id"]
            self._events.append(payload)
            return payload["id"]

    def pull(self, since_id):
        with self._lock:
            latest_id = self._events[-1]["id"] if self._events else 0
            reset_required = False
            if since_id > latest_id and self._events:
                events = list(self._events)
                reset_required = True
            else:
                events = [event for event in self._events if event["id"] > since_id]
            return events, latest_id, reset_required


QUEUE = EventQueue(MAX_EVENTS)
MODE_LOCK = threading.Lock()
RAW_LOG_LOCK = threading.Lock()
FRONTEND_ACTIVITY_LOCK = threading.Lock()
LAST_FRONTEND_INTERACTION_AT = 0.0
RAW_LOG_DISABLED = False
RECENT_EVENT_LOCK = threading.Lock()
RECENT_EVENT_KEYS = {}
EVENT_MERGE_WINDOW_SECONDS = 8.0


def normalize_text(value):
    return str(value or "").strip()


def lower_text(value):
    return normalize_text(value).lower()


def sanitize_mode(value):
    mode = str(value or "internal").strip().lower()
    if mode not in {"internal", "passthrough"}:
        mode = "internal"
    return mode


def sanitize_idle_focus_seconds(value):
    try:
        seconds = int(str(value).strip())
    except Exception:
        seconds = IDLE_DEFOCUS_SECONDS
    if seconds not in IDLE_FOCUS_OPTIONS:
        seconds = IDLE_DEFOCUS_SECONDS
    return seconds


def sanitize_adaptive_sleep_idle_seconds(value):
    try:
        seconds = int(str(value).strip())
    except Exception:
        seconds = ADAPTIVE_SLEEP_DEFAULT_IDLE_SECONDS
    if seconds not in ADAPTIVE_SLEEP_IDLE_OPTIONS:
        seconds = ADAPTIVE_SLEEP_DEFAULT_IDLE_SECONDS
    return seconds


def sanitize_bool(value, fallback=False):
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return bool(fallback)


def json_safe(value):
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe(item) for item in value]
    return normalize_text(value)


def clamp_text(value, max_len=2048):
    text = normalize_text(value)
    if len(text) <= max_len:
        return text
    return text[:max_len] + "..."


def trim_raw_log_unlocked(incoming_bytes):
    try:
        current_size = RAW_LOG_PATH.stat().st_size if RAW_LOG_PATH.exists() else 0
    except Exception:
        return
    incoming_size = len(incoming_bytes)
    if incoming_size >= RAW_LOG_MAX_BYTES:
        try:
            RAW_LOG_PATH.write_bytes(incoming_bytes[-RAW_LOG_MAX_BYTES:])
        except Exception:
            pass
        return
    if current_size + incoming_size <= RAW_LOG_MAX_BYTES:
        return
    keep_size = max(0, RAW_LOG_MAX_BYTES - incoming_size)
    try:
        with RAW_LOG_PATH.open("rb") as handle:
            handle.seek(max(0, current_size - keep_size))
            tail = handle.read(keep_size)
        with RAW_LOG_PATH.open("wb") as handle:
            handle.write(tail)
    except Exception:
        return


def detect_app(app_name, summary, body, icon_name):
    haystacks = [lower_text(app_name), lower_text(summary), lower_text(body), lower_text(icon_name)]
    joined = " ".join(haystacks)
    if any(token in joined for token in QQ_HINTS):
        return "qq"
    if any(token in joined for token in WECHAT_HINTS):
        return "wechat"
    return "other"


def run_text_command(command, timeout=3.0):
    try:
        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=timeout,
            check=False,
        )
    except Exception:
        return ""
    if result.returncode != 0:
        return ""
    return normalize_text(result.stdout)


def get_focused_window_id():
    if display is None or X is None:
        return None
    conn = None
    try:
        conn = display.Display()
        focus = conn.get_input_focus().focus
        focus_id = getattr(focus, "id", focus)
        if focus_id in (None, 0, X.NONE, X.PointerRoot):
            return ""
        return str(focus_id)
    except Exception:
        return None
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def get_active_app_payload():
    focused_wid = get_focused_window_id()
    if focused_wid is None:
        wid = run_text_command(["xdotool", "getactivewindow"], timeout=2.0)
    else:
        wid = focused_wid
    if not wid:
        return {"ok": True, "focused": False, "app": "other", "window_id": "", "title": "", "wm_class": ""}

    title = run_text_command(["xdotool", "getwindowname", wid], timeout=2.0)
    wm_class_raw = run_text_command(["xprop", "-id", wid, "WM_CLASS"], timeout=2.0)
    wm_class = ""
    if wm_class_raw:
        parts = [part.strip().strip('"') for part in wm_class_raw.split("=", 1)[-1].split(",")]
        wm_class = " ".join([part for part in parts if part])

    app = detect_app(wm_class, title, "", "")
    return {
        "ok": True,
        "focused": bool(wid),
        "app": app,
        "window_id": wid,
        "title": title,
        "wm_class": wm_class,
    }


def search_window_candidates(app):
    patterns = APP_SEARCH_PATTERNS.get(app, {})
    seen = set()
    ordered = []

    for class_name in patterns.get("classes", []):
        for only_visible in (True, False):
            command = ["xdotool", "search"]
            if only_visible:
                command.append("--onlyvisible")
            command.extend(["--class", class_name])
            output = run_text_command(command, timeout=2.0)
            if not output:
                continue
            for wid in output.splitlines():
                wid = normalize_text(wid)
                if not wid or wid in seen:
                    continue
                seen.add(wid)
                ordered.append(wid)

    for pattern in patterns.get("names", []):
        for only_visible in (True, False):
            command = ["xdotool", "search"]
            if only_visible:
                command.append("--onlyvisible")
            command.extend(["--name", pattern])
            output = run_text_command(command, timeout=2.0)
            if not output:
                continue
            for wid in output.splitlines():
                wid = normalize_text(wid)
                if not wid or wid in seen:
                    continue
                seen.add(wid)
                ordered.append(wid)

    return ordered


def window_property(wid, prop_name):
    return run_text_command(["xprop", "-id", wid, prop_name], timeout=2.0)


def window_is_visible(wid):
    state = window_property(wid, "_NET_WM_STATE")
    if not state:
        return False
    return "_NET_WM_STATE_HIDDEN" not in state


def window_is_normal(wid):
    value = window_property(wid, "_NET_WM_WINDOW_TYPE")
    return "_NET_WM_WINDOW_TYPE_NORMAL" in value if value else False


def window_is_transient(wid):
    value = window_property(wid, "WM_TRANSIENT_FOR")
    return "window id #" in value if value else False


def window_has_attention(wid):
    net_state = window_property(wid, "_NET_WM_STATE")
    hints = window_property(wid, "WM_HINTS")
    if "_NET_WM_STATE_DEMANDS_ATTENTION" in net_state:
        return True
    hints_lower = lower_text(hints)
    if "urgency" in hints_lower:
        return True
    return False


def get_window_identity(wid):
    title = run_text_command(["xdotool", "getwindowname", wid], timeout=2.0)
    wm_class_raw = window_property(wid, "WM_CLASS")
    wm_class = ""
    if wm_class_raw:
        parts = [part.strip().strip('"') for part in wm_class_raw.split("=", 1)[-1].split(",")]
        wm_class = " ".join([part for part in parts if part])
    return {
        "wid": wid,
        "title": title,
        "wm_class": wm_class,
        "visible": window_is_visible(wid),
        "normal": window_is_normal(wid),
        "transient": window_is_transient(wid),
        "attention": window_has_attention(wid),
    }


def score_window_candidate(app, info):
    title = normalize_text(info.get("title"))
    lower_title = lower_text(title)
    score = 0
    default_titles = APP_DEFAULT_TITLES.get(app, set())

    if lower_title in default_titles:
        score += 300
    elif app == "wechat" and ("\u5fae\u4fe1" in title or "wechat" in lower_title):
        score += 180
    elif app == "qq" and ("qq" in lower_title or "\u817e\u8bafqq" in lower_title):
        score += 180
    elif title:
        score += 40

    if info.get("normal"):
        score += 120
    if info.get("visible"):
        score += 80
    if info.get("attention"):
        score += 20
    if info.get("transient"):
        score -= 400
    return score


def find_app_window(app):
    best = None
    best_score = -999999
    for wid in search_window_candidates(app):
        info = get_window_identity(wid)
        score = score_window_candidate(app, info)
        if score > best_score:
            best_score = score
            best = info
    return best


def is_default_app_title(app, title):
    safe = lower_text(title)
    if not safe:
        return True
    return safe in APP_DEFAULT_TITLES.get(app, set())


def title_signal_text(app, title):
    safe = normalize_text(title)
    if not safe:
        return ""
    if is_default_app_title(app, safe):
        return ""
    if app == "wechat" and ("\u5fae\u4fe1" in safe or "wechat" in lower_text(safe)):
        return ""
    return safe


def enqueue_notification_event(app, title, body, source, extra=None):
    now = int(time.time() * 1000)
    merge_key = "|".join([normalize_text(app), normalize_text(title), normalize_text(source)])
    now_seconds = time.time()
    with RECENT_EVENT_LOCK:
        RECENT_EVENT_KEYS[merge_key] = now_seconds
        if len(RECENT_EVENT_KEYS) > 512:
            cutoff = now_seconds - 60.0
            for key, seen_at in list(RECENT_EVENT_KEYS.items()):
                if seen_at < cutoff:
                    RECENT_EVENT_KEYS.pop(key, None)
    payload = {
        "ts": now,
        "app": app,
        "app_name": app,
        "title": title,
        "body": body,
        "mode": read_mode_state()["mode"],
        "source": source,
    }
    if extra:
        payload.update(extra)
    QUEUE.push(payload)

    raw_payload = {
        "ts": now,
        "source": source,
        "app": app,
        "title": title,
        "body": body,
    }
    if extra:
        raw_payload.update(extra)
    append_raw_log(raw_payload)


def enqueue_custom_event(payload):
    safe = payload or {}
    app = lower_text(safe.get("app")) or "system"
    if app not in {"wechat", "qq", "clipboard", "stream", "client", "audio", "tool", "system", "link"}:
        app = "system"
    title = clamp_text(safe.get("title"), 512)
    body = clamp_text(safe.get("body"), 4096)
    source = clamp_text(safe.get("source") or "frontend", 256)
    extra = {}
    for key in ("key", "device", "session_id", "session_epoch", "url", "date", "bytes", "mb", "kind"):
        if key in safe:
            extra[key] = json_safe(safe.get(key))
    enqueue_notification_event(app, title, body, source, extra)


def read_awake_state():
    try:
        payload = json.loads(AWAKE_STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None
    try:
        updated_at = float(payload.get("updated_at", 0) or 0)
    except Exception:
        updated_at = 0.0
    return {
        "updated_at": updated_at,
        "any_awake": bool(payload.get("any_awake")),
        "awake_clients": int(payload.get("awake_clients", 0) or 0),
    }


def set_frontend_interaction_at(raw_ts):
    # Measure inactivity using server receipt time, never the browser clock.
    value = time.time()
    with FRONTEND_ACTIVITY_LOCK:
        global LAST_FRONTEND_INTERACTION_AT
        LAST_FRONTEND_INTERACTION_AT = value
    try:
        FRONTEND_ACTIVITY_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "updated_at": time.time(),
            "last_interaction_at": value,
        }
        tmp = FRONTEND_ACTIVITY_STATE_PATH.with_suffix(FRONTEND_ACTIVITY_STATE_PATH.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        tmp.replace(FRONTEND_ACTIVITY_STATE_PATH)
    except Exception:
        pass
    return value


def get_frontend_interaction_at():
    with FRONTEND_ACTIVITY_LOCK:
        return LAST_FRONTEND_INTERACTION_AT


def run_focus_command(command):
    try:
        result = subprocess.run(
            [command],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=8.0,
            check=False,
        )
        focused = result.returncode == 0
        error = "" if focused else (result.stderr.strip() or "focus failed")
        return focused, error
    except Exception as exc:
        return False, str(exc)


def focus_wechat_main_window():
    return run_focus_command(WECHAT_FOCUS_COMMAND)


def monitor_idle_defocus():
    monitor_started_at = time.time()
    idle_segment_active = False
    defocus_done = False
    while True:
        try:
            bridge_state = read_mode_state()
            mode = bridge_state["mode"]
            idle_focus_seconds = int(bridge_state.get("idle_focus_seconds", IDLE_DEFOCUS_SECONDS) or 0)
            now = time.time()
            interaction_at = get_frontend_interaction_at()
            reference_at = interaction_at if interaction_at > 0 else monitor_started_at
            idle_segment_active = mode == "passthrough" and idle_focus_seconds > 0 and (now - reference_at) >= idle_focus_seconds
            if not idle_segment_active:
                defocus_done = False
            if idle_segment_active and not defocus_done:
                ok, error = focus_wechat_main_window()
                if ok:
                    print(
                        f"[notification-bridge] focused wechat main window after idle threshold in passthrough mode ({idle_focus_seconds}s)",
                        flush=True,
                    )
                else:
                    print(
                        f"[notification-bridge] failed to focus wechat main window after idle threshold in passthrough mode ({idle_focus_seconds}s): {error}",
                        flush=True,
                    )
                defocus_done = True
        except Exception as exc:
            print(f"[notification-bridge] idle defocus monitor error: {exc}", flush=True)
        time.sleep(1.0)


def pulse_props_to_text_map(props):
    safe = {}
    for key in (
        "application.name",
        "application.process.binary",
        "application.process.id",
        "media.name",
        "client.name",
        "client.binary",
        "stream.name",
    ):
        safe[key] = normalize_text((props or {}).get(key))
    return safe


def collect_sink_input_metadata(pulse, sink_input):
    props = dict(getattr(sink_input, "proplist", {}) or {})
    props["stream.name"] = normalize_text(getattr(sink_input, "name", ""))
    client_index = getattr(sink_input, "client", None)
    if client_index is not None:
        try:
            client_info = pulse.client_info(client_index)
        except Exception:
            client_info = None
        if client_info is not None:
            client_props = dict(getattr(client_info, "proplist", {}) or {})
            for key, value in client_props.items():
                props.setdefault(key, value)
            props["client.name"] = normalize_text(getattr(client_info, "name", ""))
            props["client.binary"] = normalize_text(client_props.get("application.process.binary"))
    return props


def is_wechat_audio_props(props):
    text_map = pulse_props_to_text_map(props)
    combined = " ".join(lower_text(value) for value in text_map.values() if value)
    if not combined:
        return False
    return any(token in combined for token in WECHAT_HINTS)


def is_rejected_wechat_audio_props(props):
    text_map = pulse_props_to_text_map(props)
    combined = " ".join(lower_text(value) for value in text_map.values() if value)
    if not combined:
        return False
    return any(token in combined for token in WECHAT_AUDIO_REJECT_HINTS)


def get_wechat_audio_signature(props):
    text_map = pulse_props_to_text_map(props)
    signature = "|".join(text_map.get(key, "") for key in sorted(text_map.keys()))
    return signature or "wechat"


def sample_sink_input_peak(pulse, sink_input):
    try:
        sink = pulse.sink_info(sink_input.sink)
        source = getattr(sink, "monitor_source", None)
        if source is None:
            return 0.0
        peak = pulse.get_peak_sample(source, WECHAT_AUDIO_PEAK_SAMPLE_SECONDS, stream_idx=sink_input.index)
        return max(0.0, min(1.0, float(peak or 0.0)))
    except Exception:
        return 0.0


def should_emit_wechat_audio_candidate(candidate, recent_emit_by_signature):
    duration_ms = max(0, int((candidate["ended_at"] - candidate["started_at"]) * 1000))
    if duration_ms < WECHAT_AUDIO_MIN_MS or duration_ms > WECHAT_AUDIO_MAX_MS:
        return False, duration_ms
    if candidate.get("peak", 0.0) < WECHAT_AUDIO_PEAK_THRESHOLD:
        return False, duration_ms
    if is_rejected_wechat_audio_props(candidate.get("props")):
        return False, duration_ms
    signature = candidate.get("signature") or "wechat"
    last_emit_at = recent_emit_by_signature.get(signature, 0.0)
    if last_emit_at and (candidate["ended_at"] - last_emit_at) < WECHAT_AUDIO_DEDUPE_SECONDS:
        return False, duration_ms
    return True, duration_ms


def emit_wechat_audio_candidate(candidate, duration_ms):
    enqueue_notification_event(
        "wechat",
        "\u5fae\u4fe1\u6709\u65b0\u7684\u6d88\u606f\u5f85\u67e5\u770b",
        "\u68c0\u6d4b\u5230\u5fae\u4fe1\u63d0\u793a\u97f3",
        "audio-wechat",
        {
            "pulse_index": candidate.get("index"),
            "pulse_duration_ms": duration_ms,
            "pulse_peak": round(float(candidate.get("peak", 0.0)), 4),
            "pulse_props": json_safe(pulse_props_to_text_map(candidate.get("props"))),
        },
    )


def emit_debug_wechat_audio_event():
    enqueue_notification_event(
        "wechat",
        "\u5fae\u4fe1\u6709\u65b0\u7684\u6d88\u606f\u5f85\u67e5\u770b",
        "\u68c0\u6d4b\u5230\u5fae\u4fe1\u63d0\u793a\u97f3\uff08\u6a21\u62df\uff09",
        "audio-wechat",
        {
            "pulse_index": -1,
            "pulse_duration_ms": 560,
            "pulse_peak": 0.24,
            "pulse_props": {
                "application.name": "WeChat (Simulated)",
                "stream.name": "wechat-message-tone-test",
                "client.name": "notification-bridge-debug",
            },
            "simulated": True,
        },
    )


def finalize_wechat_audio_candidate(candidates, recent_emit_by_signature, index, ended_at=None):
    candidate = candidates.pop(index, None)
    if not candidate:
        return
    candidate["ended_at"] = float(ended_at or time.time())
    should_emit, duration_ms = should_emit_wechat_audio_candidate(candidate, recent_emit_by_signature)
    if not should_emit:
        return
    emit_wechat_audio_candidate(candidate, duration_ms)
    recent_emit_by_signature[candidate.get("signature") or "wechat"] = candidate["ended_at"]


def monitor_wechat_audio_events():
    if not WECHAT_AUDIO_ENABLED:
        print("[notification-bridge] wechat audio detection disabled", flush=True)
        return
    if pulsectl is None:
        print("[notification-bridge] pulsectl unavailable, skipping wechat audio detection", flush=True)
        return

    candidates = {}
    recent_emit_by_signature = {}
    last_error_text = None
    last_error_logged_at = 0.0

    def cleanup_recent(now_ts):
        expired = [
            key
            for key, value in recent_emit_by_signature.items()
            if now_ts - value > max(WECHAT_AUDIO_DEDUPE_SECONDS * 2.0, 30.0)
        ]
        for key in expired:
            recent_emit_by_signature.pop(key, None)

    while True:
        pulse = None
        event_queue = deque()
        try:
            pulse = pulsectl.Pulse("notification-bridge")
            pulse.event_mask_set("sink_input")
            pulse.event_callback = lambda event: event_queue.append((event.t, event.facility, int(event.index)))
            print("[notification-bridge] wechat audio detection connected", flush=True)
            while True:
                pulse.event_listen(timeout=1.0, raise_on_disconnect=False)
                now_ts = time.time()
                cleanup_recent(now_ts)
                expired_candidates = [
                    index
                    for index, candidate in candidates.items()
                    if now_ts - candidate.get("started_at", now_ts) > (WECHAT_AUDIO_MAX_MS / 1000.0 + 0.5)
                ]
                for index in expired_candidates:
                    finalize_wechat_audio_candidate(candidates, recent_emit_by_signature, index, now_ts)

                while event_queue:
                    event_type, facility, index = event_queue.popleft()
                    facility_name = str(facility)
                    event_type_name = str(event_type)
                    if "sink_input" not in facility_name:
                        continue
                    if "remove" in event_type_name:
                        finalize_wechat_audio_candidate(candidates, recent_emit_by_signature, index, time.time())
                        continue
                    try:
                        sink_input = pulse.sink_input_info(index)
                    except Exception:
                        continue
                    props = collect_sink_input_metadata(pulse, sink_input)
                    if not is_wechat_audio_props(props):
                        finalize_wechat_audio_candidate(candidates, recent_emit_by_signature, index, time.time())
                        continue
                    if is_rejected_wechat_audio_props(props):
                        candidates.pop(index, None)
                        continue
                    if bool(getattr(sink_input, "mute", False)) or bool(getattr(sink_input, "corked", False)):
                        finalize_wechat_audio_candidate(candidates, recent_emit_by_signature, index, time.time())
                        continue

                    candidate = candidates.get(index)
                    if candidate is None:
                        candidate = {
                            "index": index,
                            "started_at": time.time(),
                            "peak": 0.0,
                            "props": props,
                            "signature": get_wechat_audio_signature(props),
                        }
                        candidates[index] = candidate
                    else:
                        candidate["props"] = props
                    candidate["peak"] = max(candidate.get("peak", 0.0), sample_sink_input_peak(pulse, sink_input))
        except Exception as exc:
            now_ts = time.time()
            error_text = str(exc)
            if error_text != last_error_text or now_ts - last_error_logged_at >= 30.0:
                print(f"[notification-bridge] wechat audio monitor error: {exc}", flush=True)
                last_error_text = error_text
                last_error_logged_at = now_ts
        finally:
            if pulse is not None:
                try:
                    pulse.close()
                except Exception:
                    pass
        time.sleep(2.0)


def default_mode_state():
    return {
        "mode": "internal",
        "idle_focus_seconds": IDLE_DEFOCUS_SECONDS,
        "auto_split_enabled": AUTO_SPLIT_DEFAULT_ENABLED,
        "adaptive_sleep_enabled": False,
        "adaptive_sleep_idle_seconds": ADAPTIVE_SLEEP_DEFAULT_IDLE_SECONDS,
        "adaptive_sleep_idle_seconds_user_set": False,
        "lan_discovery_enabled": LAN_DISCOVERY_DEFAULT_ENABLED,
        "lan_broadcast_name": LAN_DISCOVERY_DEFAULT_NAME,
    }


def _read_mode_state_unlocked():
    state = default_mode_state()
    if not MODE_STATE_PATH.exists():
        return state
    try:
        payload = json.loads(MODE_STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return state
    state["sleep_settings_updated_at"] = payload.get("sleep_settings_updated_at", 0)
    state["mode"] = sanitize_mode(payload.get("mode", state["mode"]))
    state["idle_focus_seconds"] = sanitize_idle_focus_seconds(payload.get("idle_focus_seconds", state["idle_focus_seconds"]))
    state["auto_split_enabled"] = sanitize_bool(
        payload.get("auto_split_enabled", state["auto_split_enabled"]),
        state["auto_split_enabled"],
    )
    state["adaptive_sleep_enabled"] = sanitize_bool(
        payload.get("adaptive_sleep_enabled", state["adaptive_sleep_enabled"]),
        state["adaptive_sleep_enabled"],
    )
    state["adaptive_sleep_idle_seconds_user_set"] = bool(
        payload.get("adaptive_sleep_idle_seconds_user_set", state["adaptive_sleep_idle_seconds_user_set"])
    )
    state["adaptive_sleep_idle_seconds"] = sanitize_adaptive_sleep_idle_seconds(
        payload.get("adaptive_sleep_idle_seconds", state["adaptive_sleep_idle_seconds"])
    )
    state["lan_discovery_enabled"] = parse_bool(
        payload.get("lan_discovery_enabled"),
        state["lan_discovery_enabled"],
    )
    state["lan_broadcast_name"] = sanitize_broadcast_name(
        payload.get("lan_broadcast_name"),
        state["lan_broadcast_name"],
    )
    if (
        not state["adaptive_sleep_idle_seconds_user_set"]
        and state["adaptive_sleep_idle_seconds"] == 60
        and ADAPTIVE_SLEEP_DEFAULT_IDLE_SECONDS == 3600
    ):
        state["adaptive_sleep_idle_seconds"] = ADAPTIVE_SLEEP_DEFAULT_IDLE_SECONDS
    return state


def read_mode_state():
    with MODE_LOCK:
        return dict(_read_mode_state_unlocked())


def write_mode_state(
    mode=None,
    idle_focus_seconds=None,
    auto_split_enabled=None,
    adaptive_sleep_enabled=None,
    adaptive_sleep_idle_seconds=None,
    lan_discovery_enabled=None,
    lan_broadcast_name=None,
):
    with MODE_LOCK:
        state = _read_mode_state_unlocked()
        if mode is not None:
            state["mode"] = sanitize_mode(mode)
        if idle_focus_seconds is not None:
            state["idle_focus_seconds"] = sanitize_idle_focus_seconds(idle_focus_seconds)
        if auto_split_enabled is not None:
            state["auto_split_enabled"] = sanitize_bool(auto_split_enabled, state["auto_split_enabled"])
        if adaptive_sleep_enabled is not None:
            state["adaptive_sleep_enabled"] = sanitize_bool(adaptive_sleep_enabled, state["adaptive_sleep_enabled"])
        if adaptive_sleep_idle_seconds is not None:
            state["adaptive_sleep_idle_seconds"] = sanitize_adaptive_sleep_idle_seconds(adaptive_sleep_idle_seconds)
            state["adaptive_sleep_idle_seconds_user_set"] = True
        if lan_discovery_enabled is not None:
            state["lan_discovery_enabled"] = parse_bool(
                lan_discovery_enabled,
                state["lan_discovery_enabled"],
            )
        if lan_broadcast_name is not None:
            state["lan_broadcast_name"] = sanitize_broadcast_name(
                lan_broadcast_name,
                state["lan_broadcast_name"],
            )
        if adaptive_sleep_enabled is not None or adaptive_sleep_idle_seconds is not None:
            state["sleep_settings_updated_at"] = time.time()
        MODE_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = MODE_STATE_PATH.with_suffix(MODE_STATE_PATH.suffix + ".tmp")
        tmp.write_text(json.dumps(state), encoding="utf-8")
        tmp.replace(MODE_STATE_PATH)
    return dict(state)


def build_dunstrc(mode):
    base = ""
    try:
        base = DUNST_DEFAULT_PATH.read_text(encoding="utf-8")
    except Exception:
        base = ""
    if not base.endswith("\n"):
        base += "\n"
    # Keep native desktop notifications intact even when browser passthrough is enabled.
    # The bridge should observe and supplement notifications, not suppress the original
    # container-side reminder path. This restores the pre-bridge QQ notification behavior.
    return base


def apply_notification_mode(mode):
    text = build_dunstrc(mode)
    try:
        DUNST_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        DUNST_CONFIG_PATH.write_text(text, encoding="utf-8")
    except Exception:
        return
    subprocess.run(["pkill", "-HUP", "-x", "dunst"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def current_state_payload():
    state = read_mode_state()
    response = {
        "ok": True,
        "mode": state["mode"],
        "idle_focus_seconds": int(state.get("idle_focus_seconds", IDLE_DEFOCUS_SECONDS) or 0),
        "auto_split_enabled": bool(state.get("auto_split_enabled", AUTO_SPLIT_DEFAULT_ENABLED)),
        "adaptive_sleep_enabled": bool(state.get("adaptive_sleep_enabled", False)),
        "adaptive_sleep_idle_seconds": sanitize_adaptive_sleep_idle_seconds(
            state.get("adaptive_sleep_idle_seconds", ADAPTIVE_SLEEP_DEFAULT_IDLE_SECONDS)
        ),
        "lan_discovery_enabled": bool(state.get("lan_discovery_enabled", False)),
        "lan_broadcast_name": sanitize_broadcast_name(
            state.get("lan_broadcast_name"),
            LAN_DISCOVERY_DEFAULT_NAME,
        ),
    }
    try:
        status = json.loads(LAN_DISCOVERY_STATUS_PATH.read_text(encoding="utf-8"))
    except Exception:
        status = {}
    response["lan_discovery_running"] = bool(status.get("running", False))
    response["lan_discovery_address"] = str(status.get("address", "") or "")
    response["lan_discovery_error"] = str(status.get("error", "") or "")
    return response


def current_discovery_identity_payload():
    return build_identity_payload(read_mode_state())


def append_raw_log(payload):
    global RAW_LOG_DISABLED
    if RAW_LOG_DISABLED:
        return
    line = json.dumps(payload, ensure_ascii=False) + "\n"
    with RAW_LOG_LOCK:
        if RAW_LOG_DISABLED:
            return
        try:
            RAW_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
            trim_raw_log_unlocked(line.encode("utf-8"))
            with RAW_LOG_PATH.open("a", encoding="utf-8") as handle:
                handle.write(line)
        except Exception as exc:
            RAW_LOG_DISABLED = True
            print(f"[notification-bridge] raw log disabled: {exc}", flush=True)


class NotificationBridgeHandler(BaseHTTPRequestHandler):
    server_version = "NotificationBridge/1.0"

    def log_message(self, fmt, *args):
        parsed = urlparse(getattr(self, "path", "") or "")
        if parsed.path in {"/health", "/pull", "/activity", "/active-app", "/state", "/discovery"}:
            return
        print(
            "%s - - [%s] %s"
            % (self.client_address[0], self.log_date_time_string(), fmt % args),
            flush=True,
        )

    def _send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return b""
        return self.rfile.read(min(length, 32768))

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send_json(200, {"ok": True})
            return
        if parsed.path == "/active-app":
            self._send_json(200, get_active_app_payload())
            return
        if parsed.path == "/pull":
            query = parse_qs(parsed.query or "")
            try:
                since_id = int((query.get("since") or ["0"])[0])
            except Exception:
                since_id = 0
            if since_id < 0:
                since_id = 0
            events, latest_id, reset_required = QUEUE.pull(since_id)
            self._send_json(200, {"ok": True, "events": events, "latest_id": latest_id, "reset_required": reset_required})
            return
        if parsed.path == "/state":
            self._send_json(200, current_state_payload())
            return
        if parsed.path == "/discovery":
            self._send_json(200, current_discovery_identity_payload())
            return
        self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        body = self._read_body()
        content_type = lower_text(self.headers.get("Content-Type"))
        payload = {}
        if "application/json" in content_type:
            try:
                payload = json.loads(body.decode("utf-8", errors="replace"))
            except Exception:
                payload = {}
        else:
            data = parse_qs(body.decode("utf-8", errors="replace"))
            payload = {key: values[0] for key, values in data.items() if values}

        if parsed.path == "/focus":
            app = lower_text(payload.get("app"))
            if app == "wechat":
                command = WECHAT_FOCUS_COMMAND
            elif app == "qq":
                command = QQ_FOCUS_COMMAND
            else:
                self._send_json(400, {"ok": False, "app": app, "focused": False, "error": "invalid app"})
                return

            try:
                focused, error = run_focus_command(command)
                self._send_json(200, {"ok": focused, "app": app, "focused": focused, "error": error})
            except Exception as exc:
                self._send_json(500, {"ok": False, "app": app, "focused": False, "error": str(exc)})
            return

        if parsed.path == "/activity":
            ts_value = payload.get("ts") or payload.get("interaction_at") or payload.get("last_interaction_at")
            recorded_at = set_frontend_interaction_at(ts_value or time.time())
            self._send_json(200, {"ok": True, "interaction_at": recorded_at})
            return

        if parsed.path == "/event":
            enqueue_custom_event(payload)
            self._send_json(200, {"ok": True})
            return

        if parsed.path == "/debug/wechat-audio-test":
            emit_debug_wechat_audio_event()
            self._send_json(200, {"ok": True, "app": "wechat", "source": "audio-wechat", "simulated": True})
            return

        if parsed.path != "/state":
            self._send_json(404, {"ok": False, "error": "not found"})
            return

        if "lan_broadcast_name" in payload and not is_valid_broadcast_name(payload.get("lan_broadcast_name")):
            self._send_json(
                400,
                {
                    "ok": False,
                    "error": "invalid broadcast name",
                    "allowed": "A-Z, 0-9, underscore and hyphen; 1-32 characters",
                },
            )
            return

        updated_state = None
        if "mode" in payload:
            updated_state = write_mode_state(mode=payload.get("mode"))
            apply_notification_mode(updated_state["mode"])
        if "idle_focus_seconds" in payload:
            updated_state = write_mode_state(idle_focus_seconds=payload.get("idle_focus_seconds"))
        if "auto_split_enabled" in payload:
            updated_state = write_mode_state(auto_split_enabled=payload.get("auto_split_enabled"))
        if "adaptive_sleep_enabled" in payload:
            updated_state = write_mode_state(adaptive_sleep_enabled=payload.get("adaptive_sleep_enabled"))
        if "adaptive_sleep_idle_seconds" in payload:
            updated_state = write_mode_state(adaptive_sleep_idle_seconds=payload.get("adaptive_sleep_idle_seconds"))
        if "lan_discovery_enabled" in payload:
            updated_state = write_mode_state(lan_discovery_enabled=payload.get("lan_discovery_enabled"))
        if "lan_broadcast_name" in payload:
            updated_state = write_mode_state(lan_broadcast_name=payload.get("lan_broadcast_name"))

        response = current_state_payload()
        if updated_state is not None:
            response["mode"] = updated_state["mode"]
            response["idle_focus_seconds"] = int(updated_state.get("idle_focus_seconds", IDLE_DEFOCUS_SECONDS) or 0)
            response["auto_split_enabled"] = bool(
                updated_state.get("auto_split_enabled", AUTO_SPLIT_DEFAULT_ENABLED)
            )
            response["adaptive_sleep_enabled"] = bool(updated_state.get("adaptive_sleep_enabled", False))
            response["adaptive_sleep_idle_seconds"] = sanitize_adaptive_sleep_idle_seconds(
                updated_state.get("adaptive_sleep_idle_seconds", ADAPTIVE_SLEEP_DEFAULT_IDLE_SECONDS)
            )
            response["lan_discovery_enabled"] = bool(updated_state.get("lan_discovery_enabled", False))
            response["lan_broadcast_name"] = sanitize_broadcast_name(
                updated_state.get("lan_broadcast_name"),
                LAN_DISCOVERY_DEFAULT_NAME,
            )
        self._send_json(200, response)


STRING_RE = re.compile(r'^\s*string\s+"(.*)"\s*$')
UINT_RE = re.compile(r'^\s*uint32\s+(\d+)\s*$')


def parse_dbus_events():
    command = ["dbus-monitor", "--session", "interface='org.freedesktop.Notifications',member='Notify'"]
    while True:
        process = None
        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
            current = None
            for raw_line in process.stdout:
                line = raw_line.rstrip("\n")
                if "member=Notify" in line:
                    current = {"strings": [], "seen_uint": False}
                    continue
                if current is None:
                    continue
                string_match = STRING_RE.match(line)
                if string_match:
                    current["strings"].append(string_match.group(1))
                    if len(current["strings"]) >= 4:
                        app_name = current["strings"][0]
                        icon_name = current["strings"][1]
                        summary = current["strings"][2]
                        body = current["strings"][3]
                        app = detect_app(app_name, summary, body, icon_name)
                        enqueue_notification_event(
                            app,
                            summary,
                            body,
                            "dbus-notify",
                            {
                                "app_name": app_name,
                                "icon_name": icon_name,
                                "summary": summary,
                                "strings": list(current["strings"]),
                            },
                        )
                        current = None
                    continue
                if UINT_RE.match(line):
                    current["seen_uint"] = True
                    continue
                if not line.strip():
                    current = None
            process.wait(timeout=1.0)
        except Exception as exc:
            print(f"[notification-bridge] dbus monitor error: {exc}", flush=True)
        finally:
            if process and process.poll() is None:
                process.kill()
        time.sleep(2.0)


def poll_fallback_window_events():
    state = {
        "wechat": {"last_attention": False, "last_title_signal": "", "last_emitted_key": "", "last_emit_at": 0},
        "qq": {"last_attention": False, "last_title_signal": "", "last_emitted_key": "", "last_emit_at": 0},
    }
    while True:
        try:
            active_app = get_active_app_payload().get("app", "other")
            now = int(time.time() * 1000)
            for app in ("wechat", "qq"):
                info = find_app_window(app)
                app_state = state[app]
                if not info:
                    app_state["last_attention"] = False
                    app_state["last_title_signal"] = ""
                    continue

                if active_app == app and app != "wechat":
                    app_state["last_attention"] = bool(info.get("attention"))
                    app_state["last_title_signal"] = title_signal_text(app, info.get("title"))
                    continue

                attention = bool(info.get("attention"))
                current_title_signal = title_signal_text(app, info.get("title"))

                if attention and not app_state["last_attention"]:
                    body = current_title_signal or "检测到窗口请求提醒"
                    key = f"attention:{info.get('wid')}:{body}"
                    if key != app_state["last_emitted_key"] or now - app_state["last_emit_at"] > 15000:
                        enqueue_notification_event(
                            app,
                            "微信有新的消息待查看" if app == "wechat" else "QQ 新消息",
                            body,
                            "window-attention",
                            {
                                "window_id": info.get("wid"),
                                "window_title": info.get("title"),
                                "wm_class": info.get("wm_class"),
                                "attention": True,
                            },
                        )
                        app_state["last_emitted_key"] = key
                        app_state["last_emit_at"] = now

                if current_title_signal and current_title_signal != app_state["last_title_signal"]:
                    key = f"title:{info.get('wid')}:{current_title_signal}"
                    if key != app_state["last_emitted_key"] or now - app_state["last_emit_at"] > 15000:
                        enqueue_notification_event(
                            app,
                            "微信有新的消息待查看" if app == "wechat" else "QQ 新消息",
                            current_title_signal,
                            "window-title",
                            {
                                "window_id": info.get("wid"),
                                "window_title": info.get("title"),
                                "wm_class": info.get("wm_class"),
                                "attention": attention,
                            },
                        )
                        app_state["last_emitted_key"] = key
                        app_state["last_emit_at"] = now

                app_state["last_attention"] = attention
                app_state["last_title_signal"] = current_title_signal
        except Exception as exc:
            print(f"[notification-bridge] fallback poll error: {exc}", flush=True)
        time.sleep(FALLBACK_POLL_MS / 1000.0)


def main():
    print(f"[notification-bridge] starting on {HOST}:{PORT}", flush=True)
    mode = read_mode_state()["mode"]
    apply_notification_mode(mode)
    idle_thread = threading.Thread(target=monitor_idle_defocus, daemon=True)
    idle_thread.start()
    monitor_thread = threading.Thread(target=parse_dbus_events, daemon=True)
    monitor_thread.start()
    fallback_thread = threading.Thread(target=poll_fallback_window_events, daemon=True)
    fallback_thread.start()
    audio_thread = threading.Thread(target=monitor_wechat_audio_events, daemon=True)
    audio_thread.start()
    server = ThreadingHTTPServer((HOST, PORT), NotificationBridgeHandler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
