#!/usr/bin/env python3
import json
import os
import pathlib
import re


DEFAULT_BROADCAST_NAME = "AXISNSBOX-000"
SERVICE_TYPE = "_axisnsbox._tcp.local."
SERVICE_ID = "wechat-selkies"
NAME_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9_-]{0,31}$")


def parse_bool(value, default=False):
    if value is None:
        return bool(default)
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return bool(default)


def is_valid_broadcast_name(value):
    return bool(NAME_PATTERN.fullmatch(str(value or "").strip().upper()))


def sanitize_broadcast_name(value, fallback=DEFAULT_BROADCAST_NAME):
    candidate = str(value or "").strip().upper()
    if is_valid_broadcast_name(candidate):
        return candidate
    fallback_candidate = str(fallback or DEFAULT_BROADCAST_NAME).strip().upper()
    if is_valid_broadcast_name(fallback_candidate):
        return fallback_candidate
    return DEFAULT_BROADCAST_NAME


def parse_port(value, default):
    try:
        port = int(str(value).strip())
    except (TypeError, ValueError):
        return int(default)
    if 1 <= port <= 65535:
        return port
    return int(default)


def default_discovery_state():
    return {
        "lan_discovery_enabled": parse_bool(
            os.getenv("SELKIES_LAN_DISCOVERY_DEFAULT_ENABLED"),
            False,
        ),
        "lan_broadcast_name": sanitize_broadcast_name(
            os.getenv("SELKIES_LAN_DISCOVERY_DEFAULT_NAME"),
            DEFAULT_BROADCAST_NAME,
        ),
    }


def read_discovery_state(path):
    state = default_discovery_state()
    config_path = pathlib.Path(path)
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, ValueError, TypeError):
        return state
    if not isinstance(payload, dict):
        return state
    state["lan_discovery_enabled"] = parse_bool(
        payload.get("lan_discovery_enabled"),
        state["lan_discovery_enabled"],
    )
    state["lan_broadcast_name"] = sanitize_broadcast_name(
        payload.get("lan_broadcast_name"),
        state["lan_broadcast_name"],
    )
    return state


def normalize_subfolder(value):
    path = str(value or "/").strip()
    if not path:
        return "/"
    if not path.startswith("/"):
        path = "/" + path
    if not path.endswith("/"):
        path += "/"
    return path


def build_identity_payload(state):
    http_port = parse_port(
        os.getenv("SELKIES_LAN_ADVERTISE_HTTP_PORT", os.getenv("CUSTOM_PORT", "3000")),
        3000,
    )
    https_port = parse_port(
        os.getenv("SELKIES_LAN_ADVERTISE_HTTPS_PORT", os.getenv("CUSTOM_HTTPS_PORT", "3001")),
        3001,
    )
    return {
        "ok": True,
        "service": SERVICE_ID,
        "service_type": SERVICE_TYPE,
        "name": sanitize_broadcast_name(state.get("lan_broadcast_name")),
        "enabled": parse_bool(state.get("lan_discovery_enabled"), False),
        "scheme": "https",
        "path": normalize_subfolder(os.getenv("SUBFOLDER", "/")),
        "http_port": http_port,
        "https_port": https_port,
    }
